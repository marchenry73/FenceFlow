#!/usr/bin/env bash
# Build the LINK apk from an isolated git worktree at the current HEAD.
#
# *** READ THIS BEFORE REACHING FOR THIS SCRIPT. It is usually the WRONG tool. ***
#
# scripts/publish-release.mjs reads the APK from REPO_ROOT/app/build/outputs/apk/
# link/app-link.apk -- a hardcoded path -- and runs its own gates (check-parity,
# testDebugUnitTest, the downstream suites) with cwd = REPO_ROOT. So an APK built
# in a worktree is INVISIBLE to publish, and publish will run Gradle in the repo
# regardless, which throws away most of the isolation this script buys.
#
# THE NORMAL ROUTE, and the one to use when nothing else is editing the tree:
#   1. commit (named paths only), so the working tree IS the commit
#   2. git status --porcelain shows no tracked modifications
#   3. build in the repo:  ./gradlew assembleLink -Pkotlin.compiler.execution.strategy=in-process > log 2>&1
#   4. bash scripts/verify-link-apk.sh --to-drive
#   5. node scripts/publish-release.mjs "what changed"
# Step 1 is the actual guarantee the worktree was simulating: once HEAD equals
# the working tree, a repo build is a clean-commit build.
#
# USE THIS SCRIPT ONLY when the tree cannot be made quiet -- background agents
# mid-edit and a build that cannot wait. Then verify the artifact with
# verify-link-apk.sh, and know that publish will still need a repo build before
# it will ship anything.
#
# WHY A WORKTREE AT ALL. APK 562 crashed the moment it was opened because it was
# built straight out of the working tree while two agents were committing into
# it: the Kotlin that compiled came from three different commits. A worktree pins
# the build to one commit and cannot be edited underneath it.
#
# TRAPS THIS SCRIPT EXISTS TO AVOID, every one of them hit for real:
#   - Never pipe gradlew into tail or grep. The pipeline returns the LAST
#     command's status, so a failed build reports success. A build "succeeded"
#     for 30 minutes before anyone noticed there was no APK.
#   - Never put anything after the gradlew line either. `gradlew > log; echo $?`
#     makes echo the last command, so a failed build is recorded as exit 0.
#   - Check the APK is ON DISK before believing any exit code.
#   - Two untracked files must be copied in or the build fails late:
#     local.properties and app/google-services.json.
#   - A Gradle failure with NO error block in the log is memory, not code.
#     -Xmx2560m needs real headroom; check free RAM first.
#
# Usage:  bash scripts/build-link-from-worktree.sh
# Reads nothing, writes the worktree and a log, prints the APK path on success.

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

COMMIT="$(git rev-parse HEAD)"
COUNT="$(git rev-list --count HEAD)"
WT="/c/tmp/ff-build-$COUNT"
LOG="$REPO/build-$COUNT.log"

echo "repo        $REPO"
echo "commit      $COMMIT"
echo "versionCode $COUNT  (must match the APK, or publish refuses)"
echo "worktree    $WT"
echo "log         $LOG"
echo

# --- refuse to build a dirty tree -------------------------------------------
# A worktree is built from the COMMIT, so uncommitted work would be silently
# left out and the APK would not be what is on screen.
DIRTY="$(git status --porcelain | grep -v '^??' | wc -l)"
if [ "$DIRTY" -ne 0 ]; then
  echo "REFUSING: $DIRTY tracked files are modified and not committed."
  echo "A worktree build takes the COMMIT, so those changes would not be in the APK."
  git status --porcelain | grep -v '^??'
  exit 2
fi

# --- memory ------------------------------------------------------------------
FREE_MB="$(powershell -NoProfile -Command \
  '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1KB)' 2>/dev/null | tr -d '\r')"
echo "free memory ${FREE_MB} MB"
if [ -n "$FREE_MB" ] && [ "$FREE_MB" -lt 3500 ]; then
  echo
  echo "REFUSING: under 3500 MB free and gradle.properties asks for -Xmx2560m."
  echo "A starved Gradle dies MID-TASK with a truncated log and no error block,"
  echo "which reads like a code failure and is not. Close what you can and retry."
  echo "Stray daemons:"
  powershell -NoProfile -Command \
    "Get-CimInstance Win32_Process -Filter \"Name='java.exe'\" | Select-Object ProcessId, CommandLine | Format-List" 2>/dev/null
  exit 3
fi

# --- worktree ----------------------------------------------------------------
if [ -d "$WT" ]; then
  echo "removing stale worktree $WT"
  git worktree remove --force "$WT" 2>/dev/null
  rm -rf "$WT"
fi
mkdir -p /c/tmp || exit 1
git worktree add --detach "$WT" "$COMMIT" || exit 4

# --- the two untracked files the build cannot do without ---------------------
for f in local.properties app/google-services.json; do
  if [ ! -f "$REPO/$f" ]; then
    echo "REFUSING: $REPO/$f is missing and the build needs it."
    exit 5
  fi
  mkdir -p "$WT/$(dirname "$f")"
  cp "$REPO/$f" "$WT/$f" || exit 5
  echo "copied in   $f"
done

# The signing key is referenced by absolute path from local.properties, so it
# needs no copy -- but refuse early rather than 25 minutes in.
KEY="$(grep -o '^keystore.path=.*' "$REPO/local.properties" | cut -d= -f2-)"
if [ ! -f "$KEY" ]; then
  echo "REFUSING: the signing key named in local.properties does not exist."
  echo "An APK signed with any other key is a DIFFERENT APP to Android and will"
  echo "not install over what is on the phone."
  exit 6
fi
echo "signing key present"
echo

# --- build. NOTHING after this line, and no pipe. ----------------------------
export JAVA_HOME=/c/Users/march/.jdks/jdk-17.0.20+8
echo "JAVA_HOME   $JAVA_HOME"
echo "building... (this is the slow part; watch $LOG)"
cd "$WT" || exit 1
./gradlew assembleLink -Pkotlin.compiler.execution.strategy=in-process > "$LOG" 2>&1
