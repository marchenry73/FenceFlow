#!/usr/bin/env node
/**
 * The pricing parity gate.
 *
 * Two copies of the pricing engine exist on purpose -- Kotlin on the phone,
 * TypeScript on the server -- and never a third. What keeps them one engine
 * is a set of fixtures written by Kotlin under fixtures/pricing/ that BOTH
 * sides must reproduce exactly. This runs both suites and says, in one line
 * each, whether they did.
 *
 * publish-release.mjs and deploy-functions.mjs call this first and refuse to
 * continue when it is red. There is deliberately no --skip flag: the day the
 * gate is skipped is the day the office quotes one number and the phone
 * another, and that is the failure this whole arrangement exists to prevent.
 *
 * Usage:
 *   node scripts/check-parity.mjs
 *
 * Exit status is non-zero when either suite fails, including when the
 * fixtures have not been generated yet -- no evidence is not green.
 *
 * The Kotlin suite needs the two files Gradle reads but git does not carry:
 * local.properties (the SDK path) and app/google-services.json. A fresh
 * worktree has neither; copy them from the main checkout first.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";

// JDK 17, explicitly. There is no java on PATH here, and the JDK Android
// Studio bundles is Java 25, which Gradle rejects with a bare "25.0.2" that
// says nothing about what went wrong. The POSIX form is what a Git Bash
// user exports by hand; gradlew.bat needs the Windows spelling of the same
// directory.
const JDK_POSIX = "/c/Users/march/.jdks/jdk-17.0.20+8";
const JDK_HOME = isWindows
  ? JDK_POSIX.replace(/^\/([a-zA-Z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, "\\")
  : JDK_POSIX;

/**
 * Runs one suite, prints one line, returns true when it passed. Output is
 * captured rather than streamed so a green run is one line per suite; a red
 * run prints the tail of what the suite said, which is where both gradle
 * and the TypeScript runner put the reason.
 *
 * The command is one string run through the shell: gradlew.bat and npx.cmd
 * are batch files, which Node will not exec without a shell on Windows, and
 * Node warns (DEP0190) when an argument array is combined with shell:true.
 */
function suite(label, commandLine, extraEnv = {}) {
  const started = Date.now();
  const result = spawnSync(commandLine, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const ok = result.status === 0;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(18)} ${seconds}s`);
  if (!ok) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const lines = output.split(/\r?\n/);
    const tail = lines.slice(Math.max(0, lines.length - 40));
    if (result.error) console.log(`      ${result.error.message}`);
    for (const line of tail) console.log(`      ${line}`);
  }
  return ok;
}

// The wrapper by absolute path, quoted. A bare "gradlew.bat" is not found
// on a machine with NoDefaultCurrentDirectoryInExePath set (this one has
// it): cmd then refuses to look in the current directory for a command,
// and reports it as "not recognized" -- which reads as a missing install.
const gradlew = `"${resolve(REPO_ROOT, isWindows ? "gradlew.bat" : "gradlew")}"`;

const kotlin = suite(
  "kotlin parity",
  `${gradlew} testDebugUnitTest --tests "*Parity*" --console=plain -q`,
  {
    JAVA_HOME: JDK_HOME,
    PATH: `${JDK_HOME}${isWindows ? "\\bin;" : "/bin:"}${process.env.PATH ?? ""}`,
  },
);

const typescript = suite(
  "typescript parity",
  `${isWindows ? "npx.cmd" : "npx"} -y tsx supabase/functions/_shared/pricing/parity.ts`,
);

if (!(kotlin && typescript)) {
  console.log("\nParity is red. Nothing ships until both engines agree on the same fixtures.");
  process.exit(1);
}
console.log("\nParity is green: both engines reproduce the fixtures exactly.");
