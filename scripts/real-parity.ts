/**
 * Prices a REAL job's cloud rows through the server engine and writes the
 * result as a parity fixture, so the phone's engine can be run on the very
 * same rows by ParityFixtureCheck. This is how "the office and the phone
 * disagree on John's job" is settled: if the phone reproduces this file
 * exactly, the engines agree and the difference is in the DATA the phone
 * priced with; if not, the first divergent stage is the bug.
 *
 * Usage (rows exported with `supabase db query --output json`, one file per
 * table, each `select row_to_json(t) as r from ...`):
 *   npx -y tsx scripts/real-parity.ts <dir-with-job.json,runs.json,catalog.json,
 *       manufacturers.json,change_orders.json,items.json> <case-name> <out.json>
 *
 * Customer fields are scrubbed to the case name. Never commit the output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { priceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";

const [dir, caseName, outFile] = process.argv.slice(2);
if (!dir || !caseName || !outFile) {
  console.error("usage: real-parity.ts <dir> <case-name> <out.json>");
  process.exit(2);
}

function rows(file: string): any[] {
  const raw = readFileSync(join(dir, file), "utf8");
  // The CLI prints chatter around one JSON value; take every balanced
  // object/array and use the first that is a rows array.
  let i = -1;
  for (;;) {
    const o = raw.indexOf("{", i + 1), a = raw.indexOf("[", i + 1);
    if (o < 0 && a < 0) break;
    i = o < 0 ? a : a < 0 ? o : Math.min(o, a);
    const end = matching(raw, i);
    if (end < 0) break;
    try {
      const v = JSON.parse(raw.slice(i, end + 1));
      const arr = Array.isArray(v) ? v : Array.isArray(v?.rows) ? v.rows : null;
      if (arr) return arr.map((x: any) => (x && typeof x === "object" && "r" in x ? x.r : x));
    } catch { /* not this one */ }
  }
  throw new Error("no rows in " + file);
}
function matching(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return k; }
  }
  return -1;
}

const job = rows("job.json")[0];
job.customer_name = caseName; job.address = ""; job.phone = ""; job.email = ""; job.notes = "";
const src = {
  job,
  runs: rows("runs.json"),
  catalog: rows("catalog.json"),
  manufacturers: rows("manufacturers.json"),
  changeOrders: rows("change_orders.json"),
  existingItems: rows("items.json"),
  engineVersion: PRICING_ENGINE_VERSION,
};
const input = buildPricingInput(src as any);
const expected = priceJob(input);
writeFileSync(outFile, JSON.stringify({
  schema: 1,
  engine: { version: PRICING_ENGINE_VERSION, generated_at: new Date().toISOString() },
  case: caseName,
  note: "Real cloud rows, scrubbed. Server engine output; the phone must reproduce it.",
  input,
  expected,
}));
console.log(`${caseName}: grand_total=${expected.totals.grand_total} items=${expected.items.length} linear_feet=${expected.linear_feet} runs=${expected.runs.length} stored_contract_total=${job.contract_total}`);
