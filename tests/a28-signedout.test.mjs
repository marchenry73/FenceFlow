// A28 -- "I want to know when I am signed out. I did not know, and I was about
// to do a job."
//
// WHAT WAS WRONG (verified against the source, see the A28 report):
//   1. Losing the sign-in cleared the company id, so the one sync pass that
//      noticed said SIGNED_OUT and the NEXT pass (a minute later) overwrote it
//      with the quiet "working on this phone only" wording that a solo owner who
//      never had an account sees. The one state that must not fade, faded.
//   2. The job list's empty state was a plain "No jobs yet" with no sync card
//      and no sign-in warning anywhere near it -- so an empty list meant signed
//      out, no signal and could-not-find-out all at once, and said none of them.
//   3. A profile read that came back empty because the session had just gone was
//      read as "this account belongs to no company", which forgets the company
//      and runs the no-company wipe: an empty job list, nothing on screen.
//   4. A question that got no answer (the plugin still loading, no token in
//      hand) was recorded as nothing, which looks identical to a healthy phone.
//
// WHAT THIS FILE IS. Two kinds of check, both proven able to fail:
//   (a) BEHAVIOUR. The decisions live in one pure block of SessionManager.kt;
//       tests/a28-signedout-model.mjs reads that block out of the real file and
//       runs it, so these assertions are about the code that ships, not a copy.
//   (b) WIRING. Static reads of the four Kotlin files and three strings files
//       that pin where the verdict is recorded, drawn and worded.
// Every group has a TEETH section: the checker is run against a scratch copy
// with the exact defect put back, and must go red. A checker that has never been
// seen to fail has not been tested, only run.
//
// It does not compile Kotlin. The one-off differential run recorded in the
// report compiled the pure block with the real Kotlin compiler and compared it,
// row for row, with this translation.
//
// Run: node tests/a28-signedout.test.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPure, loadModel, allInputs } from "./a28-signedout-model.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`); }
};

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const P = {
  session: "app/src/main/java/com/fenceestimator/app/cloud/SessionManager.kt",
  autosync: "app/src/main/java/com/fenceestimator/app/cloud/AutoSync.kt",
  jobs: "app/src/main/java/com/fenceestimator/app/ui/jobs/JobsListScreen.kt",
  account: "app/src/main/java/com/fenceestimator/app/ui/account/AccountScreen.kt",
  en: "app/src/main/res/values/strings.xml",
  es: "app/src/main/res/values-es/strings.xml",
  fr: "app/src/main/res/values-fr/strings.xml",
};
const SRC = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, read(v)]));
const count = (hay, needle) => hay.split(needle).length - 1;

/** Replace exactly one occurrence, or say the mutation target has drifted. */
function mutate(text, oldS, newS, label) {
  const n = count(text, oldS);
  if (n !== 1) throw new Error(`mutation "${label}": expected exactly one match, found ${n}`);
  return text.replace(oldS, () => newS);
}

// ===========================================================================
// 0. POSITIVE CONTROLS
// ===========================================================================
console.log("\n0. positive controls:");
const PURE = extractPure(SRC.session);
const MODEL = loadModel(PURE);
{
  ok("the source files are non-trivial (a truncated read would false-pass everything below)",
    SRC.session.length > 20_000 && SRC.autosync.length > 40_000 && SRC.jobs.length > 40_000 && SRC.account.length > 30_000,
    `lengths ${SRC.session.length}/${SRC.autosync.length}/${SRC.jobs.length}/${SRC.account.length}`);
  ok("the pure block was found between its markers and translated",
    PURE.length > 1000 && MODEL.sigs.length >= 6, `block ${PURE.length} chars, ${MODEL.sigs.length} functions`);
  ok("it holds the functions this file tests",
    ["judgeLogin", "classifyProfileRead", "hadAnAccount", "lostSignIn", "loginNotice", "jobsEmptyKind"]
      .every((n) => typeof MODEL.api[n] === "function"));
  ok("LoginHealth has the five values (the three verdicts, the network split, and CHECKING)",
    JSON.stringify(MODEL.enums.LoginHealth) ===
      JSON.stringify(["CHECKING", "WORKING", "SIGNED_OUT", "NO_SIGNAL", "COULD_NOT_TELL"]));
  let inputs = 0;
  for (const sig of MODEL.sigs) for (const _ of allInputs(MODEL, sig)) inputs++;
  ok("the enumeration really considers inputs (0 considered would be a broken scan, not a clean one)",
    inputs > 200, `${inputs} inputs`);

  // CANARY: the reader must REFUSE Kotlin it cannot run, or it would quietly
  // test nothing the day somebody rewrites the block.
  const refuses = (block) => { try { loadModel(block); return false; } catch { return true; } };
  const wrap = (body) => `enum class E { A, B }\nfun f(x: Boolean): E {\n${body}\n}\n`;
  ok("CANARY: a when-expression is refused, not skipped",
    refuses(wrap("    return when (x) { true -> E.A\n false -> E.B }")));
  ok("CANARY: a string literal is refused",
    refuses(wrap('    if (x) return E.A\n    return E.B') + 'const val S = "x"'));
  ok("CANARY: a body that can fall off the end is refused",
    refuses(wrap("    if (x) return E.A")));
  ok("CANARY: an unknown identifier is refused",
    refuses(wrap("    if (mystery) return E.A\n    return E.B")));
  ok("CANARY: a plain valid block IS accepted (the refusals above are not a reader that refuses everything)",
    !refuses(wrap("    if (x) return E.A\n    return E.B")));
}

// ===========================================================================
// 1. BEHAVIOUR -- one battery, run against the real rules and against mutants
// ===========================================================================
const G = MODEL.consts.LOGIN_UNSURE_GRACE_MS;

/** Every behavioural claim, as a list of [label, passed] for one implementation. */
function battery(api, enums) {
  const out = [];
  const t = (label, cond) => out.push([label, !!cond]);
  const { judgeLogin, classifyProfileRead, hadAnAccount, lostSignIn, loginNotice, jobsEmptyKind } = api;
  const H = enums.LoginHealth;
  const bools = [false, true];
  const units = [0, G - 1, G, G + 1];

  // ---- A. three states, three different messages
  const signedOut = loginNotice("SIGNED_OUT", false, true, false, 0);
  const noSignal = loginNotice("NO_SIGNAL", false, true, false, 0);
  const unsure = loginNotice("COULD_NOT_TELL", false, true, false, G);
  t("A1 signed out (and had an account) tells the person to sign in", signedOut === "SIGNED_OUT");
  t("A2 no signal reads as no signal", noSignal === "NO_SIGNAL");
  t("A3 could-not-tell, online, past the grace, reads as could-not-tell", unsure === "COULD_NOT_TELL");
  t("A4 the three are three DIFFERENT notices, and none of them is 'nothing'",
    new Set([signedOut, noSignal, unsure]).size === 3 && ![signedOut, noSignal, unsure].includes("NONE"));
  t("A5 offline plus an unverified sign-in is NO SIGNAL, never could-not-tell",
    units.every((u) => loginNotice("COULD_NOT_TELL", true, true, false, u) === "NO_SIGNAL"));
  t("A6 the verdict itself separates the three: gone / network / no answer",
    judgeLogin("NOT_AUTHENTICATED", false, "NOT_ASKED") === "SIGNED_OUT" &&
    judgeLogin("REFRESH_NO_NETWORK", true, "NOT_ASKED") === "NO_SIGNAL" &&
    judgeLogin("REFRESH_SERVER_ERROR", true, "NOT_ASKED") === "COULD_NOT_TELL");
  t("A7 the window that caused this bug -- signed in, NO TOKEN -- is could-not-tell, whatever the profile says",
    ["NOT_ASKED", "FOUND", "NO_COMPANY", "FAILED_NO_NETWORK", "FAILED_OTHER"]
      .every((p) => judgeLogin("AUTHENTICATED", false, p) === "COULD_NOT_TELL"));
  t("A8 the plugin still loading is could-not-tell, not fine",
    ["NOT_ASKED", "FOUND", "NO_COMPANY"].every((p) => judgeLogin("INITIALIZING", true, p) === "COULD_NOT_TELL"));
  // The property that makes the third state impossible to collapse: WORKING is
  // reachable by exactly one road.
  let workingOnlyWhenProven = true;
  for (const status of enums.AuthStatusKind) for (const token of bools) for (const p of enums.ProfileRead) {
    const working = judgeLogin(status, token, p) === "WORKING";
    const proven = status === "AUTHENTICATED" && token && (p === "FOUND" || p === "NO_COMPANY");
    if (working !== proven) workingOnlyWhenProven = false;
  }
  t("A9 WORKING if and only if: authenticated, holding a token, and the profile read answered",
    workingOnlyWhenProven);

  // ---- B. an anonymous empty read is never 'no company' and never 'no jobs'
  t("B1 an empty profile read with no token afterwards is NOT 'no company'",
    classifyProfileRead(true, false, false, false, true) === "FAILED_OTHER");
  t("B2 an empty profile read after the login changed is NOT 'no company'",
    classifyProfileRead(true, false, false, true, false) === "FAILED_OTHER");
  t("B3 an empty read WITH the token still held and the same login IS 'no company' (the legitimate answer survives)",
    classifyProfileRead(true, false, false, true, true) === "NO_COMPANY");
  t("B4 a row that came back proves itself, even if the token is gone by now",
    classifyProfileRead(true, true, false, false, false) === "FOUND");
  let neverNoCompanyOnUnprovenEmpty = true;
  for (const a of bools) for (const f of bools) for (const n of bools) for (const h of bools) for (const s of bools) {
    const r = classifyProfileRead(a, f, n, h, s);
    if (r === "NO_COMPANY" && !(a && !f && h && s)) neverNoCompanyOnUnprovenEmpty = false;
    if (r === "FOUND" && !(a && f)) neverNoCompanyOnUnprovenEmpty = false;
  }
  t("B5 'no company' is reachable only from an answered, empty, token-held, same-login read",
    neverNoCompanyOnUnprovenEmpty);
  t("B6 a failed read on a dead network is the network, any other failure is not",
    classifyProfileRead(false, false, true, true, true) === "FAILED_NO_NETWORK" &&
    classifyProfileRead(false, false, false, true, true) === "FAILED_OTHER");
  // End to end, the way refresh() chains them: anonymous empty read -> verdict -> notice -> job list.
  {
    const read = classifyProfileRead(true, false, false, false, true);
    const health = judgeLogin("AUTHENTICATED", false, read);
    const notice = loginNotice(health, false, true, false, G);
    const kind = jobsEmptyKind(true, notice);
    t("B7 anonymous empty read -> could-not-tell -> the list says 'could not load', not 'no jobs'",
      health === "COULD_NOT_TELL" && notice === "COULD_NOT_TELL" && kind === "COULD_NOT_LOAD" && kind !== "ORDINARY");
  }
  t("B8 an empty list is the ordinary 'No jobs yet' if and only if there is nothing to say about the sign-in",
    enums.LoginNotice.every((n) => (jobsEmptyKind(true, n) === "ORDINARY") === (n === "NONE")));
  t("B9 a signed-out empty list says signed out; a could-not-tell one says could not load",
    jobsEmptyKind(true, "SIGNED_OUT") === "SIGNED_OUT" && jobsEmptyKind(true, "COULD_NOT_TELL") === "COULD_NOT_LOAD" &&
    jobsEmptyKind(true, "NO_SIGNAL") === "NO_SIGNAL");
  t("B10 a list with jobs in it is just the list, whatever the notice",
    enums.LoginNotice.every((n) => jobsEmptyKind(false, n) === "LIST"));

  // ---- C. no alarm for the legitimate cases
  t("C1 a signed-in phone with a working login says nothing, in every circumstance",
    bools.every((off) => bools.every((had) => bools.every((g) => units.every((u) =>
      loginNotice("WORKING", off, had, g, u) === "NONE")))));
  t("C2 a legitimately EMPTY job list on a working login is the ordinary empty state",
    jobsEmptyKind(true, loginNotice("WORKING", false, true, false, 0)) === "ORDINARY");
  t("C3 a working phone that is merely offline is not alarmed (work saved, will upload)",
    loginNotice("WORKING", true, true, false, G * 10) === "NONE");
  t("C4 offline never produces the loud could-not-tell notice, for any verdict and any age",
    enums.LoginHealth.every((h) => bools.every((had) => bools.every((g) => units.every((u) =>
      loginNotice(h, true, had, g, u) !== "COULD_NOT_TELL")))));
  t("C5 a phone that NEVER had an account (a solo owner on their own phone) is never told it is signed out",
    bools.every((off) => bools.every((g) => units.every((u) =>
      loginNotice("SIGNED_OUT", off, false, g, u) === "NONE"))));
  t("C6 the guest demo is never warned, whatever the verdict",
    enums.LoginHealth.every((h) => bools.every((off) => bools.every((had) => units.every((u) =>
      loginNotice(h, off, had, true, u) === "NONE")))));
  t("C7 CHECKING says nothing: no flash at every launch",
    bools.every((off) => bools.every((had) => units.every((u) => loginNotice("CHECKING", off, had, false, u) === "NONE"))));
  t("C8 could-not-tell is held back for the grace period, then shown",
    loginNotice("COULD_NOT_TELL", false, true, false, G - 1) === "NONE" &&
    loginNotice("COULD_NOT_TELL", false, true, false, G) === "COULD_NOT_TELL");
  let loudOnlyWhenEarned = true;
  for (const h of enums.LoginHealth) for (const off of bools) for (const had of bools) for (const g of bools) for (const u of units) {
    const n = loginNotice(h, off, had, g, u);
    if (n === "SIGNED_OUT" && !(h === "SIGNED_OUT" && had && !g)) loudOnlyWhenEarned = false;
    if (n === "COULD_NOT_TELL" && !(h === "COULD_NOT_TELL" && !off && !g && u >= G)) loudOnlyWhenEarned = false;
  }
  t("C9 each loud notice appears only when earned (signed out: lost an account; could-not-tell: online, unanswered, past grace)",
    loudOnlyWhenEarned);
  t("C10 lostSignIn is true only for a signed-out phone that had an account and is not the demo",
    enums.LoginHealth.every((h) => bools.every((had) => bools.every((g) =>
      lostSignIn(h, had, g) === (h === "SIGNED_OUT" && had && !g)))));
  t("C11 'had an account' is any one of: signed in, holding company data, remembering an address",
    bools.every((a) => bools.every((b) => bools.every((c) => hadAnAccount(a, b, c) === (a || b || c)))));
  return out;
}

console.log("\n1. behaviour of the real rules:");
const REAL = battery(MODEL.api, MODEL.enums);
for (const [label, passed] of REAL) ok(label, passed);
ok("the battery really considered claims (not a vacuous empty list)", REAL.length >= 30, `${REAL.length} claims`);

// ===========================================================================
// 2. TEETH -- put each defect back in a scratch copy; the battery must go red
// ===========================================================================
console.log("\n2. teeth -- each defect restored in a scratch copy of the block turns the battery red:");
{
  const mutants = [
    ["the owner's own phrasing: COULD NOT TELL collapsed back into 'fine' in the notice",
      "    return LoginNotice.COULD_NOT_TELL\n", "    return LoginNotice.NONE\n"],
    ["COULD NOT TELL collapsed into 'fine' in the verdict: no-token window reads as working",
      "    if (!hasToken) return LoginHealth.COULD_NOT_TELL\n", ""],
    ["COULD NOT TELL collapsed into 'fine' in the verdict: plugin still loading reads as working",
      "    if (status == AuthStatusKind.INITIALIZING) return LoginHealth.COULD_NOT_TELL\n",
      "    if (status == AuthStatusKind.INITIALIZING) return LoginHealth.WORKING\n"],
    ["COULD NOT TELL collapsed into 'fine' in the verdict: the fall-through (a case nobody thought of) reads as working",
      "    if (profile == ProfileRead.FAILED_NO_NETWORK) return LoginHealth.NO_SIGNAL\n    return LoginHealth.COULD_NOT_TELL\n",
      "    if (profile == ProfileRead.FAILED_NO_NETWORK) return LoginHealth.NO_SIGNAL\n    return LoginHealth.WORKING\n"],
    ["an anonymous empty read is believed: 'no company' with no token afterwards",
      "    if (!holdingTokenAfter) return ProfileRead.FAILED_OTHER\n", ""],
    ["an empty read is believed even though the login changed under it",
      "    if (!sameLoginAfter) return ProfileRead.FAILED_OTHER\n", ""],
    ["over-warning: an offline phone is told it could not check",
      "    if (offline) return LoginNotice.NO_SIGNAL\n", ""],
    ["over-warning: a solo owner who never had an account is told they are signed out",
      "    if (!hadAccount) return false\n", ""],
    ["over-warning: a flash at every launch (the grace period removed)",
      "    if (unsureForMs < LOGIN_UNSURE_GRACE_MS) return LoginNotice.NONE\n", ""],
    ["over-warning: the guest demo is warned",
      "    if (guestDemo) return LoginNotice.NONE\n    if (lostSignIn", "    if (lostSignIn"],
    ["the empty list reads as 'No jobs yet' when signed out",
      "    if (notice == LoginNotice.SIGNED_OUT) return JobsEmpty.SIGNED_OUT\n", ""],
    ["the empty list reads as 'No jobs yet' when the phone could not tell",
      "    if (notice == LoginNotice.COULD_NOT_TELL) return JobsEmpty.COULD_NOT_LOAD\n", ""],
    ["no signal and could-not-tell share one notice",
      "    if (health == LoginHealth.NO_SIGNAL) return LoginNotice.NO_SIGNAL\n",
      "    if (health == LoginHealth.NO_SIGNAL) return LoginNotice.COULD_NOT_TELL\n"],
  ];
  for (const [label, oldS, newS] of mutants) {
    let result = "mutation did not apply";
    try {
      const mutated = mutate(PURE, oldS, newS, label);
      const m = loadModel(mutated);
      const failed = battery(m.api, m.enums).filter(([, p]) => !p).map(([l]) => l.split(" ")[0]);
      result = failed.length > 0 ? `red on ${failed.join(",")}` : "STAYED GREEN";
      ok(`TEETH: ${label}  [${result}]`, failed.length > 0, result);
    } catch (e) {
      ok(`TEETH: ${label}`, false, e.message);
    }
  }
  ok("TEETH control: the unmutated block is green on the same battery", REAL.every(([, p]) => p));
}

// ===========================================================================
// 3. WIRING -- where the verdict is recorded, drawn and worded
// ===========================================================================
const strings = (xml) => {
  const m = new Map();
  for (const x of xml.matchAll(/<string name="(so_[a-z_]+)"[^>]*>([\s\S]*?)<\/string>/g)) m.set(x[1], x[2].trim());
  return m;
};

function slice(text, startNeedle, endNeedle) {
  const a = text.indexOf(startNeedle);
  if (a === -1) return null;
  const b = endNeedle ? text.indexOf(endNeedle, a + startNeedle.length) : text.length;
  return b === -1 ? null : text.slice(a, b);
}

/** All wiring claims over a set of source texts, as [label, passed] pairs. */
function wiring(src) {
  const out = [];
  const t = (label, cond) => out.push([label, !!cond]);
  const { session, autosync, jobs, account } = src;

  // ---- SessionManager
  t("S1 SessionState carries the verdict, when it changed, and whether the phone ever had an account",
    /val login: LoginHealth = LoginHealth\.CHECKING/.test(session) &&
    /val loginSince: Long = 0L/.test(session) && /val hadAccount: Boolean = false/.test(session));
  t("S2 the verdict is stamped in the `current` setter, so no refresh branch can forget it",
    /_state\.value = value\.copy\([\s\S]{0,260}login = loginHealth[\s\S]{0,120}hadAccount = hadAccountNow/.test(session));
  const settle = slice(session, "if (settled == null) {", "return@launch");
  t("S3 a settle timeout RECORDS could-not-tell instead of returning having said nothing",
    settle !== null && settle.includes("publishLogin(judgeLogin(AuthStatusKind.INITIALIZING"));
  const signedOutBranch = slice(session, "if (email == null) {", "return@launch");
  t("S4 the signed-out branch records the account history and the verdict, and still forgets the cache",
    signedOutBranch !== null && signedOutBranch.includes("noteAccountEvidence(") &&
    signedOutBranch.includes("noteLogin(judgeLogin(AuthStatusKind.NOT_AUTHENTICATED") &&
    signedOutBranch.includes("CachedIdentity.clear"));
  t("S5 'this account belongs to no company' needs a VERIFIED empty answer (ProfileRead.NO_COMPANY)",
    session.includes("} else if (read == ProfileRead.NO_COMPANY) {") &&
    !session.includes("} else if (fetched.isSuccess && profile == null) {"));
  const wipeHook = session.indexOf("dataOwnership?.onSignedInWithoutCompany()");
  const gate = session.lastIndexOf("if (", session.lastIndexOf("runCatching {", wipeHook));
  t("S6 the no-company wipe hook is gated on a trusted answer, not on 'the call did not throw'",
    wipeHook > 0 && session.slice(gate, gate + 40).startsWith("if (answered) runCatching {"));
  t("S7 the empty answer is checked against the token held AFTER the read, and a vanished login restarts the pass",
    session.includes("val tokenAfter = SupabaseModule.hasLiveSession()") &&
    /classifyProfileRead\(\s*answered = fetched\.isSuccess,[\s\S]{0,400}holdingTokenAfter = tokenAfter,\s*sameLoginAfter = sameLoginAfter/.test(session) &&
    /if \(!sameLoginAfter\) \{[\s\S]{0,300}refresh\(\)\s*return@launch/.test(session));
  t("S8 an untrusted answer is retried like a failed one",
    session.includes("if (!answered) scheduleAccessRetry()") && !session.includes("if (fetched.isFailure) scheduleAccessRetry()"));
  t("S9 the plugin is watched for the life of the process, from refresh()",
    session.includes("SupabaseModule.sessionStatus.collect") && /fun refresh\(\) \{[\s\S]{0,140}watchAuthStatus\(\)/.test(session));
  const kind = slice(session, "internal fun authStatusKind(", "/** The auth plugin's status right now");
  t("S10 the plugin's status is mapped exhaustively, with no else to hide a new case behind",
    kind !== null && !/\belse\s*->/.test(kind) && ["Initializing", "NotAuthenticated", "Authenticated", "RefreshFailure"].every((c) => kind.includes(`SessionStatus.${c}`)));
  t("S11 a server error from the auth plugin is could-not-tell, NOT signed out",
    kind !== null && /NetworkError\)\s*AuthStatusKind\.REFRESH_NO_NETWORK\s*else AuthStatusKind\.REFRESH_SERVER_ERROR/.test(kind));
  t("S12 the demo's company stamp is not an account",
    session.includes("owner != DataOwnership.GUEST_DEMO_OWNER"));
  // The pins other (Gradle) tests hold on this file, replicated here because they cannot be run from here.
  {
    const saveIdx = session.indexOf("CachedIdentity.save");
    const guard = session.lastIndexOf("fetched.isSuccess", saveIdx);
    t("S13 (existing pin) CachedIdentity.save still sits inside a branch that checked the fetch succeeded",
      saveIdx > 0 && guard > 0 && guard < saveIdx);
    const start = session.indexOf("if (email == null) {");
    const end = session.indexOf("return@launch", start);
    t("S14 (existing pin) the signed-out branch still contains CachedIdentity.clear before its return",
      start >= 0 && end > start && session.slice(start, end).includes("CachedIdentity.clear"));
    t("S15 (existing pin) the device-token registration block is untouched",
      /if \(profile\?\.companyId != null\) \{\s*pushTokenProvider\?\.invoke\(\)\?\.let \{ token ->\s*runCatching \{ SupabaseModule\.registerDeviceToken\(token\) \}/.test(session));
  }
  {
    const retire = session.indexOf("if (loginHealth == LoginHealth.SIGNED_OUT) publishLogin(LoginHealth.CHECKING)");
    t("S16 a sign-in that reappears retires the old SIGNED_OUT verdict at once -- no 'signed out' banner over a phone that has just signed in",
      retire > session.indexOf("if (email == null) {") && retire < session.indexOf("val cached = appContext?.let"));
  }

  // ---- AutoSync
  const noCompany = slice(autosync, "if (companyId == null) {", "return\n        }");
  t("A-S1 with no company id, a phone that LOST its sign-in reports SIGNED_OUT -- it does not fade to 'this phone only'",
    noCompany !== null && noCompany.includes("lostSignIn(s.login, s.hadAccount, s.guestDemo)") &&
    /phase = if \(lost\) SyncPhase\.SIGNED_OUT else SyncPhase\.OFFLINE_ONLY/.test(noCompany));
  const lateCheck = autosync.indexOf("if (!SupabaseModule.hasLiveSession()) {", autosync.indexOf("val entityError ="));
  const errBranch = autosync.indexOf("if (entityError != null) {");
  t("A-S2 a pass that lost its token part-way does not report a clean sync (checked after the work, before the verdict)",
    lateCheck > 0 && errBranch > lateCheck && /return@withLock/.test(autosync.slice(lateCheck, errBranch)));
  t("A-S3 the loss is acted on the moment it happens (a collector on the session's verdict)",
    /session\.state\s*\.map \{ it\.login to lostSignIn\(it\.login, it\.hadAccount, it\.guestDemo\) \}\s*\.distinctUntilChanged\(\)\s*\.collect \{ \(health, lost\) -> onLoginChanged\(health, lost\) \}/.test(autosync));
  const onChanged = slice(autosync, "private suspend fun onLoginChanged(", "\n    /**");
  t("A-S4 a notification only when the app is NOT on screen, once per loss, taken down when the sign-in returns",
    onChanged !== null && onChanged.includes("!inForeground && !signedOutNotified") &&
    onChanged.includes("R.string.so_ntf_title") && onChanged.includes("R.string.so_ntf_body") &&
    /health == LoginHealth\.WORKING && signedOutNotified/.test(onChanged) && onChanged.includes(".cancel(SIGNED_OUT_NOTIFICATION_ID)"));
  t("A-S5 an auth-server outage is never reported as 'signed out' by the sync card (only the plugin saying the session is gone is)",
    autosync.includes("val signedOut = outcome == SupabaseModule.RefreshOutcome.SIGNED_OUT &&\n" +
      "                    currentAuthStatusKind() != AuthStatusKind.REFRESH_SERVER_ERROR"));

  // ---- JobsListScreen
  t("J1 the jobs list reads the shared notice",
    jobs.includes("val notice = rememberLoginNotice()"));
  const banner = jobs.indexOf("LoginNoticeBanner(\n            notice = notice,");
  const ptr = jobs.indexOf("PullToRefreshBox(\n            isRefreshing = refreshing");
  const lazy = jobs.indexOf("LazyColumn(");
  t("J2 the banner is drawn ABOVE and OUTSIDE the scrolling list, so it cannot be scrolled past",
    banner > 0 && ptr > banner && lazy > ptr);
  const bannerFn = slice(jobs, "internal fun LoginNoticeBanner(", "/**\n * The job list area when there is no list to show");
  t("J3 the banner has no way to be dismissed (it is sticky: it goes away only when the cause does)",
    bannerFn !== null && !/dismiss/i.test(bannerFn) && !/mutableStateOf/.test(bannerFn) && !/remember\s*\{/.test(bannerFn));
  t("J4 the banner is announced to accessibility services as an assertive live region",
    bannerFn !== null && bannerFn.includes("LiveRegionMode.Assertive"));
  t("J5 the empty state asks the pure rule, and the plain 'No jobs yet' text exists in exactly one place",
    jobs.includes("val emptyKind = jobsEmptyKind(jobs.isEmpty() && nothingToSay, notice)") &&
    jobs.includes("EmptyJobsMessage(emptyKind, session.canEditJobs)") && count(jobs, "R.string.jobs_no_jobs") === 1);
  const emptyFn = slice(jobs, "private fun EmptyJobsMessage(", "\n}\n");
  t("J6 'No jobs yet' is reachable only from the ORDINARY branch of the empty state",
    emptyFn !== null && /JobsEmpty\.ORDINARY, JobsEmpty\.LIST ->\s*(?:\/\/[^\n]*\n\s*)*stringResource\(R\.string\.jobs_no_jobs\)/.test(emptyFn));
  const titleFn = slice(jobs, "internal fun loginNoticeTitle(", "\n}\n");
  const bodyFn = slice(jobs, "internal fun loginNoticeBody(", "\n}\n");
  const mapOf = (fn) => {
    const m = {};
    if (fn) for (const x of fn.matchAll(/LoginNotice\.(\w+)\s*->\s*(?:stringResource\(R\.string\.(\w+)\)|"")/g)) m[x[1]] = x[2] ?? "";
    return m;
  };
  const titles = mapOf(titleFn), bodies = mapOf(bodyFn);
  t("J7 every notice has a headline and a body, in an exhaustive when with no else",
    titleFn !== null && bodyFn !== null && !/\belse\s*->/.test(titleFn + bodyFn) &&
    ["NONE", "SIGNED_OUT", "NO_SIGNAL", "COULD_NOT_TELL"].every((n) => n in titles && n in bodies));
  t("J8 the three loud-or-informative notices use three DIFFERENT headline strings and three different bodies",
    new Set([titles.SIGNED_OUT, titles.NO_SIGNAL, titles.COULD_NOT_TELL]).size === 3 &&
    new Set([bodies.SIGNED_OUT, bodies.NO_SIGNAL, bodies.COULD_NOT_TELL]).size === 3 &&
    [titles.SIGNED_OUT, titles.NO_SIGNAL, titles.COULD_NOT_TELL, bodies.SIGNED_OUT, bodies.NO_SIGNAL, bodies.COULD_NOT_TELL].every(Boolean));
  const emptyMap = {};
  if (emptyFn) for (const x of emptyFn.matchAll(/JobsEmpty\.(\w+)(?:, JobsEmpty\.\w+)?\s*->\s*(?:\/\/[^\n]*\n\s*)*stringResource\(R\.string\.(\w+)\)/g)) emptyMap[x[1]] = x[2];
  t("J9 the empty state has its own wording for signed out, could-not-load and no-signal, none of them 'No jobs yet'",
    new Set([emptyMap.SIGNED_OUT, emptyMap.COULD_NOT_LOAD, emptyMap.NO_SIGNAL, emptyMap.ORDINARY]).size === 4 &&
    ["SIGNED_OUT", "COULD_NOT_LOAD", "NO_SIGNAL"].every((k) => (emptyMap[k] ?? "").startsWith("so_empty_")));
  t("J10 the sync card does not repeat what the banner already says",
    jobs.includes("val bannerCovers =") && jobs.includes("if (!bannerCovers && (sync.hasUnsyncedWork ||"));
  t("J11 nothing on the list shows a price the old way (the money gate this file already carries is untouched)",
    !jobs.split("\n").some((l) => l.trim().startsWith("trailingText =") && l.includes("Money.") && !l.includes("session.canSeeMoney")));

  // ---- AccountScreen
  const firstItem = account.indexOf("LoginNoticeBanner(");
  const signedOutItem = account.indexOf("item { SignedOutSection(state, viewModel) }");
  t("ACC1 the Account screen draws the same banner, first, from the same notice",
    account.includes("val notice = rememberLoginNotice()") && firstItem > 0 && signedOutItem > firstItem &&
    account.includes("notice == LoginNotice.SIGNED_OUT || notice == LoginNotice.COULD_NOT_TELL"));
  t("ACC2 the Account screen follows the app-wide sign-in instead of reading it once when it opened",
    /LaunchedEffect\(session\.login\) \{[\s\S]{0,260}viewModel\.refresh\(\)/.test(account));

  // ---- strings
  const en = strings(src.en), es = strings(src.es), fr = strings(src.fr);
  const used = new Set();
  for (const text of [session, autosync, jobs, account]) for (const m of text.matchAll(/R\.string\.(so_[a-z_]+)/g)) used.add(m[1]);
  t("STR1 every so_ string the code uses exists in English, Spanish and French",
    used.size >= 10 && [...used].every((k) => en.has(k) && es.has(k) && fr.has(k)),
    `used ${used.size}; missing ${[...used].filter((k) => !(en.has(k) && es.has(k) && fr.has(k))).join(",")}`);
  t("STR2 no so_ string is defined and never used (no dead wording)",
    [...en.keys()].every((k) => used.has(k)));
  t("STR3 Spanish and French are translated, not left in English",
    [...used].every((k) => es.get(k) !== en.get(k) && fr.get(k) !== en.get(k)));
  const waiting = (xml) => xml.match(/name="acct_sync_waiting_for_signal">([^<]*)</)?.[1];
  t("STR4 the three headlines differ from each other in every language",
    [[en, src.en], [es, src.es], [fr, src.fr]].every(([m, xml]) =>
      waiting(xml) && new Set([m.get("so_out_title"), m.get("so_unsure_title"), waiting(xml)]).size === 3));
  t("STR5 the signed-out wording says what it MEANS for work, in a contractor's terms: office, this phone, sign in",
    /office/i.test(en.get("so_out_body") ?? "") && /this phone/i.test(en.get("so_out_body") ?? "") && /sign in/i.test(en.get("so_out_body") ?? ""));
  return out;
}

console.log("\n3. wiring of the real source:");
const WIRE = wiring({ ...SRC });
for (const [label, passed] of WIRE) ok(label, passed);
ok("the wiring checker considered claims (not a vacuous empty list)", WIRE.length >= 35, `${WIRE.length} claims`);

// Nobody else reads the verdict: a new reader must go through loginNotice() or lostSignIn().
{
  const hits = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".kt") && /\.login\b/.test(readFileSync(p, "utf8"))) hits.push(p.slice(ROOT.length).replace(/\\/g, "/"));
    }
  };
  walk(join(ROOT, "app/src/main/java"));
  const allowed = [P.session, P.autosync, P.jobs, P.account];
  ok("only the four files that own the verdict read SessionState.login directly (anyone new goes through loginNotice)",
    hits.length > 0 && hits.every((h) => allowed.includes(h)), `readers: ${hits.join(", ")}`);
}

// ===========================================================================
// 4. TEETH for the wiring
// ===========================================================================
console.log("\n4. teeth for the wiring -- each defect restored in a scratch copy turns a claim red:");
{
  const realGreen = WIRE.every(([, p]) => p);
  ok("TEETH control: the real source is green on every wiring claim", realGreen,
    WIRE.filter(([, p]) => !p).map(([l]) => l.split(" ")[0]).join(","));
  const cases = [
    ["a verified-empty answer is no longer required for 'no company' (the wipe hazard back)", "session",
      "} else if (read == ProfileRead.NO_COMPANY) {", "} else if (fetched.isSuccess && profile == null) {", ["S5"]],
    ["the no-company wipe hook is gated on 'did not throw' again", "session",
      "            if (answered) runCatching {\n                val wiped =", "            if (fetched.isSuccess) runCatching {\n                val wiped =", ["S6"]],
    ["the settle timeout goes back to saying nothing", "session",
      "                publishLogin(judgeLogin(AuthStatusKind.INITIALIZING, false, ProfileRead.NOT_ASKED))\n", "", ["S3"]],
    ["a sign-in that reappears leaves the old signed-out verdict standing until the profile read returns", "session",
      "            if (loginHealth == LoginHealth.SIGNED_OUT) publishLogin(LoginHealth.CHECKING)\n", "", ["S16"]],
    ["a server error from the auth plugin is read as signed out", "session",
      "AuthStatusKind.REFRESH_NO_NETWORK\n        else AuthStatusKind.REFRESH_SERVER_ERROR", "AuthStatusKind.REFRESH_NO_NETWORK\n        else AuthStatusKind.NOT_AUTHENTICATED", ["S11"]],
    ["the verdict stops being stamped in the setter (a refresh would wipe it)", "session",
      "                login = loginHealth,\n", "", ["S2"]],
    ["a lost sign-in fades back to 'this phone only'", "autosync",
      "phase = if (lost) SyncPhase.SIGNED_OUT else SyncPhase.OFFLINE_ONLY,", "phase = SyncPhase.OFFLINE_ONLY,", ["A-S1"]],
    ["a server outage is reported as signed out again", "autosync",
      " &&\n                    currentAuthStatusKind() != AuthStatusKind.REFRESH_SERVER_ERROR\n", "\n", ["A-S5"]],
    ["the notification fires even with the app on screen", "autosync",
      "if (!inForeground && !signedOutNotified) {", "if (!signedOutNotified) {", ["A-S4"]],
    ["the empty job list goes back to a plain 'No jobs yet'", "jobs",
      "                EmptyJobsMessage(emptyKind, session.canEditJobs)\n",
      "                Text(stringResource(R.string.jobs_no_jobs))\n", ["J5"]],
    ["the banner is dropped from the screen entirely", "jobs",
      "        LoginNoticeBanner(\n            notice = notice,\n            onSignIn = onOpenAccount,\n            onTryAgain = { app.session.refresh(); app.autoSync.requestSync() },\n            modifier = Modifier.padding(start = Space.screen, end = Space.screen, top = 8.dp)\n        )\n",
      "", ["J2"]],
    ["the banner can be dismissed", "jobs",
      "internal fun LoginNoticeBanner(\n    notice: LoginNotice,\n    onSignIn: (() -> Unit)?,\n    onTryAgain: (() -> Unit)?,\n    modifier: Modifier = Modifier\n) {\n",
      "internal fun LoginNoticeBanner(\n    notice: LoginNotice,\n    onSignIn: (() -> Unit)?,\n    onTryAgain: (() -> Unit)?,\n    modifier: Modifier = Modifier\n) {\n    var dismissed by remember { mutableStateOf(false) }\n    if (dismissed) return\n", ["J3"]],
    ["two different states share one message (could-not-tell reuses the signed-out headline)", "jobs",
      "LoginNotice.COULD_NOT_TELL -> stringResource(R.string.so_unsure_title)", "LoginNotice.COULD_NOT_TELL -> stringResource(R.string.so_out_title)", ["J8"]],
    ["the signed-out headline falls through to an else (a new notice would silently borrow it)", "jobs",
      "    LoginNotice.NONE -> \"\"\n}\n\n/** What it means", "    else -> \"\"\n}\n\n/** What it means", ["J7"]],
    ["the Account screen stops showing the notice", "account",
      "            if (notice == LoginNotice.SIGNED_OUT || notice == LoginNotice.COULD_NOT_TELL) {", "            if (false) {", ["ACC1"]],
    ["a Spanish string is missing", "es",
      /    <string name="so_ntf_title">[^<]*<\/string>\n/.exec(SRC.es)[0], "", ["STR1"]],
    ["a French string is left in English", "fr",
      /<string name="so_out_title">[^<]*<\/string>/.exec(SRC.fr)[0], '<string name="so_out_title">' + (strings(SRC.en).get("so_out_title")) + "</string>", ["STR3"]],
  ];
  for (const [label, file, oldS, newS, expectRed] of cases) {
    try {
      const scratch = { ...SRC, [file]: mutate(SRC[file], oldS, newS, label) };
      const failed = wiring(scratch).filter(([, p]) => !p).map(([l]) => l.split(" ")[0]);
      ok(`TEETH: ${label}  [red on ${failed.join(",")}]`, expectRed.every((c) => failed.includes(c)), `red on [${failed.join(",")}], wanted ${expectRed.join(",")}`);
    } catch (e) {
      ok(`TEETH: ${label}`, false, e.message);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
