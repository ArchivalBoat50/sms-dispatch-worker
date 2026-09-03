# sms-dispatch-worker

## What this is and why it exists

When a burst pipe wakes someone at 2am, they call a plumber. If the phone rings out to voicemail, they hang up and call the next name on the list, and that job is gone. A voice agent solves the first half of that problem — the phone gets answered, the customer is calmed down, the address and the nature of the fault get captured. But answering is not dispatching. The job still has to reach a technician who is asleep, and somebody has to establish that a human being actually saw it and is getting in the van. That last step is where the value is, and it is the step a call-answering service or a no-code automation does not close: they can send a notification, but they cannot tell you whether anyone picked it up, and they will not wake the owner when nobody does. This service is the closing half. It takes the structured job the voice agent produced, texts it to the on-call technician with a one-tap accept link, and then watches the clock: if nobody accepts within five minutes it texts the second technician, and if nobody has accepted at ten minutes it places an actual voice call to the owner's mobile. The ladder is the product. Everything else here is plumbing around it.

Escalation is the part that is genuinely hard to buy off the shelf, because it requires durable state per job (who was notified, at what level, when), a clock that keeps running after the originating request is long gone, and a claim step that is safe when two people tap at once. Those three requirements are what push this out of a workflow builder and into code.

## Architecture

Components:

- **Vapi voice agent** (external) — answers the call, collects the fields, and invokes one of two tools: `dispatch_emergency` or `book_appointment`. Both tools point at `POST /dispatch`.
- **Cloudflare Worker** (`src/index.js`) — a single ES-module Worker exposing four routes plus a `scheduled` handler.
- **D1** (`schema.sql`) — one `jobs` table. It is both the job store and the escalation state machine; there is no other queue.
- **Twilio** — outbound SMS (`Messages`) and outbound voice with inline TwiML (`Calls`).
- **Cron trigger** — `* * * * *`, one invocation per minute, which drives the ladder.

```
                  caller (2am, burst pipe)
                            |
                            v
                    Vapi voice agent
                            |  tool call: dispatch_emergency / book_appointment
                            |  header: x-dispatch-secret
                            v
     +--------------------------------------------------+
     |            Worker  POST /dispatch                 |
     |  1. constant-time compare of shared secret        |
     |  2. dedupe on Vapi's tool_call_id                 |
     |  3. refuse if fee_accepted !== true (emergency)   |
     |  4. INSERT job  status=new  escalation_level=0    |
     |  5. return the sentence the agent speaks          |
     +--------------------------------------------------+
                    |                        |
        ctx.waitUntil (non-blocking)     response returns
                    v                    immediately, agent
              Twilio SMS -> TECH 1       keeps talking
              body includes: /a/<token>
                            |
                            |  tech taps the link
                            v
     +--------------------------------------------------+
     |            Worker  GET /a/:token                  |
     |  look up job by accept_token                      |
     |  if already claimed -> "Already claimed" page     |
     |  else UPDATE status='claimed', claimed_by, at     |
     |  SMS the caller "on the way"                      |
     +--------------------------------------------------+

     ----------------------------------------------------
     cron, every minute:  Worker scheduled() -> escalate()
       SELECT jobs WHERE type='emergency'
                     AND status='new'
                     AND escalation_level < 2
                     AND created_at < now-5min
                   ORDER BY created_at ASC LIMIT 25

         level 0 and age >=  5 min  -> SMS  TECH 2, set level=1
         level 1 and age >= 10 min  -> CALL OWNER (TwiML "Say")
                                     + SMS OWNER, set level=2
         level 2                    -> ladder ends
     ----------------------------------------------------

     GET /jobs?key=SECRET   dark job board, 100 most recent
     GET /health            {"ok":true}
```

Booking (non-emergency) jobs take a shortcut: they are written with `status='booked'` and texted to technician 1 as a plain job card with no accept link. Because the cron query filters on `status='new'`, bookings never enter the ladder.

## Key design decisions

### A one-minute cron, not a sleep and not a per-job timer

The ladder is implemented as a stateless sweep. Every minute the Worker runs one indexed query for emergency jobs that are unclaimed, below level 2, and older than five minutes, and advances at most 25 of them one rung. There is no timer object per job and nothing is held in memory between invocations.

The reason is that all the timing state lives in D1 (`created_at`, `escalation_level`, `status`), so the sweep is idempotent and recoverable: a missed cron tick, a deploy mid-ladder, or a Worker restart costs at most a minute of latency, not a lost job, because the next tick recomputes what is due from the row itself. A `setTimeout`-style sleep cannot survive the end of a request in this environment at all. Durable Object alarms would give per-job precision, but they add a second stateful primitive and a per-job object to reason about, for a business where a technician being woken at 5:00 versus 5:59 is not a meaningful difference. `[CONFIRM]` — the comparison to Durable Object alarms is a design rationale, not something the code demonstrates; be ready to defend it as a judgement call rather than a measured tradeoff.

Consequences worth stating out loud: the granularity is one minute, so the true escalation delay is 5 to 6 minutes, not exactly 5. `[CONFIRM]` — Cloudflare cron triggers are also best-effort rather than guaranteed to fire on the exact minute, which would widen that window further; this is a platform behaviour claim, not something the repository proves. The `LIMIT 25` also caps the system at 25 escalation steps per minute, which is far above the load a single trades business generates but is a real ceiling.

### The accept action is a tokenised GET, not an SMS reply

Each job gets a random `accept_token` stored in D1 (`UNIQUE`), and the technician's SMS ends with `Accept: <base>/a/<token>`. Tapping it hits `GET /a/:token`, which claims the job and returns a rendered job card with the caller's name, number, address and the fault description.

The practical argument is that a tapped link is unambiguous and needs no parsing: an inbound-SMS design would require a Twilio webhook, keyword matching against whatever the technician actually types at 2am ("yep", "ok mate", "on it"), and a way to bind a reply to a specific job when two are open at once. The link carries the job identity in the URL, so there is nothing to disambiguate. It also gives somewhere to put the full job card, which will not fit comfortably in a reply-based flow. `[CONFIRM]` — this rationale is inferred from the shape of the code; there is no inbound SMS handler anywhere in the repository, so the alternative was never built and compared.

The cost of this choice is that the token is a bearer credential sitting in an SMS. It is 8 random bytes generated with `crypto.getRandomValues`, hex-ish base36-encoded and then truncated to 12 characters, which means only the first 6 bytes survive — roughly 48 bits of entropy. That is not brute-forceable in any realistic sense, but there is no rate limiting on `/a/`, no expiry on the token, and anyone who obtains the link (a forwarded message, a shoulder-surfed lock screen) can claim the job and cause the customer to be texted that help is on the way.

### Double-claiming is NOT prevented at the database level

This is the honest answer and the most important thing to be able to say about this code. The claim path is a read, a check, and then an unconditional write:

```js
const job = await env.DB.prepare("SELECT * FROM jobs WHERE accept_token = ?").bind(tok).first();
if (!job) return html(page("Not found", "That link isn't valid."), 404);

if (job.status === "claimed") {
  return html(page("Already claimed", `${job.claimed_by || "Someone"} took this one.`));
}
...
await env.DB.prepare("UPDATE jobs SET status='claimed', claimed_by=?, claimed_at=? WHERE id=?")
  .bind(who, Date.now(), job.id)
  .run();
```

The `UPDATE` has no `AND status='new'` guard, so the guarantee is a time-of-check-to-time-of-use check, not an atomic one. Sequentially it behaves correctly, and the test suite proves that: a second tap on an already-claimed job renders "Already claimed" and sends no further SMS. But if two technicians tap within the same window, both reads can return `status='new'`, both checks pass, both writes succeed, the last writer wins on `claimed_by`, and the customer receives two "on the way" texts from two different people.

The fix is a conditional update — `UPDATE jobs SET status='claimed', ... WHERE id=? AND status='new'` — and then branching on whether the write reported a changed row, which turns the check and the write into one atomic operation. This has not been done. It is listed under limitations below.

A second, related gap: all three recipients (technician 1, technician 2, the owner) receive the **same** accept token, because `techSMS(job, base)` is reused verbatim at every rung. The system therefore cannot tell who actually tapped. `claimed_by` is derived from the job's current escalation level, not from the person:

```js
const who = job.escalation_level >= 2 ? "Owner" : job.escalation_level === 1 ? "Second tech" : "On-call tech";
```

So if technician 1 finally taps their original link after the ladder has already escalated to level 1, the job is recorded as claimed by "Second tech". Per-recipient tokens would fix this.

### Idempotency on Vapi's tool call id

Before inserting, `/dispatch` looks up `tool_call_id` and, if a row already exists, replays the stored `result` string rather than dispatching again. `[CONFIRM]` — the code comment states that Vapi retries on timeout; that is an assumption about an external system's behaviour, not something this repository verifies.

Notably, the schema backs this with a real constraint rather than relying on the read alone:

```sql
CREATE UNIQUE INDEX idx_jobs_toolcall ON jobs(tool_call_id) WHERE tool_call_id IS NOT NULL;
```

So unlike the claim path, concurrent retries cannot both insert — the second write violates the index. `[CONFIRM]` — what the Worker actually returns in that case is untested; the insert is not wrapped in a try/catch, so the likely outcome is an unhandled rejection and a 500 back to Vapi rather than a graceful replay of the first result.

The `fee_accepted !== true` gate sits in the same loop and is deliberately server-side: even if the model calls the tool without the caller having agreed to the callout fee, nothing is written and nothing is texted. Business rules that cost money are enforced in the Worker, not in the prompt.

### A shared-secret header on /dispatch

`POST /dispatch` requires an `x-dispatch-secret` header matching `env.DISPATCH_SECRET`, compared with a hand-written constant-time `safeEqual` rather than `===`. The endpoint is a public URL that causes real SMS and real voice calls to be sent, so an unauthenticated version would be a free spam relay and a direct Twilio bill. `[CONFIRM]` — a shared header was likely chosen because it is what the Vapi tool configuration supports natively (the original deploy notes mention falling back to a Custom Header credential if the inline header is rejected); Twilio-style HMAC request signing would be stronger but Vapi is the caller here, not Twilio.

The constant-time compare is defensible in principle. In practice `safeEqual` returns early on a length mismatch, so it leaks the secret's length, and the value it protects is a static secret rather than a per-request signature.

### The job board exists as a sales artifact

`GET /jobs?key=SECRET` renders the 100 most recent jobs as a dark table with status, type, suburb, caller, issue and age. The original project notes are explicit about why: it is the screen you show a prospect on a Zoom call. That is worth stating plainly rather than dressing up as an ops dashboard, because it explains its shape — it is read-only, has no filters, no pagination, no per-technician view, no actions, and colour-codes status for legibility at a glance on a shared screen. A dispatcher's tool would look different. A demo screen that makes an abstract escalation ladder visible to a plumber in ninety seconds looks like this.

Two honest caveats. It reuses `DISPATCH_SECRET` as a URL query parameter, so the same credential that can dispatch jobs also views them, and it travels in a place that tends to end up in logs and browser history. And nothing on the page is HTML-escaped — `caller_name`, `issue`, `suburb` and `address` are interpolated straight into the markup, and those values originate from a voice transcription of an unknown caller, which is a stored XSS path.

### What happens if Twilio fails mid-ladder

Not much, and that is the weakest part of the system. The `twilio()` helper checks `r.ok`, logs to `console.error` on failure, and returns a boolean — and no caller ever reads that boolean.

In `escalate()`, the database is advanced regardless of the outcome:

```js
await sms(env, env.TECH_2_NUMBER, "NO RESPONSE FROM TECH 1\n" + techSMS(job, base));
await env.DB.prepare("UPDATE jobs SET escalation_level=1 WHERE id=?").bind(job.id).run();
```

If that SMS fails, the job is still marked level 1, so it will never be retried at that rung. It will still climb to the owner at ten minutes, which is a genuine safety net for the level-1 failure — but if the owner's voice call also fails, the job goes to level 2 and the ladder simply ends with nobody having been reached and no alert anywhere except a `console.error` line in the Worker logs.

The initial dispatch SMS is different, and better by accident: it runs inside `ctx.waitUntil` so the voice agent is never blocked on Twilio, and if it fails the job stays `status='new'`, so the five-minute sweep picks it up and technician 2 gets it. The failure degrades into an escalation rather than a dropped job.

There is no retry, no backoff, no dead-letter, and no alert on repeated Twilio failure. For a system whose entire purpose is guaranteeing a human was reached, that is the first thing to fix after the claim race.

## Measured results

None. This was built and tested but never run against live traffic — no live call has been placed through it, so there are no response times, acceptance rates, escalation rates, or conversion figures to report, and none are claimed. The only evidence of correctness in this repository is the test suite described below, which exercises the routes, the ladder and the state transitions against a real SQLite database with the network stubbed.

## Stack

- Cloudflare Workers (JavaScript, ES module syntax, `fetch` + `scheduled` handlers)
- Cloudflare D1 (SQLite) — single `jobs` table, three indexes
- Cloudflare Cron Triggers — `* * * * *`
- Twilio REST API — `Messages` for SMS, `Calls` with inline TwiML for the owner escalation
- Vapi — voice agent, calls in over HTTP tool calls
- Wrangler for local dev, migrations, secrets and deploy
- Node's built-in `node:sqlite` for the test harness (no test framework, no dependencies)

## Running it

### Local

```bash
npm install -g wrangler
wrangler login

# database
wrangler d1 create dispatch
#   paste the returned database_id into wrangler.toml
wrangler d1 execute dispatch --local --file=schema.sql

# secrets (local dev uses a .dev.vars file; production uses wrangler secret put)
#   DISPATCH_SECRET       must match the x-dispatch-secret header Vapi sends
#   TWILIO_ACCOUNT_SID
#   TWILIO_AUTH_TOKEN

wrangler dev
```

`wrangler.toml` ships with placeholder E.164 numbers for `TECH_1_NUMBER`, `TECH_2_NUMBER`, `OWNER_NUMBER` and `TWILIO_FROM`. Replace them with real numbers before anything will reach a phone; while testing the ladder end to end, putting your own mobile in all three lets you receive every rung yourself.

Note that `schema.sql` begins with `DROP TABLE IF EXISTS jobs`, so re-running it destroys existing jobs. That is fine for a dev database and dangerous against production.

Deploying:

```bash
wrangler deploy
# copy the printed URL into PUBLIC_BASE_URL in wrangler.toml, then:
wrangler deploy
```

The second deploy matters because `escalate()` builds accept links from `env.PUBLIC_BASE_URL` (a cron invocation has no incoming request to read an origin from), whereas `handleDispatch` derives the base from `new URL(req.url).origin`. If `PUBLIC_BASE_URL` is wrong or unset, the first SMS will have a working link and every escalation SMS will not.

Smoke test against a deployed instance without placing a call:

```bash
curl -X POST https://<your-worker>.workers.dev/dispatch \
  -H "x-dispatch-secret: YOUR_SECRET" \
  -H "content-type: application/json" \
  -d '{"message":{"toolCalls":[{"id":"test-1","function":{"name":"dispatch_emergency","arguments":{"caller_name":"Dave","callback_number":"0412345678","address":"12 Bourke St","suburb":"Woolloomooloo","issue":"burst pipe under the sink","severity":"active_damage","fee_accepted":true}}}]}}'
```

### Test suite

```bash
node --experimental-sqlite test.mjs
```

`test.mjs` needs no network, no wrangler, and no dependencies. It runs an in-memory SQLite database behind a small adapter shaped like D1's `prepare / bind / first / all / run` API, loads `schema.sql` into it, imports the Worker module directly, and replaces `globalThis.fetch` with a stub that records every outbound Twilio request instead of sending it. A fake `ctx.waitUntil` collects the backgrounded promises so the tests can await them deterministically.

It covers, in order: rejection of a wrong and of a missing secret; a full emergency dispatch including the exact SMS body format and the accept link; retry dedupe on `tool_call_id`; refusal to dispatch when `fee_accepted` is false; the booking path; accepting a job, the customer notification, and a second tap being rejected; an unknown token returning 404; the five-minute escalation to technician 2 and the ten-minute voice call plus SMS to the owner; the ladder terminating after the owner; a claimed job never escalating; job-board auth; and Australian mobile normalisation to E.164. It prints a pass/fail line per assertion and exits non-zero on any failure.

The ladder tests work by writing an older `created_at` directly into the database and then invoking `worker.scheduled()` by hand, which is why the whole ladder can be verified in milliseconds rather than eleven minutes.

`node:sqlite` requires a recent Node (Node 22 or newer) and the `--experimental-sqlite` flag. `[CONFIRM]` — the exact minimum version is not pinned anywhere in the repository; there is no `package.json` or `.nvmrc`.

## Known limitations and what I would do next

In rough priority order:

1. **The claim is not atomic.** Make it a conditional `UPDATE ... WHERE id = ? AND status = 'new'` and branch on the reported row count. Everything about the correctness of this system rests on that one write.
2. **Every rung shares one accept token,** so `claimed_by` records a rung rather than a person. Issue a distinct token per notification and record which one was redeemed.
3. **Twilio failures are logged and ignored.** Check the return value before advancing `escalation_level`, retry with backoff, and raise an alert if the owner cannot be reached at all — the one outcome the system exists to prevent.
4. **No output escaping.** `caller_name`, `issue`, `address` and `suburb` come from a voice transcription and are interpolated raw into the job board and the accept page (stored XSS), and into the TwiML `<Say>` for the owner's call, where a bare `&` or `<` in a name would break the XML and the escalation call would fail. Escape at every sink.
5. **The job board reuses `DISPATCH_SECRET` in a query string.** Give it its own credential, out of the URL.
6. **No token expiry and no rate limiting on `/a/`.** Expire accept tokens once a job is claimed or aged out, and put a limit in front of the route.
7. **Multi-tenancy is half-built.** There is a `client_id` column and a `CLIENT_ID` var, but nothing filters on it — the job board shows every row. Today this is one deployment per business; making it genuinely multi-tenant means scoping every query and every notification target by client.
8. **No retention or archival.** `jobs` grows forever and the board simply takes the newest 100.
9. **Phone normalisation is Australia-only.** `e164()` hardcodes `+61`.
10. **Nothing observes the outcome.** There are no metrics on time-to-accept, escalation rate, or how often the owner ends up being rung — which are exactly the numbers that would tell a business owner whether this is worth paying for, and exactly what should be instrumented before the first live deployment.
11. **`[CONFIRM]` Cost model.** Running a cron every minute means roughly 1,440 scheduled invocations per day whether or not any jobs exist, and the dominant marginal cost is Twilio per message and per call minute rather than anything on Cloudflare. No pricing is recorded in this repository, so any dollar figure would be a guess.
12. **Never run live.** The most important next step is not on this list — it is placing a real call through the whole path and watching what breaks.
