/**
 * Replays the Kotlin-generated pricing fixtures through the TypeScript
 * engine and demands EXACT equality, stage by stage.
 *
 * No test framework, deliberately: the same file runs under
 * `npx -y tsx supabase/functions/_shared/pricing/parity.ts` and under
 * `deno run -A supabase/functions/_shared/pricing/parity.ts`, and it is what
 * scripts/check-parity.mjs calls before a release or a deploy is allowed.
 *
 * No tolerances, ever. Two engines that agree "to within a cent" are two
 * engines that disagree, and the customer sees whichever one wrote last.
 * Numbers are compared with Object.is (so -0 and 0 differ, and a NaN is
 * only equal to a NaN); strings and booleans with ===; arrays in order;
 * objects on the union of both key sets, so a value one side emits and the
 * other does not is a failure, not an omission. The expected values are
 * used exactly as JSON.parse hands them over: nothing is rounded, decoded
 * or coerced on the way in.
 *
 * The fixtures are written by Kotlin (ParityFixtureWriter) and never
 * regenerated from this side. When a case fails, the first divergent stage
 * is named -- in the order ParityFixtureCheck names them, which is the order
 * the engine computes them -- so the port can be read against the Kotlin at
 * that stage rather than at the loudest one.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PRICING_ENGINE_VERSION, priceJob } from "./index.ts";
import type { PricingInput, PricingOutput } from "./index.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../../fixtures/pricing/", import.meta.url));

interface Fixture {
  schema: number;
  engine: { version: string; generated_at: string };
  case: string;
  note?: string;
  input: PricingInput;
  expected: PricingOutput;
}

interface Divergence {
  stage: string;
  path: string;
  expected: unknown;
  actual: unknown;
}

function describe(v: unknown): string {
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  return JSON.stringify(v) ?? String(v);
}

/** First difference between expected and actual under `path`, or null. */
function firstDifference(stage: string, path: string, expected: unknown, actual: unknown): Divergence | null {
  if (expected === null || actual === null || typeof expected !== "object" || typeof actual !== "object") {
    if (typeof expected === "number" && typeof actual === "number") {
      return Object.is(expected, actual) ? null : { stage, path, expected, actual };
    }
    if (typeof expected !== typeof actual || expected !== actual) return { stage, path, expected, actual };
    return null;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) return { stage, path, expected, actual };
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return { stage, path: `${path}.length`, expected: expected.length, actual: actual.length };
    }
    for (let i = 0; i < expected.length; i++) {
      const d = firstDifference(stage, `${path}[${i}]`, expected[i], actual[i]);
      if (d !== null) return d;
    }
    return null;
  }
  const expObj = expected as Record<string, unknown>;
  const actObj = actual as Record<string, unknown>;
  // Expected's keys first, in its order, then anything only actual has.
  const keys = Array.from(new Set([...Object.keys(expObj), ...Object.keys(actObj)]));
  for (const key of keys) {
    const sub = path === "" ? key : `${path}.${key}`;
    if (!(key in expObj)) return { stage, path: sub, expected: "<absent>", actual: actObj[key] };
    if (!(key in actObj)) return { stage, path: sub, expected: expObj[key], actual: "<absent>" };
    const d = firstDifference(stage, sub, expObj[key], actObj[key]);
    if (d !== null) return d;
  }
  return null;
}

/**
 * The stages, in the order ParityFixtureCheck.firstDivergence names them
 * (docs/PRICING_CONTRACT.md, "Output rules"): per run geometry, net feet,
 * posts, entries, takeoff; then items, unmatched_roles, zero_priced,
 * zero_priced_names, feet, totals_items, totals. The first that differs is
 * the one reported.
 */
function compareStaged(expected: PricingOutput, actual: PricingOutput): Divergence | null {
  const at = (stage: string, path: string, e: unknown, a: unknown): Divergence | null => firstDifference(stage, path, e, a);
  const stages: Array<() => Divergence | null> = [
    () => at("engine_version", "engine_version", expected.engine_version, actual.engine_version),
    () => at("runs", "runs.length", expected.runs.length, actual.runs.length),
  ];
  for (let i = 0; i < Math.min(expected.runs.length, actual.runs.length); i++) {
    const e = expected.runs[i];
    const a = actual.runs[i];
    const p = `runs[${i}]`;
    const tag = `run ${e.run_sync_id}`;
    stages.push(() => at(`${tag} identity`, `${p}.run_sync_id`, e.run_sync_id, a.run_sync_id));
    stages.push(() => at(`${tag} is_teardown`, `${p}.is_teardown`, e.is_teardown, a.is_teardown));
    stages.push(() =>
      at(`${tag} geometry`, `${p}.gross_feet`, e.gross_feet, a.gross_feet) ??
      at(`${tag} geometry`, `${p}.geometry`, e.geometry, a.geometry));
    stages.push(() =>
      at(`${tag} net_feet`, `${p}.gate_count`, e.gate_count, a.gate_count) ??
      at(`${tag} net_feet`, `${p}.gate_feet`, e.gate_feet, a.gate_feet) ??
      at(`${tag} net_feet`, `${p}.net_feet`, e.net_feet, a.net_feet));
    stages.push(() => at(`${tag} posts`, `${p}.posts`, e.posts, a.posts));
    stages.push(() => at(`${tag} entries`, `${p}.entries`, e.entries, a.entries));
    stages.push(() => at(`${tag} takeoff`, `${p}.takeoff`, e.takeoff, a.takeoff));
  }
  stages.push(() => at("items", "items", expected.items, actual.items));
  stages.push(() => at("unmatched_roles", "unmatched_roles", expected.unmatched_roles, actual.unmatched_roles));
  stages.push(() => at("zero_priced", "zero_priced", expected.zero_priced, actual.zero_priced));
  stages.push(() => at("zero_priced_names", "zero_priced_names", expected.zero_priced_names, actual.zero_priced_names));
  stages.push(() =>
    at("feet", "linear_feet", expected.linear_feet, actual.linear_feet) ??
    at("feet", "teardown_linear_feet", expected.teardown_linear_feet, actual.teardown_linear_feet) ??
    at("feet", "billable_linear_feet", expected.billable_linear_feet, actual.billable_linear_feet));
  stages.push(() => at("totals_items", "totals_items", expected.totals_items, actual.totals_items));
  stages.push(() => at("totals", "totals", expected.totals, actual.totals));
  // Anything the stages above did not cover -- a field one side has and
  // the other does not, at any level.
  stages.push(() => at("output", "", expected, actual));

  for (const check of stages) {
    const d = check();
    if (d !== null) return d;
  }
  return null;
}

function main(): number {
  if (!existsSync(FIXTURES_DIR)) {
    console.error(`parity: no fixtures at ${FIXTURES_DIR}`);
    console.error("parity: generate them from Kotlin first:");
    console.error('parity:   FENCEFLOW_PARITY_OUT=$(pwd)/fixtures/pricing ./gradlew testDebugUnitTest --tests "*ParityFixtureWriter*"');
    return 1;
  }

  const manifestPath = join(FIXTURES_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`parity: ${manifestPath} is missing`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string; case_count: number };
  if (manifest.version !== PRICING_ENGINE_VERSION) {
    console.error(`parity: fixture manifest is version ${manifest.version} but this engine is ${PRICING_ENGINE_VERSION}`);
    console.error("parity: a pricing change is one commit touching both engines, both constants and the regenerated fixtures");
    return 1;
  }

  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .sort();
  if (files.length === 0) {
    console.error("parity: manifest present but no case files");
    return 1;
  }

  let failed = 0;
  for (const file of files) {
    let fixture: Fixture;
    try {
      fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as Fixture;
    } catch (e) {
      console.log(`FAIL ${file}  unreadable: ${(e as Error).message}`);
      failed++;
      continue;
    }
    const caseId = fixture.case ?? file;
    if (fixture.schema !== 1) {
      console.log(`FAIL ${caseId}  at schema: expected 1, got ${describe(fixture.schema)}`);
      failed++;
      continue;
    }
    if (fixture.engine?.version !== PRICING_ENGINE_VERSION) {
      console.log(`FAIL ${caseId}  at engine.version: fixture ${describe(fixture.engine?.version)}, engine ${PRICING_ENGINE_VERSION}`);
      failed++;
      continue;
    }

    let actual: PricingOutput;
    try {
      actual = priceJob(fixture.input);
    } catch (e) {
      console.log(`FAIL ${caseId}  at priceJob: threw ${(e as Error).stack ?? e}`);
      failed++;
      continue;
    }

    const divergence = compareStaged(fixture.expected, actual);
    if (divergence === null) {
      console.log(`ok   ${caseId}`);
    } else {
      console.log(`FAIL ${caseId}  at ${divergence.stage}: ${divergence.path} expected=${describe(divergence.expected)} actual=${describe(divergence.actual)}`);
      failed++;
    }
  }

  if (manifest.case_count !== files.length) {
    console.log(`FAIL manifest.case_count is ${manifest.case_count} but ${files.length} case files were found`);
    failed++;
  }

  console.log(`parity: ${files.length - failed} of ${files.length} cases agree (engine ${PRICING_ENGINE_VERSION})`);
  return failed === 0 ? 0 : 1;
}

process.exit(main());
