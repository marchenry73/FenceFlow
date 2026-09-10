// Is FenceFlow up, and is it up in the ways that matter?
//
// Not a test suite -- a thing to run when something feels wrong, or on a
// schedule, and get one honest answer. Every check names what it would mean if
// it failed, because "health check failed" at seven in the morning is not
// information.
//
//   node tests/health-check.mjs
//
// Exit code 0 means everything a customer or a crew needs right now is
// working. Anything else means read the lines above it.

const PROJECT = "newcrgafcptspmapacrx";
const API = `https://${PROJECT}.supabase.co`;
const SITE = "https://fenceflowapp.com";

let bad = 0;
const results = [];

async function check(name, meaning, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ ok: true, name, ms: Date.now() - started, detail });
  } catch (e) {
    bad++;
    results.push({ ok: false, name, ms: Date.now() - started, meaning, detail: e.message });
  }
}

const must = (cond, msg) => { if (!cond) throw new Error(msg); };

async function main() {
  // The pages a person actually opens. A customer with a quote link and a crew
  // member signing in do not care whether the database is healthy if the page
  // will not load.
  for (const [page, who] of [
    ["index.html", "the front door"],
    ["quote.html", "every customer holding a quote link"],
    ["lead.html", "every enquiry from the website"],
    ["dashboard.html", "the office"],
  ]) {
    await check(`page ${page}`, `${who} sees nothing`, async () => {
      const r = await fetch(`${SITE}/${page}`, { cache: "no-store" });
      must(r.ok, `http ${r.status}`);
      const body = await r.text();
      // A page that returns 200 and no content is the failure this catches:
      // a broken deploy serves an empty shell perfectly happily.
      must(body.length > 2000, `only ${body.length} bytes came back`);
      return `${Math.round(body.length / 1024)} kB`;
    });
  }

  await check("update service", "no phone can find a new build", async () => {
    const r = await fetch(`${API}/rest/v1/app_releases?select=version_name,download_url` +
      `&order=version_code.desc&limit=1`, { headers: await anonHeaders() });
    const rows = await r.json();
    must(Array.isArray(rows) && rows.length === 1, "no release row came back");
    must(rows[0].download_url, "the newest release has no download url");
    // The row existing is not the same as the file existing. That gap is
    // exactly what an update prompt pointing at nothing looks like.
    const head = await fetch(rows[0].download_url, { method: "HEAD" });
    must(head.ok, `the APK itself answers http ${head.status}`);
    const size = Number(head.headers.get("content-length") || 0);
    must(size > 1_000_000, `the APK is only ${size} bytes`);
    return `${rows[0].version_name}, ${Math.round(size / 1048576)} MB`;
  });

  await check("quote service", "no customer can open a quote", async () => {
    const r = await fetch(`${API}/functions/v1/quote-view?t=abc`);
    const body = await r.json();
    // A refusal is the healthy answer here: it proves the function is running
    // and validating, without needing a real customer's token.
    must(typeof body.error === "string", "did not answer at all");
    return "answering";
  });

  await check("lead intake", "website enquiries vanish", async () => {
    const r = await fetch(`${API}/functions/v1/lead-intake?c=abc`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const body = await r.json();
    must(typeof body.error === "string", "did not answer at all");
    return "answering";
  });

  await check("mail is configured", "no invitation or reset can be sent", async () => {
    // The first version of this asked the invite function to run with an empty
    // body and treated any answer that did not say "not set up yet" as proof
    // that mail worked. The function stops at authentication long before it
    // looks at credentials, so it answered "No login sent with the request"
    // and the check reported healthy -- while mail was, and is, unconfigured.
    //
    // A health check that cannot fail is worse than no health check. This one
    // asks the project what secrets exist, by name only, and says plainly when
    // it cannot ask.
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "secrets", "list",
      "--project-ref", PROJECT], { encoding: "utf8", shell: process.platform === "win32" });
    if (r.status !== 0) {
      throw new Error("could not read the project secrets (not signed in to the CLI?) " +
                      "-- mail status UNKNOWN, not healthy");
    }
    const names = r.stdout;
    must(/MAIL_API_KEY/.test(names), "MAIL_API_KEY is not set: no email can be sent");
    must(/MAIL_FROM/.test(names), "MAIL_FROM is not set: no email can be sent");
    return "MAIL_API_KEY and MAIL_FROM present";
  });

  // ------------------------------------------------------------- report ---
  console.log("");
  for (const r of results) {
    console.log(r.ok
      ? `  ok    ${r.name.padEnd(22)} ${String(r.ms).padStart(5)}ms  ${r.detail ?? ""}`
      : `  DOWN  ${r.name.padEnd(22)} ${String(r.ms).padStart(5)}ms  ${r.detail}\n        → ${r.meaning}`);
  }
  console.log(bad ? `\n${bad} of ${results.length} unhealthy` : `\nall ${results.length} healthy`);
  process.exit(bad ? 1 : 0);
}

async function anonHeaders() {
  const cfg = await fetch(`${SITE}/config.js`).then(r => r.text());
  const m = cfg.match(/sb_publishable_[A-Za-z0-9_-]+/) || cfg.match(/eyJ[A-Za-z0-9_.-]{40,}/);
  if (!m) throw new Error("no publishable key on the site");
  return { apikey: m[0], Authorization: `Bearer ${m[0]}` };
}

main().catch(e => { console.error("health check could not run:", e.message); process.exit(2); });
