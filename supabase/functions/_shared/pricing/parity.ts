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
 * Numbers are compared with Object.is; strings and booleans with ===;
 * arrays in order; objects on the union of both key sets, so a value one
 * side emits and the other does not is a failure, not an omission.
 *
 * The fixtures are written by Kotlin (ParityFixtureWriter) and never
 * regenerated from this side. When a case fails, the first divergent stage
 * is named so the port can be read against the Kotlin at that stage.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { f32 } from "./f32.ts";
import { PRICING_ENGINE_VERSION, priceJob } from "./index.ts";
import type { PricingInput, PricingOutput } from "./index.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../../fixtures/pricing/", import.meta.url));

interface Fixture {
  schema: number;
  engine: { version: string; generated_at: string };
  case: string;
  input: PricingInput;
  expected: PricingOutput;
}

interface Divergence {
  stage: string;
  path: string;
  expected: unknown;
  actual: unknown;
}

/**
 * Fields the phone holds as Float. The contract asks the writer to emit
 * them after fround, so decoding them through fround is the identity on a
 * well-formed fixture; on a fixture that wrote "0.1" instead of the exact
 * float32 value it recovers the float the writer meant. That is a decode
 * of the declared type, not a tolerance -- the comparison after it is still
 * Object.is. A field that was NOT float32-exact is reported so the writer
 * can be fixed.
 */
const FLOAT32_PATHS = [
  /^linear_feet$/,
  /^teardown_linear_feet$/,
  /^billable_linear_feet$/,
  /^runs\[\d+\]\.(gross_feet|gate_feet|net_feet)$/,
  /^runs\[\d+\]\.entries\[\d+\]\.(prefer_covers_ft|covers_linear_ft)$/,
];

const inexactFloatFields: string[] = [];

function decodeExpected(path: string, value: unknown): unknown {
  if (typeof value !== "number") return value;
  if (!FLOAT32_PATHS.some((re) => re.test(path))) return value;
  const decoded = f32(value);
  if (!Object.is(decoded, value)) inexactFloatFields.push(path);
  return decoded;
}

function describe(v: unknown): string {
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  return JSON.stringify(v) ?? String(v);
}

/** First difference between expected and actual under `path`, or null. */
function firstDifference(stage: string, path: string, expected: unknown, actual: unknown): Divergence | null {
  const exp = decodeExpected(path, expected);
  if (exp === null || actual === null || typeof exp !== "object" || typeof actual !== "object") {
    if (typeof exp === "number" && typeof actual === "number") {
      return Object.is(exp, actual) ? null : { stage, path, expected: exp, actual };
    }
    if (typeof exp !== typeof actual || exp !== actual) return { stage, path, expected: exp, actual };
    return null;
  }
  if (Array.isArray(exp) !== Array.isArray(actual)) return { stage, path, expected: exp, actual };
  if (Array.isArray(exp) && Array.isArray(actual)) {
    if (exp.length !== actual.length) {
      return { stage, path: `${path}.length`, expected: exp.length, actual: actual.length };
    }
    for (let i = 0; i < exp.length; i++) {
      const d = firstDifference(stage, `${path}[${i}]`, exp[i], actual[i]);
      if (d !== null) return d;
    }
    return null;
  }
  const expObj = exp as Record<string, unknown>;
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
 * The stages, in the order the engine computes them, so the report names
 * the earliest place the two engines parted rather than the loudest.
 */
function compareStaged(expected: PricingOutput, actual: PricingOutput): Divergence | null {
  const stages: Array<[string, () => Divergence | null]> = [
    ["engine_version", () => firstDifference("engine_version", "engine_version", expected.engine_version, actual.engine_version)],
    ["linear_feet", () => firstDifference("linear_feet", "linear_feet", expected.linear_feet, actual.linear_feet)],
    ["teardown_linear_feet", () => firstDifference("teardown_linear_feet", "teardown_linear_feet", expected.teardown_linear_feet, actual.teardown_linear_feet)],
    ["runs.count", () => firstDifference("runs.count", "runs.length", expected.runs.length, actual.runs.length)],
  ];
  for (let i = 0; i < Math.min(expected.runs.length, actual.runs.length); i++) {
    const e = expected.runs[i];
    const a = actual.runs[i];
    const p = `runs[${i}]`;
    stages.push([`${p}.run_sync_id`, () => firstDifference(`${p}.run_sync_id`, `${p}.run_sync_id`, e.run_sync_id, a.run_sync_id)]);
    stages.push([`${p}.geometry`, () => firstDifference(`${p}.geometry`, `${p}.geometry`, e.geometry, a.geometry)]);
    stages.push([`${p}.feet`, () =>
      firstDifference(`${p}.feet`, `${p}.gross_feet`, e.gross_feet, a.gross_feet) ??
      firstDifference(`${p}.feet`, `${p}.gate_feet`, e.gate_feet, a.gate_feet) ??
      firstDifference(`${p}.feet`, `${p}.net_feet`, e.net_feet, a.net_feet)]);
    stages.push([`${p}.posts`, () => firstDifference(`${p}.posts`, `${p}.posts`, e.posts, a.posts)]);
    stages.push([`${p}.entries`, () => firstDifference(`${p}.entries`, `${p}.entries`, e.entries, a.entries)]);
  }
  stages.push(["items.count", () => firstDifference("items.count", "items.length", expected.items.length, actual.items.length)]);
  for (let i = 0; i < Math.min(expected.items.length, actual.items.length); i++) {
    stages.push([`items[${i}]`, () => firstDifference(`items[${i}]`, `items[${i}]`, expected.items[i], actual.items[i])]);
  }
  stages.push(["unmatched_roles", () => firstDifference("unmatched_roles", "unmatched_roles", expected.unmatched_roles, actual.unmatched_roles)]);
  stages.push(["zero_priced", () => firstDifference("zero_priced", "zero_priced", expected.zero_priced, actual.zero_priced)]);
  stages.push(["totals", () => firstDifference("totals", "totals", expected.totals, actual.totals)]);
  stages.push(["billable_linear_feet", () => firstDifference("billable_linear_feet", "billable_linear_feet", expected.billable_linear_feet, actual.billable_linear_feet)]);
  // Anything the stages above did not cover -- a field one side has and
  // the other does not, at the top level.
  stages.push(["output", () => firstDifference("output", "", expected, actual)]);

  for (const [, check] of stages) {
    const d = check();
    if (d !== null) return d;
  }
  return null;
}

function main(): number {
  if (!existsSync(FIXTURES_DIR)) {
    console.error(`parity: no fixtures at ${FIXTURES_DIR}`);
    console.error("parity: generate them from Kotlin first:");
    console.error('parity:   FENCEFLOW_PARITY_OUT=fixtures/pricing ./gradlew testDebugUnitTest --tests "*ParityFixtureWriter*"');
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
    if (fixture.input?.engine_version !== undefined && fixture.input.engine_version !== PRICING_ENGINE_VERSION) {
      console.log(`FAIL ${caseId}  at input.engine_version: ${describe(fixture.input.engine_version)}`);
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

    inexactFloatFields.length = 0;
    const divergence = compareStaged(fixture.expected, actual);
    if (divergence === null) {
      console.log(`ok   ${caseId}`);
    } else {
      console.log(`FAIL ${caseId}  at ${divergence.stage}: ${divergence.path} expected=${describe(divergence.expected)} actual=${describe(divergence.actual)}`);
      failed++;
    }
    if (inexactFloatFields.length > 0) {
      console.log(`     note: ${caseId} wrote non-float32 values for Float fields: ${Array.from(new Set(inexactFloatFields)).join(", ")}`);
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
