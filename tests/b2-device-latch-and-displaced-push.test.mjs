// Owner list B1 + B2: the device latch, and whether a claim reaches the other
// phone before it is next opened.
//
//   node tests/b2-device-latch-and-displaced-push.test.mjs
//
// Read-only. No network, no CLI, no Gradle.
//
// ---------------------------------------------------------------------------
// WHAT B2 ACTUALLY WAS
//
// "Signing in on another phone does not sync immediately and keeps saying it
// has not reached the cloud."
//
// Not an empty-answer misread. That was checked first and ruled out against
// the live project, read-only: can_see_pay(), my_service_status() and
// device_still_mine() all answer an unauthenticated caller with HTTP 401 /
// SQLSTATE 42501 "permission denied for function" -- a throw, which
// SyncScope.foldPayAnswer maps to MoneyScope.UNKNOWN, never to DENIED. In the
// same second, with the same key and host, is_platform_admin() returned 200
// false and app_releases returned 200 with two real rows, so the channel was
// working and the refusal was specific. The empty array that fools people is
// not in this path.
//
// The cause was local, and it is this repository's own favourite bug shape: a
// question that was never answered, recorded as an answer.
//
// ServiceGate.holdsLogin claims the login only while `claimedFor != userId`,
// and it wrote CLAIMED_FOR straight after the attempt NO MATTER WHAT CAME
// BACK -- including ClaimOutcome.Failed, which the same file defines as "No
// session, offline, a timeout, or a refusal that was neither hint". One failed
// first attempt (attemptClaim returns Failed the instant there is no live
// token, which is exactly the window the first check after a sign-in runs in)
// therefore told the install it had claimed this account for ever. It never
// attempted a claim again; every later check fell through to
// device_still_mine, which truthfully named whichever handset DID hold the
// login; DISPLACED latched; and AutoSync.runSync returned at its displaced
// guard on every pass for the life of the install.
//
// Two things made it stick rather than heal:
//
//   * the guard trusted the stored latch for ever, and the only code that
//     clears it sat behind MainActivity's `fresh != null` short-circuit, so a
//     phone whose service check could not complete never ran it; and
//   * the guard's early return copies only `phase` and `lastError`, leaving
//     hasUnsyncedWork and unsyncedReason exactly as they were -- which is how
//     the card stayed frozen on "Some of this phone's work has not reached the
//     cloud yet. It will go up on the next sync."
//
// Plus the ordinary Sign out button (AccountViewModel.signOut) never cleared
// ServiceGate at all; only the two emergency sign-outs in MainActivity did. So
// CLAIMED_FOR and DISPLACED survived an ordinary sign-out into the next
// sign-in, which reaches the same dead end by a shorter road.
//
// ---------------------------------------------------------------------------
// WHAT B1 ACTUALLY WAS
//
// The nudge arrives and is handled correctly: DeviceClaimPush re-asks the
// server itself, writes the latch on a definite no, and raises a notification.
// What it could not do was reach the SCREEN. MainActivity kept `displaced` in
// a plain `remember` recomputed only inside a LaunchedEffect keyed on a
// counter bumped by ON_RESUME, and nothing observed the preference -- so a
// crew member with the app open carried on working on a handset that had
// already stopped syncing, and learned about it when they next came back to
// the app. Hence the owner's words: "the displaced phone only notices when
// next opened."
//
// ---------------------------------------------------------------------------
// HOW THIS FILE HAS TEETH
//
// Section A does not grep for the fix, it RUNS it. The two rules that decide
// the outcome are read out of the Kotlin by regex and fed to a model of the
// claim/latch/sync state machine. The same model is then run with the OLD
// rules, and the reproduction is asserted to FAIL there. A check that cannot
// fail on the old source is not a check (memory/audit-blind-spots).
//
// Section B is structural, and every claim in it carries an in-memory canary:
// the source text is mutated back to the broken shape and the checker is
// asserted to go red on it. So "ok" can never mean "the detector stopped
// looking".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Line endings normalised for MATCHING only -- this file never writes a source
// back, so nothing here can convert a CRLF file to LF the way a read-modify-
// write would (memory/crlf-lost-by-text-rewrite). The repository is mixed:
// ServiceGate.kt and MainActivity.kt are CRLF, AutoSync.kt and
// DataOwnership.kt are LF, and a canary written with bare \n silently fails to
// mutate half of them otherwise -- which reads as "the canary did not change
// the source", not as a pass.
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * The same source with comments removed.
 *
 * Used by every check that is about what the CODE does. Three separate reviews
 * in one day read a comment and called correct code broken
 * (memory/grep-the-region-not-the-body), and this file nearly did it twice:
 * the AutoSync guard's own comment contains the words `getOrDefault(false)`,
 * so a check looking for that string was satisfied by prose, and its canary
 * rewrote the prose instead of the call.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SERVICE_GATE = "app/src/main/java/com/fenceestimator/app/cloud/ServiceGate.kt";
const AUTO_SYNC = "app/src/main/java/com/fenceestimator/app/cloud/AutoSync.kt";
const OWNERSHIP = "app/src/main/java/com/fenceestimator/app/cloud/DataOwnership.kt";
const MAIN = "app/src/main/java/com/fenceestimator/app/MainActivity.kt";
const CLAIM_PUSH = "app/src/main/java/com/fenceestimator/app/notify/DeviceClaimPush.kt";

let failed = 0, checked = 0;
const ok = (name, cond, detail = "") => {
  checked++;
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

/**
 * The body of the block that starts at `opener`, by counting braces.
 *
 * Regex cannot find the end of a Kotlin block, and a check that reads a
 * "region" by line count is how three separate reviews in one day read a
 * comment and called correct code broken (memory/grep-the-region-not-the-body).
 */
function blockAfter(src, opener) {
  const at = src.indexOf(opener);
  if (at < 0) return null;
  let i = src.indexOf("{", at + opener.length - 1);
  if (opener.trimEnd().endsWith("{")) i = at + opener.length - 1;
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i + 1, j);
    }
  }
  return null;
}

/* ===================================================================== A
   The rules, read out of the Kotlin and executed.
   ===================================================================== */

/**
 * Does holdsLogin record CLAIMED_FOR even when the claim FAILED?
 *
 * Read from the real body rather than assumed, so this file tracks the source
 * instead of describing a source that has since moved.
 */
function stampsClaimedForOnFailure(gateSrc) {
  const body = blockAfter(code(gateSrc), "suspend fun holdsLogin(context: Context): Boolean {");
  if (body === null) return { readable: false };
  const write = /it\[CLAIMED_FOR\]\s*=\s*userId/.exec(body);
  if (!write) return { readable: false };
  // Everything between the claim attempt and the write. A guard naming
  // ClaimOutcome.Failed is the thing that makes the write conditional.
  const before = body.slice(0, write.index);
  const guarded = /if\s*\(\s*outcome\s*!is\s*ClaimOutcome\.Failed\s*\)\s*\{/.test(before);
  return { readable: true, stamps: !guarded };
}

/** Does AutoSync's displaced guard re-ask the server, or trust the latch? */
function reAsksServerOnLatch(syncSrc) {
  const body = blockAfter(code(syncSrc), "if (ServiceGate.wasDisplaced(context)) {");
  if (body === null) return { readable: false };
  return {
    readable: true,
    reAsks: /ServiceGate\.stillMine\(context\)/.test(body) &&
            /SupabaseModule\.hasLiveSession\(\)/.test(body),
  };
}

/**
 * The state machine, as thin as it can be while still being the real thing.
 *
 * `server.holder` is profiles.active_device_id. claim_device sets it;
 * device_still_mine compares against it. `tokenLiveAt` says which attempt
 * number this phone first holds a token on -- the whole bug lives in the
 * attempts before that.
 */
function runPhone({
  stampsOnFailure, reAsks, tokenLiveAt, server, me, passes = 6, prefs: seed,
  // MainActivity runs holdsLogin on each resume ONLY when
  // refreshWhenPossible came back with an answer (`fresh != null &&`). False
  // models the phone whose service check could not complete: the resume never
  // touches the latch, so AutoSync is on its own.
  runsResumeCheck = true,
}) {
  const prefs = { claimedFor: null, displaced: false, ...(seed || {}) };
  let attempt = 0;
  const syncedOn = [];

  const tokenLive = () => attempt >= tokenLiveAt;

  // ServiceGate.attemptClaim + claimThisDevice
  const claim = () => {
    if (!tokenLive()) {
      prefs.displaced = false;      // Failed clears it, deliberately
      return "Failed";
    }
    server.holder = me;
    prefs.displaced = false;
    return "Claimed";
  };

  // ServiceGate.stillMine
  const stillMine = () => {
    if (!tokenLive()) return true;  // cannot ask -> fails open, writes nothing
    const answer = server.holder === me;
    prefs.displaced = !answer;
    return answer;
  };

  // ServiceGate.holdsLogin
  const holdsLogin = (userId) => {
    if (prefs.claimedFor !== userId) {
      const outcome = claim();
      if (stampsOnFailure || outcome !== "Failed") prefs.claimedFor = userId;
      return outcome !== "KeyRequired" && outcome !== "KeyInvalid";
    }
    return stillMine();
  };

  // AutoSync.runSync: the displaced guard, then the token guard below it.
  // Both have to be passed before a pass moves anything, which is why the
  // token guard is modelled too -- without it, "got past the latch" would
  // read as "synced" on a phone that has no token yet.
  const runSync = () => {
    if (prefs.displaced) {
      const mineAgain = reAsks && tokenLive() && stillMine();
      if (!mineAgain) return false;
    }
    return tokenLive();
  };

  for (let p = 0; p < passes; p++) {
    attempt++;
    if (runsResumeCheck) holdsLogin("u1");
    if (runSync()) syncedOn.push(p);
  }
  return { syncedOn, prefs };
}

console.log("A. the two rules, read from the Kotlin and executed");

const gateSrc = read(SERVICE_GATE);
const syncSrc = read(AUTO_SYNC);

const stampRule = stampsClaimedForOnFailure(gateSrc);
const askRule = reAsksServerOnLatch(syncSrc);

// Readability first. A file this cannot parse reports zero problems for every
// case in it, which is the shape of audit-blind-spots.md.
ok("ServiceGate.holdsLogin's body is readable", stampRule.readable);
ok("AutoSync's displaced guard is readable", askRule.readable);
ok("holdsLogin does NOT record CLAIMED_FOR on a failed claim",
   stampRule.readable && stampRule.stamps === false,
   "the write must sit inside `if (outcome !is ClaimOutcome.Failed)`");
ok("AutoSync re-asks the server instead of trusting the stored latch",
   askRule.readable && askRule.reAsks === true);

// The reproduction. Phone B signs in while its token is not yet live (the
// first two attempts fail), and phone A legitimately holds the login.
const SCENARIO = { tokenLiveAt: 3, me: "deviceB", passes: 6 };

const live = runPhone({
  stampsOnFailure: stampRule.stamps === true,
  reAsks: askRule.reAsks === true,
  server: { holder: "deviceA" },
  ...SCENARIO,
});
ok("B2 repro: a phone whose first claim failed does eventually sync",
   live.syncedOn.length > 0,
   `synced on passes [${live.syncedOn.join(",")}]`);
ok("B2 repro: and it ends up holding the login, not latched displaced",
   live.prefs.displaced === false && live.prefs.claimedFor === "u1");

// The same model on the OLD rules. If this passes, nothing above has teeth.
const old = runPhone({
  stampsOnFailure: true,
  reAsks: false,
  server: { holder: "deviceA" },
  ...SCENARIO,
});
ok("canary: the OLD rules never sync at all (so the check above can fail)",
   old.syncedOn.length === 0,
   `old rules synced on [${old.syncedOn.join(",")}] — model no longer reproduces the bug`);
ok("canary: the OLD rules leave the phone latched displaced for ever",
   old.prefs.displaced === true);

// Each old rule on its own, so a future change that fixes one and loses the
// other cannot read as fine.
const onlyStampFixed = runPhone({
  stampsOnFailure: false, reAsks: false, server: { holder: "deviceA" }, ...SCENARIO,
});
ok("canary: fixing only the CLAIMED_FOR stamp already recovers the phone",
   onlyStampFixed.syncedOn.length > 0);
const onlyAskFixed = runPhone({
  stampsOnFailure: true, reAsks: true, server: { holder: "deviceA" }, ...SCENARIO,
});
ok("canary: fixing only the re-ask does NOT recover it (A still holds the login)",
   onlyAskFixed.syncedOn.length === 0,
   "the re-ask alone cannot help: this phone never claims, so stillMine is honestly false");

/* --- and now the things the fix must NOT have broken --------------------- */

const LIVE_RULES = {
  stampsOnFailure: stampRule.stamps === true,
  reAsks: askRule.reAsks === true,
};

// A phone that claims successfully syncs at once.
ok("a phone whose claim lands syncs on its first pass",
   runPhone({ ...LIVE_RULES, tokenLiveAt: 0, me: "deviceB",
              server: { holder: "deviceB" }, passes: 1 }).syncedOn.length === 1);

// A handset that has already claimed for this account, and has since been
// displaced, must stay stopped -- that is the whole point of the gate, and the
// re-ask added for B2 must not have turned it into a no-op. claimedFor is
// seeded, so holdsLogin takes the stillMine branch rather than re-claiming.
const stoppedForReal = runPhone({
  ...LIVE_RULES, tokenLiveAt: 0, me: "deviceA",
  server: { holder: "deviceB" },
  prefs: { claimedFor: "u1", displaced: true },
  passes: 3,
});
ok("a genuinely displaced handset stays stopped on every pass",
   stoppedForReal.syncedOn.length === 0 && stoppedForReal.prefs.displaced === true);

// The same handset with no token at all. It cannot ask, so it must not decide:
// the latch stands and nothing is pushed over the phone that holds the login.
const stoppedAndOffline = runPhone({
  ...LIVE_RULES, tokenLiveAt: 99, me: "deviceA",
  server: { holder: "deviceB" },
  prefs: { claimedFor: "u1", displaced: true },
  passes: 3,
});
ok("a displaced handset that cannot ask never clears the latch on its own",
   stoppedAndOffline.syncedOn.length === 0 && stoppedAndOffline.prefs.displaced === true);

// Taking the login back on this handset reopens it on the next pass.
const tookItBack = runPhone({
  ...LIVE_RULES, tokenLiveAt: 0, me: "deviceA",
  server: { holder: "deviceA" },
  prefs: { claimedFor: "u1", displaced: true },
  passes: 2,
});
ok("once the server says the login is this phone's again, it syncs",
   tookItBack.syncedOn.length === 2 && tookItBack.prefs.displaced === false);

/* --- the stranded latch, which is the "keeps saying" half of B2 ---------- */

// The phone whose service check cannot complete, so MainActivity's
// `fresh != null &&` short-circuit means holdsLogin is never run. The login is
// this phone's -- the server says so -- and the only thing standing between it
// and a sync is a preference nobody re-examines.
const STRANDED = {
  tokenLiveAt: 0, me: "deviceA",
  server: { holder: "deviceA" },
  prefs: { claimedFor: "u1", displaced: true },
  runsResumeCheck: false,
  passes: 4,
};

const strandedNow = runPhone({ ...LIVE_RULES, ...STRANDED });
ok("a stranded latch heals from inside AutoSync, with no help from the screen",
   strandedNow.syncedOn.length === 4 && strandedNow.prefs.displaced === false);

const strandedOld = runPhone({ stampsOnFailure: true, reAsks: false, ...STRANDED });
ok("canary: without the re-ask the latch outlives the truth for ever",
   strandedOld.syncedOn.length === 0,
   "the model no longer shows the stranded latch, so the check above is empty");

/* ===================================================================== B
   Structure, each claim with an in-memory canary.
   ===================================================================== */

console.log("");
console.log("B. structure, each with a canary that must go red");

/**
 * Runs a predicate over the real source and over a mutated copy, and reports
 * both. `breakIt` must return source that the predicate rejects, or the
 * predicate is not actually testing what its name says.
 */
function withCanary(name, src, predicate, breakIt) {
  ok(name, predicate(src) === true);
  const broken = breakIt(src);
  ok(`  canary: ${name}`, broken !== src && predicate(broken) === false,
     broken === src ? "the canary did not change the source" : "the check passed on broken source");
}

const ownershipSrc = read(OWNERSHIP);
const mainSrc = read(MAIN);
const pushSrc = read(CLAIM_PUSH);

// B1 -- the latch is observable, and every write keeps the flow in step.
withCanary(
  "ServiceGate exposes displacedNow as a StateFlow",
  gateSrc,
  (s) => /val\s+displacedNow\s*:\s*StateFlow<Boolean>\s*=\s*_displacedNow\.asStateFlow\(\)/.test(s),
  (s) => s.replace(/val\s+displacedNow\s*:\s*StateFlow<Boolean>/, "private val displacedNowGone: StateFlow<Boolean>"),
);

withCanary(
  "every stored-latch write keeps displacedNow in step",
  gateSrc,
  (s) => {
    // Each function that writes it[DISPLACED] must also touch _displacedNow.
    const writers = [...s.matchAll(/it\[DISPLACED\]\s*=/g)].map((m) => m.index);
    return writers.every((at) => {
      // The enclosing function, found by walking back to the previous
      // `fun ` at any indent -- not by line count.
      const head = s.lastIndexOf("fun ", at);
      if (head < 0) return false;
      const body = s.slice(head, s.indexOf("\n    }", at) + 6);
      return /_displacedNow\.value\s*=/.test(body);
    });
  },
  // The exact regression this guards: a write that updates the preference and
  // forgets the flow, so the screen says the opposite of the gate.
  (s) => s.replace(
    "    private suspend fun setDisplaced(context: Context, value: Boolean) {\n" +
    "        runCatching { context.serviceStore.edit { it[DISPLACED] = value } }\n" +
    "        _displacedNow.value = value\n" +
    "    }",
    "    private suspend fun setDisplaced(context: Context, value: Boolean) {\n" +
    "        runCatching { context.serviceStore.edit { it[DISPLACED] = value } }\n" +
    "    }",
  ),
);

withCanary(
  "MainActivity's blocked decision reads the background latch",
  mainSrc,
  (s) =>
    /ServiceGate\s*\n?\s*\.displacedNow\.collectAsState\(\)/.test(s) &&
    /val blocked = service\?\.allowed == false \|\| displacedEither/.test(s) &&
    /val displacedEither\s*=\s*\n?\s*displaced \|\| \(appSession\.signedIn && displacedInBackground\)/.test(s),
  // Back to reading only the on-resume check: the shape that made the
  // displaced phone notice "when next opened".
  (s) => s.replace(
    "val blocked = service?.allowed == false || displacedEither",
    "val blocked = service?.allowed == false || displaced",
  ),
);

withCanary(
  "the ServiceBlockedScreen is told the combined fact, not just the resume check",
  mainSrc,
  (s) => /displaced = displacedEither && service\?\.allowed != false,/.test(s),
  (s) => s.replace(
    "displaced = displacedEither && service?.allowed != false,",
    "displaced = displaced && service?.allowed != false,",
  ),
);

withCanary(
  "AutoSync syncs on the FALLING edge of the latch, not the rising one",
  syncSrc,
  (s) => {
    const c = code(s);
    if (!c.includes("var displacedBefore = ServiceGate.displacedNow.value")) return false;
    // The collector's own body, not a window of lines: a rising-edge
    // requestSync somewhere else in the file must not vouch for this one.
    const body = blockAfter(c, "ServiceGate.displacedNow.collect {");
    return body !== null &&
           /if \(displacedBefore && !nowDisplaced\) requestSync\(\)/.test(body);
  },
  (s) => s.replace(
    "if (displacedBefore && !nowDisplaced) requestSync()",
    "if (!displacedBefore && nowDisplaced) requestSync()",
  ),
);

withCanary(
  "wasDisplaced does NOT move displacedNow -- a remembered flag is not a verdict",
  gateSrc,
  (s) => {
    const c = code(s);
    const at = c.indexOf("suspend fun wasDisplaced(context: Context)");
    if (at < 0) return false;
    // Up to the next declaration -- NOT to the next KDoc, which is what this
    // check first tried: code() has already removed every comment, so there
    // was no `/**` left to stop at, the "body" ran to the end of the file and
    // the check was really asking whether the whole file mentions the flow. It
    // does, so it failed on correct source. Exactly the mistake this file
    // warns about two hundred lines up.
    //
    // The flow drives the block screen, and AutoSync reads this flag and THEN
    // re-asks the server: priming the flow from disk here would flash "Signed
    // in on another phone" for the length of that one RPC, on every pass whose
    // latch was merely stale.
    const next = c.indexOf("fun ", at + "suspend fun wasDisplaced".length);
    const body = c.slice(at, next < 0 ? c.length : next);
    return !/_displacedNow/.test(body);
  },
  (s) => s.replace(
    "    suspend fun wasDisplaced(context: Context): Boolean =\n" +
    "        runCatching { context.serviceStore.data.first()[DISPLACED] }.getOrNull() ?: false",
    "    suspend fun wasDisplaced(context: Context): Boolean {\n" +
    "        val latched = runCatching { context.serviceStore.data.first()[DISPLACED] }.getOrNull() ?: false\n" +
    "        _displacedNow.value = latched\n" +
    "        return latched\n" +
    "    }",
  ),
);

withCanary(
  "displacedNow is only ever written where a definite answer is known",
  gateSrc,
  (s) => {
    const c = code(s);
    // setDisplaced, reclaim's combined write, clear and forgetAccount -- and
    // nothing else. Any other writer is a place that could move the screen
    // without an answer from the server behind it.
    const writers = [...c.matchAll(/_displacedNow\.value\s*=/g)].map((m) => {
      const head = c.lastIndexOf("fun ", m.index);
      return c.slice(head, c.indexOf("(", head)).trim();
    });
    const allowed = ["fun setDisplaced", "fun reclaim", "fun clear", "fun forgetAccount"];
    return writers.length === 4 && writers.every((w) => allowed.includes(w));
  },
  // A writer on stillMine's failure path is the one change this file's header
  // forbids outright: it turns "could not tell" into "displaced".
  (s) => s.replace(
    "        }.getOrNull() ?: return true\n        setDisplaced(context, !answer)",
    "        }.getOrNull() ?: run { _displacedNow.value = true; return true }\n        setDisplaced(context, !answer)",
  ),
);

// B2 -- the sign-out funnel.
withCanary(
  "DataOwnership.onSignedOut forgets the account's gate state",
  ownershipSrc,
  (s) => {
    const body = blockAfter(code(s), "suspend fun onSignedOut(force: Boolean = false): Boolean {");
    return body !== null && /ServiceGate\.forgetAccount\(context\)/.test(body);
  },
  (s) => s.replace("ServiceGate.forgetAccount(context)", "// nothing"),
);

withCanary(
  "forgetAccount keeps DEVICE_ID -- this install's identity is not the account's",
  gateSrc,
  (s) => {
    const body = blockAfter(code(s), "suspend fun forgetAccount(context: Context) {");
    if (body === null) return false;
    return /prefs\.remove\(CLAIMED_FOR\)/.test(body) &&
           /prefs\.remove\(DISPLACED\)/.test(body) &&
           !/DEVICE_ID/.test(body) &&
           !/\.clear\(\)/.test(body);
  },
  // The lazy version: clear() wipes DEVICE_ID too, so a company requiring a
  // device key challenges this handset again after every sign-out.
  (s) => s.replace(
    /suspend fun forgetAccount\(context: Context\) \{[\s\S]*?\n    \}/,
    "suspend fun forgetAccount(context: Context) {\n" +
    "        runCatching { context.serviceStore.edit { it.clear() } }\n" +
    "    }",
  ),
);

// The property the whole gate is built around, re-asserted because both
// changes above touch the code that enforces it.
withCanary(
  "the nudge still never carries a verdict -- the phone asks the server",
  pushSrc,
  (s) =>
    /ServiceGate\.stillMine\(context\)/.test(s) &&
    /getOrDefault\(true\)/.test(s) &&
    /Verdict\.NOTHING_TO_DO/.test(s),
  (s) => s.replace("getOrDefault(true)", "getOrDefault(false)"),
);

withCanary(
  "a failed re-ask inside AutoSync's guard leaves the latch alone",
  syncSrc,
  (s) => {
    const body = blockAfter(code(s), "if (ServiceGate.wasDisplaced(context)) {");
    return body !== null &&
           /runCatching \{ ServiceGate\.stillMine\(context\) \}\.getOrDefault\(false\)/.test(body);
  },
  // getOrDefault(true) here would let a thrown read hand a stale handset the
  // right to start writing over the phone that holds the login now.
  (s) => s.replace(
    "runCatching { ServiceGate.stillMine(context) }.getOrDefault(false)",
    "runCatching { ServiceGate.stillMine(context) }.getOrDefault(true)",
  ),
);

console.log("");
console.log(failed === 0
  ? `${checked} of ${checked} checks passed`
  : `${failed} of ${checked} checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
