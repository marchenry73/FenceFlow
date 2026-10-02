# Edits I must make myself once the three waves land

Held back only because another wave owns the file right now and two agents
writing one file loses an edit.

## 1. The office sees worse satellite than the customer does -- CONFIRMED

`website/dashboard.html:20401`

    $('satIn').addEventListener('click', () => { if(SAT.z < 20){ SAT.z++; satDraw(); } });

The office is capped at zoom 20. `website/quote.html:2495` sets
`SAT_ZOOM_CAP = 21`, and 21 is the measured ceiling for Hillsborough (22 and 23
are 404 from every source). So the customer and the phone get 2.6 in/pixel and
the office, where he traces the fence from imagery, is stuck one level coarser.

Change the cap to 21. Leave the opening `SAT.z = 20` at line 20127 -- that is a
sensible first view, not a cap -- and leave the floor of 16.

Owned tonight by the deposit wave (it edits the deposit/balance block in the same
file). Two characters, after it lands.

## 2. The build and publish

Engine is at 2026.10.8 on both sides; `fixtures/pricing/manifest.json` still says
2026.10.6, which is why three publishes refused. Order:

1. Wait for all three waves (some bump the engine version again -- read it, do not
   assume).
2. Regenerate: `FENCEFLOW_PARITY_OUT=$(pwd)/fixtures/pricing ./gradlew testDebugUnitTest --tests "*ParityFixtureWriter*"`
3. Commit NAMED PATHS ONLY. Read `git status --porcelain` and account for every
   file; anything unrecognised belongs to a wave and waits.
4. Build from an isolated worktree at that commit -- copy in `local.properties`
   AND `app/google-services.json`, both untracked.
5. `export JAVA_HOME=/c/Users/march/.jdks/jdk-17.0.20+8`, then
   `./gradlew assembleLink -Pkotlin.compiler.execution.strategy=in-process > log 2>&1`
   as the LAST thing on the line. No pipe, no trailing `echo` -- both report a
   failed build as exit 0.
6. Verify from the ARTIFACT: versionCode must equal `git rev-list --count HEAD`,
   signer SHA-256 must match the existing key, REQUEST_INSTALL_PACKAGES present.

## 3. The join flags -- and the reason they must wait for wave 1

`JOIN_PRICING_READY` is already true. The other two are false:

- `EntitySync.JOIN_COLUMNS_LIVE` (phone strips start_joint/end_joint on push)
- `SurveyViewModel.JOIN_STORAGE_READY` (the Attach tool is not offered)

Do NOT flip these until wave 1's fix to the pull race has landed and been
attacked. Turning on joint push while a phone can still orphan and then tombstone
cloud rows means a joint could be written and then destroyed by the same
mechanism that killed 64 priced lines. The feature is correct; the plumbing it
rides on is not safe yet.

## 4. REFUTED -- take this OFF the open list

`tests/a38-quote-pay-section.test.mjs` was reported as "asserts the opposite of
what he asked and passes for the wrong reason, its scan broken by line endings".
**Both halves are wrong.** I read it.

- It asserts the quote page must not claim a card fee is added, *because none is*:
  `create-payment-link` hardcodes `stripeFee = 0` and `cardFeeCents` has no
  caller. Telling her about a fee she is not charged is as much a lie as hiding
  one she is.
- The first assertion is a TRIPWIRE, not a pin: the moment `stripeFee = 0` stops
  being hardcoded, the test fails with a message saying to state the real figure
  from that code. That is the opposite of a guard that rots.
- It has its own has-teeth test (the fee detector must fire on a sentence that
  would be a lie and pass the true one), in all three languages, compared by KEY
  and never by display text.
- `grabLine` strips the CR. There is no scan that runs to end of file.

The real open question underneath it is a DECISION for him, not a bug:
**Stripe charges HIM a fee on a card payment and he is not passing it to the
customer.** If he wants to, `cardFeeCents` (the 3%-capped formula) already exists
with no caller, and the copy and that test move together. If he does not, nothing
needs doing. Nobody has asked him.

## 5. How to judge the orphan-reaper fix when the wave lands

I read the pull pass myself (`EntitySync.kt:2440-2482`) so I can check the fix
rather than accept it.

`pullFenceRuns` and `pullJobChildren` are sibling `async` blocks inside one
`awaitAll()`. The only thing between them is `netGate.withPermit`, a semaphore
that caps concurrent network calls -- it imposes no ORDER at all. So the runs and
the lines race, every pass.

**The file already knows how to express a dependency, three entries above.** The
catalog pull does this:

    async {
        suppliersPull.join()
        runCatching { netGate.withPermit { ...pullCatalog... } }
    }

with a comment saying it waits BEFORE asking for a permit, never while holding
one, "a permit held here would be one the suppliers' pull could be waiting for".
The reasoning is identical to what the line items need, and the comment even ends
with the right doctrine: *"a catalog row whose supplier has not arrived keeps what
it has and is completed by the next pass."* Line items do not keep what they
have. They get reaped.

So a GOOD fix has all three of these, and I should push back if it has fewer:

1. **Order the pulls** using the existing `join()`-before-permit idiom, not a new
   mechanism and not by moving the reaper call around.
2. **Skip, do not orphan**: a cloud line naming a run this phone does not have is
   not inserted at all. The insert branch currently reads
   `fenceRunId = row.fenceRunSyncId?.let { runIdBySyncId[it] }` with no fallback,
   while the update branch two lines below already has `?: existing.fenceRunId`.
3. **The reaper must not tombstone a CLOUD row from a LOCAL absence**, even if
   something still slips through. Local absence is not deletion.

Any fix with only (1) is one dropped network call away from the same loss. Any
fix with only (2) and (3) leaves the thrash that produced three deletes inside
three minutes on 29 August.

And the test must FAIL against the old logic. If its canary passes both ways it
has proved nothing.

## 6. CORRECTION to the build plan I wrote above -- use the REPO, not a worktree

I planned a worktree build. That is wrong for this project and I found out by
reading the publish script instead of assuming.

`scripts/publish-release.mjs` reads the APK from a HARDCODED repo path --
`REPO_ROOT/app/build/outputs/apk/link/app-link.apk` (line 69) -- and runs its own
gates with `cwd = REPO_ROOT`: `check-parity.mjs` (which compiles the app),
`dashboard-syntax`, `security-smoke`, `testDebugUnitTest` and five downstream
suites. So a worktree-built APK is **invisible to publish**, and publish runs
Gradle in the repo anyway, which throws away most of what the worktree bought.

**The route to use:**

1. Wait until nothing is editing the tree. This is the real prerequisite, not the
   worktree -- the worktree was only ever simulating it.
2. Commit, naming paths. Read `git status --porcelain` and account for every file.
3. Confirm no tracked modifications remain. Now the working tree IS the commit,
   which is the guarantee that matters.
4. `./gradlew assembleLink -Pkotlin.compiler.execution.strategy=in-process > log 2>&1`
   -- as the LAST thing on the line. No pipe, no trailing `echo $?`.
5. `bash scripts/verify-link-apk.sh --to-drive` -- judges the artifact, not the log.
6. `node scripts/publish-release.mjs "what changed"` -- it re-runs its own gates.

`build-link-from-worktree.sh` stays for the case where the tree genuinely cannot
be made quiet, with a header saying it is usually the wrong tool.
`verify-link-apk.sh` now prefers the repo APK and warns loudly if it falls back
to a worktree one.

**Memory is the other gate.** `gradle.properties` asks for `-Xmx2560m` and
publish runs Gradle twice more (check-parity, then testDebugUnitTest). With the
waves running, free memory has been sitting at 2.2-2.4 GB. A starved Gradle dies
MID-TASK with a truncated log and no error block, which reads like a code failure
and is not. Do not start until the agents have released their memory.

## 7. The release note, and the --urgent question

`scripts/publish-release.mjs` takes one sentence. It is read by the person
deciding whether to tap Update, so it leads with the thing that costs money.

Proposed:

    Stops a sync fault that could delete a job's priced materials, bills one
    corner post where two sides meet instead of two end posts, and adds
    emailing a quote to a customer.

What is in the build, for reference when writing the real one:

- the sync fault that destroyed 100 priced line items over six weeks -- fixed,
  verified by an independent skeptic, deadlock proven impossible
- attaching two sides now bills ONE shared corner post, on both engines
  ($47.19 off the 198 ft job), and the "why this many posts?" sheet explains it
- the drawing opens on the run you came from, not the job's first one
- a blank or impossible number can no longer wipe priced lines
- the deposit reads the same on every surface, and the PDF no longer prints
  "$0.00 is due" when none is set
- what the deposit is FOR, in the customer's own language
- email a quote from the phone and the office, with templates
- payment methods editable on the phone
- a stranger's link can no longer reach mail sent from his domain

**--urgent is a real question, not a formality.** It removes the "Later" button
for everyone the release reaches. The script's own header says to reserve it for
money and data, because "an app that insists on updating for a colour change
teaches people to ignore the one that matters."

This build qualifies on the merits: the sync fault silently destroyed priced
line items on signed jobs. But it would also force nine other companies' phones,
and that is March's call rather than mine. Ask before passing the flag.
