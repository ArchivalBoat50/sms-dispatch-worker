/**
 * Emergency dispatch Worker  —  spec §5
 *
 * POST /dispatch   Vapi tool call (dispatch_emergency | book_appointment)
 * GET  /a/:token   on-call tech taps "Accept" in the SMS
 * GET  /jobs       job board (the screen you show prospects)
 * cron * * * * *   escalation ladder: 5 min -> second tech, 10 min -> ring owner
 */

const TWILIO = "https://api.twilio.com/2010-04-01/Accounts";

// ---------------------------------------------------------------- helpers

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json" },
  });

const html = (b, s = 200) =>
  new Response(b, { status: s, headers: { "content-type": "text/html;charset=utf-8" } });

/** Constant-time string compare — avoids leaking the secret via timing. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

const token = () =>
  [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 12);

/** Australian mobile -> E.164. 0412 345 678 -> +61412345678 */
function e164(raw) {
  const d = String(raw || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.startsWith("61")) return "+" + d;
  if (d.startsWith("0")) return "+61" + d.slice(1);
  if (d.length === 9) return "+61" + d;
  return "+" + d;
}

async function twilio(env, endpoint, form) {
  const r = await fetch(`${TWILIO}/${env.TWILIO_ACCOUNT_SID}/${endpoint}.json`, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  if (!r.ok) console.error("twilio", endpoint, r.status, await r.text());
  return r.ok;
}

const sms = (env, to, body) =>
  twilio(env, "Messages", { To: e164(to), From: env.TWILIO_FROM, Body: body });

const ring = (env, to, say) =>
  twilio(env, "Calls", {
    To: e164(to),
    From: env.TWILIO_FROM,
    Twiml: `<Response><Say voice="alice">${say}</Say><Pause length="1"/><Say voice="alice">${say}</Say></Response>`,
  });

// ---------------------------------------------------------------- messages

function techSMS(job, base) {
  const running =
    job.severity === "active_damage" ? "YES" : job.severity === "no_water" ? "NO WATER" : "contained";
  return [
    `EMERGENCY - ${job.suburb}`,
    `${job.caller_name} - ${job.callback_number}`,
    job.address,
    job.issue,
    `Water still running: ${running}`,
    ``,
    `Accept: ${base}/a/${job.accept_token}`,
  ].join("\n");
}

function bookingSMS(job) {
  return [
    `BOOKING (${job.preferred_window}) - ${job.suburb}`,
    `${job.caller_name} - ${job.callback_number}`,
    job.address,
    job.issue,
  ].join("\n");
}

// ---------------------------------------------------------------- tool call

/** Pull the tool calls out of whatever shape Vapi sends. */
function extractCalls(body) {
  const m = body?.message ?? body ?? {};
  const list = m.toolCalls || m.toolCallList || m.tool_calls || [];
  const out = [];
  for (const c of list) {
    const fn = c.function || c;
    let args = fn.arguments ?? fn.parameters ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    out.push({ id: c.id || c.toolCallId, name: fn.name, args });
  }
  return out;
}

async function handleDispatch(req, env, ctx) {
  if (!safeEqual(req.headers.get("x-dispatch-secret") || "", env.DISPATCH_SECRET || "")) {
    return json({ error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const calls = extractCalls(body);
  if (!calls.length) return json({ results: [] });

  const base = new URL(req.url).origin;
  const results = [];

  for (const call of calls) {
    // Idempotency — Vapi retries on timeout and we must not double-dispatch.
    if (call.id) {
      const seen = await env.DB.prepare("SELECT result FROM jobs WHERE tool_call_id = ?")
        .bind(call.id)
        .first();
      if (seen) {
        results.push({ toolCallId: call.id, result: seen.result });
        continue;
      }
    }

    const a = call.args || {};
    const emergency = call.name === "dispatch_emergency";

    if (emergency && a.fee_accepted !== true) {
      const msg = "Callout fee was not accepted, so nothing was dispatched.";
      results.push({ toolCallId: call.id, result: msg });
      continue;
    }

    const job = {
      id: crypto.randomUUID(),
      tool_call_id: call.id || null,
      created_at: Date.now(),
      type: emergency ? "emergency" : "booking",
      caller_name: a.caller_name || "",
      callback_number: a.callback_number || "",
      address: a.address || "",
      suburb: a.suburb || "",
      issue: a.issue || "",
      severity: a.severity || null,
      preferred_window: a.preferred_window || null,
      status: emergency ? "new" : "booked",
      accept_token: token(),
      escalation_level: 0,
      client_id: env.CLIENT_ID || "demo",
    };

    const result = emergency
      ? "Dispatched. The on-call plumber will call back within fifteen minutes."
      : `Booked for the next business day, ${job.preferred_window}. We'll call to confirm.`;
    job.result = result;

    await env.DB.prepare(
      `INSERT INTO jobs (id,tool_call_id,created_at,type,caller_name,callback_number,address,
        suburb,issue,severity,preferred_window,status,accept_token,escalation_level,client_id,result)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        job.id, job.tool_call_id, job.created_at, job.type, job.caller_name,
        job.callback_number, job.address, job.suburb, job.issue, job.severity,
        job.preferred_window, job.status, job.accept_token, job.escalation_level,
        job.client_id, job.result
      )
      .run();

    // Don't make the caller wait on Twilio — the agent should keep talking.
    ctx.waitUntil(
      emergency
        ? sms(env, env.TECH_1_NUMBER, techSMS(job, base))
        : sms(env, env.TECH_1_NUMBER, bookingSMS(job))
    );

    results.push({ toolCallId: call.id, result });
  }

  return json({ results });
}

// ---------------------------------------------------------------- accept

async function handleAccept(tok, env, ctx) {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE accept_token = ?").bind(tok).first();
  if (!job) return html(page("Not found", "That link isn't valid."), 404);

  if (job.status === "claimed") {
    return html(page("Already claimed", `${job.claimed_by || "Someone"} took this one.`));
  }

  const who = job.escalation_level >= 2 ? "Owner" : job.escalation_level === 1 ? "Second tech" : "On-call tech";

  await env.DB.prepare("UPDATE jobs SET status='claimed', claimed_by=?, claimed_at=? WHERE id=?")
    .bind(who, Date.now(), job.id)
    .run();

  ctx.waitUntil(
    sms(env, job.callback_number, `${who} is on the way, he'll call you shortly. — ${env.BUSINESS_NAME || "Emergency Plumbing"}`)
  );

  return html(
    page(
      "Job accepted",
      `${job.caller_name} — ${job.callback_number}<br>${job.address}, ${job.suburb}<br><br>
       <b>${job.issue}</b><br><br>They've been texted that you're on the way.`
    )
  );
}

const page = (title, body) => `<!DOCTYPE html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:17px/1.6 -apple-system,system-ui,sans-serif;margin:0;padding:40px 24px;
background:#0f1115;color:#e7e9ee}h1{font-size:22px;margin:0 0 14px}div{max-width:520px;margin:0 auto}
b{color:#6ea8fe}</style><div><h1>${title}</h1><p>${body}</p></div>`;

// ---------------------------------------------------------------- job board

async function handleJobs(url, env) {
  if (!safeEqual(url.searchParams.get("key") || "", env.DISPATCH_SECRET || "")) {
    return new Response("unauthorized", { status: 401 });
  }
  const { results } = await env.DB.prepare(
    "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100"
  ).all();

  const rows = results
    .map((j) => {
      const age = Math.round((Date.now() - j.created_at) / 60000);
      const colour =
        j.status === "claimed" ? "#3fb950" : j.type === "booking" ? "#6ea8fe" : "#f85149";
      return `<tr>
        <td style="color:${colour}">${j.status}${j.escalation_level ? ` (esc ${j.escalation_level})` : ""}</td>
        <td>${j.type}</td><td>${j.suburb}</td>
        <td>${j.caller_name}<br><small>${j.callback_number}</small></td>
        <td>${j.issue}</td><td>${age}m ago</td></tr>`;
    })
    .join("");

  return html(`<!DOCTYPE html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Job board</title><style>
body{font:14px/1.5 -apple-system,system-ui,sans-serif;background:#0f1115;color:#e7e9ee;padding:24px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #2a2f3a;vertical-align:top}
th{color:#9aa3b2;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
small{color:#9aa3b2}h1{font-size:19px}</style>
<h1>Job board</h1><table><tr><th>Status<th>Type<th>Suburb<th>Caller<th>Issue<th>Age</tr>${rows}</table>`);
}

// ---------------------------------------------------------------- escalation

/**
 * Spec §5 ladder. Runs every minute.
 *   no accept within  5 min -> SMS the second on-call number
 *   still nothing at 10 min -> ring the owner directly
 */
async function escalate(env) {
  const now = Date.now();
  const base = env.PUBLIC_BASE_URL;

  const due = await env.DB.prepare(
    `SELECT * FROM jobs WHERE type='emergency' AND status='new' AND escalation_level < 2
       AND created_at < ? ORDER BY created_at ASC LIMIT 25`
  )
    .bind(now - 5 * 60 * 1000)
    .all();

  for (const job of due.results) {
    const mins = (now - job.created_at) / 60000;

    if (job.escalation_level === 0 && mins >= 5) {
      await sms(env, env.TECH_2_NUMBER, "NO RESPONSE FROM TECH 1\n" + techSMS(job, base));
      await env.DB.prepare("UPDATE jobs SET escalation_level=1 WHERE id=?").bind(job.id).run();
    } else if (job.escalation_level === 1 && mins >= 10) {
      await ring(
        env,
        env.OWNER_NUMBER,
        `Unclaimed emergency in ${job.suburb}. ${job.caller_name}. Nobody has accepted for ten minutes. Check your messages.`
      );
      await sms(env, env.OWNER_NUMBER, "UNCLAIMED 10 MIN\n" + techSMS(job, base));
      await env.DB.prepare("UPDATE jobs SET escalation_level=2 WHERE id=?").bind(job.id).run();
    }
  }
}

// ---------------------------------------------------------------- router

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/dispatch" && req.method === "POST") return handleDispatch(req, env, ctx);
    if (p.startsWith("/a/")) return handleAccept(p.slice(3), env, ctx);
    if (p === "/jobs") return handleJobs(url, env);
    if (p === "/health") return json({ ok: true });

    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(escalate(env));
  },
};
