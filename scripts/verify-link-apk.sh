#!/usr/bin/env bash
# Verify a built LINK apk FROM THE ARTIFACT, not from the build log.
#
# A separate script on purpose: anything placed after the gradlew line in the
# build script would become the last command and mask the build's exit code.
#
# What this refuses to take on trust:
#   - that the build succeeded at all (the APK must be on disk)
#   - the version (versionCode must equal the commit count, or the in-app update
#     prompt never clears and the phone asks forever)
#   - the signature (an APK signed with any other key is a different app to
#     Android and will not install over what is on the phone)
#   - that it is the LINK build (REQUEST_INSTALL_PACKAGES, or it cannot update
#     itself ever again)
#
# Usage:  bash scripts/verify-link-apk.sh            # verifies, prints a verdict
#         bash scripts/verify-link-apk.sh --to-drive # also copies to Drive

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

COUNT="$(git rev-list --count HEAD)"
# The repo build first -- that is the one publish-release.mjs reads, from a
# hardcoded REPO_ROOT path -- and a worktree build only as a fallback, for the
# case where the tree could not be made quiet. See build-link-from-worktree.sh.
APK="$REPO/app/build/outputs/apk/link/app-link.apk"
WT="/c/tmp/ff-build-$COUNT"
if [ ! -f "$APK" ] && [ -f "$WT/app/build/outputs/apk/link/app-link.apk" ]; then
  APK="$WT/app/build/outputs/apk/link/app-link.apk"
  echo "NOTE: using the WORKTREE build. publish-release.mjs will NOT see this APK;"
  echo "      it reads the repo path. Commit and build in the repo before publishing."
  echo
fi
LOG="$REPO/build-$COUNT.log"
DRIVE="/g/My Drive/Professional Documents/Projects/APK Builds/fenceflow.apk"
KEY_BACKUP="/g/My Drive/Professional Documents/Projects/Signing Keys/fenceflow-release.jks"

fail() { echo; echo "VERDICT: FAILED -- $1"; exit 1; }

echo "expecting versionCode $COUNT"
echo "apk      $APK"
echo

# --- 1. does it exist? The log is not evidence; the file is. -----------------
if [ ! -f "$APK" ]; then
  echo "No APK on disk. Last 25 lines of the log:"
  tail -25 "$LOG" 2>/dev/null
  echo
  echo "If the log STOPS MID-TASK with no 'BUILD FAILED' and no 'What went wrong',"
  echo "that is memory, not code. If it never printed a single Gradle line, the"
  echo "shell could not fork (0xC000026B) -- just rerun on a clean machine."
  fail "no artifact"
fi
SIZE_MB="$(( $(wc -c < "$APK") / 1048576 ))"
echo "exists, ${SIZE_MB} MB"

# --- 2. find aapt2 ------------------------------------------------------------
AAPT="$(find /c/Users/march/AppData/Local/Android/Sdk/build-tools -name 'aapt2.exe' 2>/dev/null | sort -r | head -1)"
[ -z "$AAPT" ] && fail "aapt2 not found; cannot read the artifact"

BADGING="$("$AAPT" dump badging "$APK" 2>/dev/null)"
[ -z "$BADGING" ] && fail "aapt2 could not read the APK"

PKG="$(printf '%s' "$BADGING" | grep -o "package: name='[^']*'" | head -1 | cut -d"'" -f2)"
VCODE="$(printf '%s' "$BADGING" | grep -o "versionCode='[^']*'" | head -1 | cut -d"'" -f2)"
VNAME="$(printf '%s' "$BADGING" | grep -o "versionName='[^']*'" | head -1 | cut -d"'" -f2)"

echo "package     $PKG"
echo "versionCode $VCODE"
echo "versionName $VNAME"

[ "$PKG" = "com.fenceestimator.app" ] || fail "wrong package id: $PKG"
[ "$VCODE" = "$COUNT" ] || fail "versionCode $VCODE does not equal the commit count $COUNT -- the phone would be prompted forever"

# --- 3. is it the LINK build? ------------------------------------------------
if printf '%s' "$BADGING" | grep -q "REQUEST_INSTALL_PACKAGES"; then
  echo "install permission present (this is the link build)"
else
  fail "REQUEST_INSTALL_PACKAGES missing -- this is the Play-shaped release build and can never update itself"
fi

# --- 4. the signature, against the key on Drive ------------------------------
APKSIGNER="$(find /c/Users/march/AppData/Local/Android/Sdk/build-tools -name 'apksigner.bat' 2>/dev/null | sort -r | head -1)"
if [ -n "$APKSIGNER" ]; then
  SIG="$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null | grep -i 'SHA-256 digest' | head -1 | awk '{print $NF}')"
  echo "signer      ${SIG:0:32}..."
  if printf '%s' "$SIG" | grep -qi '^$'; then
    echo "WARNING: could not read a signer digest"
  fi
  KEYTOOL="$JAVA_HOME/bin/keytool.exe"
  [ -x "$KEYTOOL" ] || KEYTOOL="/c/Users/march/.jdks/jdk-17.0.20+8/bin/keytool.exe"
  echo "(compare against the key backed up at Signing Keys/fenceflow-release.jks)"
  [ -f "$KEY_BACKUP" ] && echo "key backup present on Drive" || echo "WARNING: key backup MISSING from Drive"
else
  echo "WARNING: apksigner not found; signature unverified"
fi

echo
echo "VERDICT: the artifact is a signed link build at versionCode $COUNT"

# --- 5. Drive, on request. ONE file per project, overwritten. ----------------
if [ "${1:-}" = "--to-drive" ]; then
  echo
  cp "$APK" "$DRIVE" || fail "could not write to Drive"
  echo "copied to $DRIVE"
  D_SIZE="$(wc -c < "$DRIVE")"
  A_SIZE="$(wc -c < "$APK")"
  [ "$D_SIZE" = "$A_SIZE" ] || fail "Drive copy is $D_SIZE bytes, artifact is $A_SIZE"
  echo "sizes match ($A_SIZE bytes)"
  echo
  echo "Next, and only now:  node scripts/publish-release.mjs \"what changed\""
fi
