/**
 * Worker test harness. Real SQLite behind a D1-shaped adapter, fetch stubbed
 * so we can inspect exactly what would hit Twilio. No network, no wrangler.
 *   node --experimental-sqlite test.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "./src/index.js";

const db = new DatabaseSync(":memory:");
db.exec(readFileSync("./schema.sql", "utf8"));

// ---- D1 adapter -----------------------------------------------------------
const DB = {
  prepare(sql) {
    let args = [];
    const api = {
      bind(...a) { args = a.map(v => (v === undefined ? null : v)); return api; },
      first() { const r = db.prepare(sql).all(...args); return r[0] ?? null; },
      all()   { return { results: db.prepare(sql).all(...args) }; },
      run()   { return db.prepare(sql).run(...args); },
    };
    return api;
  },
};

// ---- Twilio capture -------------------------------------------------------
let sent = [];
globalThis.fetch = async (url, opts) => {
  const body = Object.fromEntries(new URLSearchParams(opts.body));
  sent.push({ kind: url.includes("/Messages") ? "sms" : "call", ...body });
  return new Response("{}", { status: 201 });
};

const env = {
  DB,
  DISPATCH_SECRET: "s3cr3t",
  TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+61400000000",
  TECH_1_NUMBER: "+61400000001", TECH_2_NUMBER: "+61400000002", OWNER_NUMBER: "+61400000003",
  BUSINESS_NAME: "Sydney Emergency Plumbing", CLIENT_ID: "demo",
  PUBLIC_BASE_URL: "https://w.example.workers.dev",
};
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const settle = async () => { await Promise.all(waits); waits.length = 0; };

const call = (name, args, id) =>
  new Request("https://w.example.workers.dev/dispatch", {
    method: "POST",
    headers: { "x-dispatch-secret": "s3cr3t", "content-type": "application/json" },
    body: JSON.stringify({ message: { toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] } }),
  });

const EMERG = {
  caller_name: "Dave", callback_number: "0412345678", address: "12 Bourke St",
  suburb: "Woolloomooloo", issue: "burst pipe under the sink",
  severity: "active_damage", fee_accepted: true,
};

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  ok  " : "FAIL  "}${label}${cond ? "" : "  <- " + extra}`);
};

// ---------------------------------------------------------------- 1. auth
{
  const r = await worker.fetch(
    new Request("https://w/dispatch", {
      method: "POST", headers: { "x-dispatch-secret": "wrong" }, body: "{}",
    }), env, ctx);
  ok("rejects a wrong secret with 401", r.status === 401, `got ${r.status}`);
}
{
  const r = await worker.fetch(
    new Request("https://w/dispatch", { method: "POST", body: "{}" }), env, ctx);
  ok("rejects a missing secret with 401", r.status === 401, `got ${r.status}`);
}

// ---------------------------------------------------------------- 2. dispatch
let acceptToken;
{
  sent = [];
  const r = await worker.fetch(call("dispatch_emergency", EMERG, "tc-1"), env, ctx);
  const j = await r.json();
  await settle();

  ok("returns a result for the tool call", j.results?.[0]?.toolCallId === "tc-1");
  ok("speaks the callback promise", /fifteen minutes/.test(j.results[0].result));
  ok("sends exactly one SMS", sent.length === 1, `sent ${sent.length}`);
  ok("SMS goes to tech 1", sent[0]?.To === "+61400000001");

  const b = sent[0]?.Body || "";
  ok("SMS header matches spec §5", b.startsWith("EMERGENCY - Woolloomooloo"));
  ok("SMS carries name and number", b.includes("Dave - 0412345678"));
  ok("SMS says water still running", b.includes("Water still running: YES"));
  ok("SMS has an accept link", /Accept: https:\/\/.+\/a\/\w+/.test(b), b);

  acceptToken = b.match(/\/a\/(\w+)/)?.[1];
  const row = db.prepare("SELECT * FROM jobs WHERE tool_call_id='tc-1'").get();
  ok("job written to D1 as new", row?.status === "new" && row?.type === "emergency");
}

// ---------------------------------------------------------------- 3. dedupe
{
  sent = [];
  await worker.fetch(call("dispatch_emergency", EMERG, "tc-1"), env, ctx);
  await settle();
  const n = db.prepare("SELECT COUNT(*) c FROM jobs WHERE tool_call_id='tc-1'").get().c;
  ok("a retried tool call does not double-dispatch", n === 1 && sent.length === 0,
     `rows=${n} sms=${sent.length}`);
}

// ---------------------------------------------------------------- 4. fee refused
{
  sent = [];
  const r = await worker.fetch(
    call("dispatch_emergency", { ...EMERG, fee_accepted: false }, "tc-2"), env, ctx);
  const j = await r.json();
  await settle();
  ok("refuses to dispatch when the fee was declined (test 10)",
     sent.length === 0 && /not accepted/i.test(j.results[0].result));
}

// ---------------------------------------------------------------- 5. booking
{
  sent = [];
  const r = await worker.fetch(call("book_appointment", {
    caller_name: "Sue", callback_number: "0498765432", address: "9 King St",
    suburb: "Coogee", issue: "dripping tap", preferred_window: "morning",
  }, "tc-3"), env, ctx);
  const j = await r.json();
  await settle();
  ok("booking path books instead of dispatching", /next business day/i.test(j.results[0].result));
  ok("booking SMS is tagged BOOKING", (sent[0]?.Body || "").startsWith("BOOKING (morning) - Coogee"));
  const row = db.prepare("SELECT * FROM jobs WHERE tool_call_id='tc-3'").get();
  ok("booking stored with status booked", row?.status === "booked");
}

// ---------------------------------------------------------------- 6. accept
{
  sent = [];
  const r = await worker.fetch(new Request(`https://w/a/${acceptToken}`), env, ctx);
  const body = await r.text();
  await settle();
  ok("accept link returns the job card", r.status === 200 && body.includes("Job accepted"));
  ok("caller is texted that help is coming",
     sent[0]?.To === "+61412345678" && /on the way/.test(sent[0]?.Body || ""));
  const row = db.prepare("SELECT * FROM jobs WHERE tool_call_id='tc-1'").get();
  ok("job marked claimed", row?.status === "claimed");
}
{
  sent = [];
  const r = await worker.fetch(new Request(`https://w/a/${acceptToken}`), env, ctx);
  ok("second tap says already claimed", (await r.text()).includes("Already claimed"));
  ok("second tap sends no further SMS", sent.length === 0);
}
{
  const r = await worker.fetch(new Request("https://w/a/bogustoken"), env, ctx);
  ok("unknown accept token 404s", r.status === 404);
}

// ---------------------------------------------------------------- 7. ladder
{
  // Unclaimed emergency, aged 6 minutes.
  await worker.fetch(call("dispatch_emergency", { ...EMERG, suburb: "Bulimba" }, "tc-9"), env, ctx);
  await settle();
  db.prepare("UPDATE jobs SET created_at=? WHERE tool_call_id='tc-9'")
    .run(Date.now() - 6 * 60000);

  sent = [];
  await worker.scheduled({}, env, ctx); await settle();
  ok("at 5 min escalates to tech 2",
     sent.length === 1 && sent[0].To === "+61400000002" && /NO RESPONSE/.test(sent[0].Body));
  ok("escalation level recorded as 1",
     db.prepare("SELECT * FROM jobs WHERE tool_call_id='tc-9'").get().escalation_level === 1);

  // Age it to 11 minutes.
  db.prepare("UPDATE jobs SET created_at=? WHERE tool_call_id='tc-9'")
    .run(Date.now() - 11 * 60000);
  sent = [];
  await worker.scheduled({}, env, ctx); await settle();
  ok("at 10 min rings the owner", sent.some(s => s.kind === "call" && s.To === "+61400000003"));
  ok("owner also gets the job by SMS", sent.some(s => s.kind === "sms" && s.To === "+61400000003"));
  ok("escalation level recorded as 2",
     db.prepare("SELECT * FROM jobs WHERE tool_call_id='tc-9'").get().escalation_level === 2);

  // Nothing further should fire.
  sent = [];
  await worker.scheduled({}, env, ctx); await settle();
  ok("ladder stops after the owner", sent.length === 0, `sent ${sent.length}`);
}
{
  // A claimed job must never escalate.
  sent = [];
  db.prepare("UPDATE jobs SET created_at=? WHERE tool_call_id='tc-1'")
    .run(Date.now() - 30 * 60000);
  await worker.scheduled({}, env, ctx); await settle();
  ok("a claimed job never escalates", sent.length === 0, `sent ${sent.length}`);
}

// ---------------------------------------------------------------- 8. job board
{
  const bad = await worker.fetch(new Request("https://w/jobs?key=nope"), env, ctx);
  ok("job board rejects a bad key", bad.status === 401);
  const good = await worker.fetch(new Request("https://w/jobs?key=s3cr3t"), env, ctx);
  const b = await good.text();
  ok("job board lists jobs", good.status === 200 && b.includes("Woolloomooloo") && b.includes("Coogee"));
}

// ---------------------------------------------------------------- 9. numbers
{
  sent = [];
  await worker.fetch(call("dispatch_emergency",
    { ...EMERG, callback_number: "0412 345 678" }, "tc-11"), env, ctx);
  await settle();
  const r = await worker.fetch(new Request(
    `https://w/a/${db.prepare("SELECT accept_token t FROM jobs WHERE tool_call_id='tc-11'").get().t}`),
    env, ctx);
  await r.text(); await settle();
  ok("spaced AU mobile normalises to E.164",
     sent.some(s => s.To === "+61412345678"), JSON.stringify(sent.map(s => s.To)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
