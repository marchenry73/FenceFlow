/**
 * What the work IS, in words -- for the HOA letter the customer forwards, and
 * for the scope of work on an email.
 *
 * "I also want to send the verbiage to the HOA to the customer's email so the
 *  customer can send it to the HOA with every information needed."
 *
 * IT DOES NOT MEASURE ANYTHING. Every length here arrives as a parameter,
 * computed by the one pricing engine, because a second implementation of "how
 * long is this fence" is exactly how the office and the phone end up quoting
 * different jobs. The module describes; it does not calculate -- not the
 * lengths, and not the gates either.
 *
 * IT IMPORTS NOTHING FROM THE ENGINE, and that is a rule rather than a
 * preference. tests/a94 holds that exactly ONE edge function may bundle
 * _shared/pricing, because two bundles can be deployed at different versions
 * and then the office quotes a different number from the phone. An earlier
 * version of this file imported the engine's gate decoder, which satisfied
 * the letter of that check (it only scans each function's index.ts) while
 * quietly putting a second copy of engine code in a second function. So the
 * gates arrive as figures too: count and total opening, straight from the
 * engine's own output.
 *
 * Pure, like follow-up-logic.ts and quote-deposit.ts: no Deno, no fetch, no
 * clock of its own, so tests/job-spec.test.mjs runs it under plain Node.
 */

/** Only the fields the description needs. */
export interface SpecJob {
  customer_name?: string | null;
  address?: string | null;
  hoa_name?: string | null;
  teardown_enabled?: boolean | null;
  teardown_feet?: number | null;
}

export interface SpecRun {
  sync_id: string;
  label?: string | null;
  fence_type?: string | null;
  color_or_finish?: string | null;
  panel_height_ft?: number | null;
  post_spacing_ft?: number | null;
  concrete_bags_per_post?: number | null;
  is_teardown?: boolean | null;
  sort_order?: number | null;
}

export interface SpecCompany {
  /** Field names match public.companies, read back from the live schema
   *  rather than guessed: it is license_no, not license_number. */
  name?: string | null;
  license_no?: string | null;
  phone?: string | null;
  email?: string | null;
}

/**
 * Gates as the engine counts them: how many, and how much opening in total.
 *
 * NOT a list of individual widths. Those would mean decoding gates_encoded
 * here, which is engine code -- see the header. For the common case (one gate
 * on a side) count and total give the exact width anyway; for two or more the
 * letter says "2 gates, 14 ft of opening", which is what an association needs
 * and is a figure the engine itself produced.
 */
export interface SpecGates {
  count: number;
  feetTotal: number;
}

export interface SpecSide {
  label: string;
  fenceType: string;
  color: string;
  heightFt: number;
  feet: number;
  postSpacingFt: number;
  setInConcrete: boolean;
  gates: SpecGates;
}

export interface JobSpec {
  customerName: string;
  address: string;
  hoaName: string;
  /** Sum of the feet handed in for the sides that are NOT teardown. */
  totalFeet: number;
  /** Feet of existing fence coming out, 0 when none. */
  teardownFeet: number;
  sides: SpecSide[];
  /** Every side's gates added together. */
  gates: SpecGates;
  /** Distinct declared heights, ascending. A 4ft-and-6ft job lists both. */
  heights: number[];
}

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
const num = (n: unknown): number => (typeof n === "number" && isFinite(n) ? n : 0);

/** One decimal, and no trailing ".0" -- "61.5 ft", "120 ft". */
export function feet(n: number): string {
  const r = Math.round(num(n) * 10) / 10;
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + " ft";
}

/**
 * A readable name for a fence type. The stored value is an enum-ish string
 * (VINYL_PRIVACY, ALUMINUM, CHAIN_LINK...), and an HOA board should not be
 * reading database constants.
 *
 * Anything unrecognised is TITLE-CASED, never dropped and never replaced by
 * a guess: a type this function has not been taught still has to appear in
 * the letter, because the alternative is a specification with a side missing.
 */
export function fenceTypeWords(raw: string): string {
  const key = clean(raw).toUpperCase().replace(/[\s-]+/g, "_");
  if (!key) return "Fence";
  const known: Record<string, string> = {
    VINYL: "Vinyl",
    VINYL_PRIVACY: "Vinyl privacy",
    VINYL_PICKET: "Vinyl picket",
    VINYL_RANCH_RAIL: "Vinyl ranch rail",
    WOOD: "Wood",
    WOOD_PRIVACY: "Wood privacy",
    WOOD_PICKET: "Wood picket",
    WOOD_SHADOWBOX: "Wood shadowbox",
    ALUMINUM: "Aluminum",
    ALUMINUM_ORNAMENTAL: "Ornamental aluminum",
    CHAIN_LINK: "Chain link",
    SPLIT_RAIL: "Split rail",
    FARM: "Farm fence",
  };
  if (known[key]) return known[key];
  return key
    .split("_")
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join(" ");
}

/** What the engine measured for one run. */
export interface RunMeasurement {
  feet: number;
  gateCount: number;
  gateFeet: number;
}

/**
 * Describes the job.
 *
 * @param measured per run, from the pricing engine --
 *   `RunOutput.gross_feet`, keyed by `run_sync_id`. GROSS, not net: gross is
 *   the length of the fence line, which is what an association is approving,
 *   while net subtracts the gate openings and would quietly describe a
 *   shorter fence than the one being built. The gates are listed separately
 *   so nothing is hidden either way.
 *
 *   A run missing from this map is described with 0 feet rather than guessed
 *   at -- an HOA letter that invents a length is worse than one that shows a
 *   gap somebody has to ask about.
 */
export function describeJob(
  job: SpecJob,
  runs: readonly SpecRun[],
  measured: Readonly<Record<string, RunMeasurement>>,
): JobSpec {
  const ordered = [...runs].sort((a, b) => num(a.sort_order) - num(b.sort_order));

  const sides: SpecSide[] = [];
  const allGates: SpecGates = { count: 0, feetTotal: 0 };
  let totalFeet = 0;
  let teardownFeet = num(job.teardown_feet);

  for (const run of ordered) {
    const m = measured[run.sync_id];
    const runFeet = num(m?.feet);

    // A teardown run is existing fence coming OUT. It is not part of what is
    // being built, so it must not be added to the total an HOA reads as the
    // new fence -- it is reported separately, as a removal.
    if (run.is_teardown) {
      if (!job.teardown_feet) teardownFeet += runFeet;
      continue;
    }

    const gates: SpecGates = { count: num(m?.gateCount), feetTotal: num(m?.gateFeet) };
    allGates.count += gates.count;
    allGates.feetTotal += gates.feetTotal;

    sides.push({
      label: clean(run.label) || `Side ${sides.length + 1}`,
      fenceType: fenceTypeWords(clean(run.fence_type)),
      color: clean(run.color_or_finish),
      heightFt: num(run.panel_height_ft),
      feet: runFeet,
      postSpacingFt: num(run.post_spacing_ft),
      setInConcrete: num(run.concrete_bags_per_post) > 0,
      gates,
    });
    totalFeet += runFeet;
  }

  const heights = [...new Set(sides.map((s) => s.heightFt).filter((h) => h > 0))]
    .sort((a, b) => a - b);

  return {
    customerName: clean(job.customer_name),
    address: clean(job.address),
    hoaName: clean(job.hoa_name),
    totalFeet,
    teardownFeet,
    sides,
    gates: allGates,
    heights,
  };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "No gates.", "One gate, 4 ft.", "2 gates, 14 ft of opening." */
function gateWords(gates: SpecGates): string {
  if (gates.count <= 0) return "No gates.";
  // One gate: the total IS that gate's width, so it reads exactly.
  if (gates.count === 1) return `One gate, ${feet(gates.feetTotal)}.`;
  return `${gates.count} gates, ${feet(gates.feetTotal)} of opening.`;
}

/**
 * The letter itself: addressed to the HOA, sent to the CUSTOMER so they can
 * forward it. That is what was asked for, and it is also the only version
 * that works -- the HOA has no relationship with the contractor, and an
 * approval request has to come from the homeowner who owns the lot.
 *
 * Deliberately NOT a submission form. Every HOA has its own, and inventing
 * one would be inventing requirements; this supplies the facts those forms
 * ask for, in one place, over the contractor's license number.
 */
/**
 * The specification itself, line by line.
 *
 * ONE source for it, because it goes out twice: in the body of the email and
 * again as the attached PDF. Built in two places it would eventually say two
 * different things, and the one the HOA keeps is the attachment.
 */
export function scopeOfWorkLines(spec: JobSpec, company: SpecCompany): string[] {
  const companyName = clean(company.name) || "your fence contractor";
  const who = spec.customerName || "the homeowner";
  const addr = spec.address || "the property";

  const heightLine = spec.heights.length === 0
    ? ""
    : spec.heights.length === 1
      ? `Height: ${feet(spec.heights[0])}.`
      // The mixed-height job is the one an HOA asks about, so it is stated as
      // two figures rather than averaged into one that is true of neither.
      : `Heights: ${spec.heights.map(feet).join(" and ")}, by section.`;

  const lines: string[] = [];
  lines.push(`Property: ${addr}`);
  lines.push(`Homeowner: ${who}`);
  if (spec.hoaName) lines.push(`Association: ${spec.hoaName}`);
  lines.push("");
  lines.push("PROPOSED WORK");
  lines.push(`Total new fence: ${feet(spec.totalFeet)}.`);
  if (heightLine) lines.push(heightLine);
  if (spec.teardownFeet > 0) {
    lines.push(`Existing fence to be removed: ${feet(spec.teardownFeet)}.`);
  }
  lines.push(gateWords(spec.gates));
  lines.push("");
  lines.push("BY SECTION");
  for (const s of spec.sides) {
    const bits = [
      `${s.label}: ${feet(s.feet)}`,
      s.fenceType,
      s.heightFt > 0 ? feet(s.heightFt) + " high" : "",
      s.color ? `color/finish ${s.color}` : "",
      s.postSpacingFt > 0 ? `posts at ${feet(s.postSpacingFt)} on center` : "",
      s.setInConcrete ? "posts set in concrete" : "",
      s.gates.count > 0 ? gateWords(s.gates).replace(/\.$/, "") : "",
    ].filter(Boolean);
    lines.push("- " + bits.join(", ") + ".");
  }
  lines.push("");
  lines.push("CONTRACTOR");
  lines.push(companyName);
  if (clean(company.license_no)) lines.push(`License: ${clean(company.license_no)}`);
  if (clean(company.phone)) lines.push(`Phone: ${clean(company.phone)}`);
  if (clean(company.email)) lines.push(`Email: ${clean(company.email)}`);

  return lines;
}

export function hoaLetter(
  spec: JobSpec,
  company: SpecCompany,
): { subject: string; text: string; html: string } {
  const addr = spec.address || "the property";
  const spec_block = scopeOfWorkLines(spec, company).join("\n");

  const intro =
    `Hi ${spec.customerName ? spec.customerName.split(" ")[0] : "there"}, here is ` +
    `everything your HOA normally asks for, ready to forward. Send it to your ` +
    `association as it is, or paste it into their own form if they have one. ` +
    `If they come back with a question we have not answered, tell us and we ` +
    `will put it in writing.`;

  const text = `${intro}\n\n${"-".repeat(52)}\n${spec_block}\n${"-".repeat(52)}\n`;

  const html =
    `<!doctype html><html><body style="margin:0;background:#F7F8FA;font-family:-apple-system,` +
    `BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#12151A">` +
    `<div style="max-width:34rem;margin:0 auto;padding:28px 20px">` +
    `<div style="background:#fff;border:1px solid #E3E7ED;border-radius:12px;padding:26px">` +
    `<p>${esc(intro)}</p>` +
    `<pre style="white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;` +
    `font-size:13px;background:#F7F8FA;border:1px solid #E3E7ED;border-radius:8px;padding:14px">` +
    `${esc(spec_block)}</pre>` +
    `<p style="font-size:12px;color:#8A93A0">Measurements are from the site drawing for this job. ` +
    `If the association needs the drawing itself, ask us and we will send it.</p>` +
    `</div></div></body></html>`;

  return {
    subject: `Fence details for your HOA -- ${addr || "your property"}`,
    text,
    html,
  };
}
