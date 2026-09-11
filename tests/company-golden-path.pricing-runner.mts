// Tiny stdin->stdout wrapper around the REAL server pricing engine, used only
// by tests/company-golden-path.test.mjs.
//
// It exists so the pricing check in that file can call the exact same code
// price-job/index.ts calls (buildPricingInput + priceJob) without duplicating
// a single line of pricing logic and without needing a live HTTP call or a
// signed-in session (see that file's header for why the edge function itself
// is out of reach from here). This file does no I/O of its own beyond
// stdin/stdout, touches no database, and asserts nothing -- it is plumbing,
// not a test.
//
//   npx tsx tests/company-golden-path.pricing-runner.mts < input.json
//
// input.json: { job, runs, catalog, manufacturers, changeOrders, existingItems }
// (the exact Db*Row shapes price-job/index.ts selects -- see JOB_COLUMNS,
// RUN_COLUMNS, CATALOG_COLUMNS etc. there).
// stdout: { output, engineVersion }
import { buildPricingInput } from "../supabase/functions/_shared/pricing/load.ts";
import { priceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const body = JSON.parse(raw);

const input = buildPricingInput({
  job: body.job,
  runs: body.runs ?? [],
  catalog: body.catalog ?? [],
  manufacturers: body.manufacturers ?? [],
  changeOrders: body.changeOrders ?? [],
  existingItems: body.existingItems ?? [],
  engineVersion: PRICING_ENGINE_VERSION,
});

const output = priceJob(input);
process.stdout.write(JSON.stringify({ output, engineVersion: PRICING_ENGINE_VERSION }));
