# The FenceFlow dev environment

Until now there was one database. Every schema patch, every function change and
every build was tried against `newcrgafcptspmapacrx` — the live project, holding
the real company's customers, jobs and money. That was survivable while the only
person who could be hurt by it was the person doing it. It stops being
survivable the moment somebody else's business is in there.

This describes the second environment and the rule for using it.

**Nothing here has been created yet.** Making a second Supabase project bills to
your account and needs your login, so the account work is yours. Everything that
could be built without it — the schema transfer tooling, the seed, the app
switch, the website split — is done and is in this repository.

---

## Before you start: you cannot make this project in your current org

Your organisation `marchenry73's Org` already holds two projects, FenceFlow and
Cadence. The Supabase free plan allows **two active free projects per
organisation**, so a third will be refused.

The way through is a **new organisation**, which is free and takes a moment:

1. Supabase dashboard → the organisation dropdown, top left → **New
   organization**.
2. Name it something like `fenceflow-dev`. Plan: **Free**.
3. Create the project inside that new organisation.

Two projects in different orgs cannot see each other's data, which is the point.

## Step 1 — create the project

In the new organisation, **New project**:

| Field | Value | Why |
|---|---|---|
| Name | `fenceflow-dev` | |
| Region | **ca-central-1** | Same as production, so latency behaves the same |
| Postgres | **17** | Production runs 17.6.1; a different major version can accept schema that production would refuse |
| Password | Generate one and put it in your password manager | You will not need it for anything below, but losing it means you cannot ever use `psql` against dev |

When it finishes, from **Project Settings → API**, note:

- the **Project URL** — `https://<dev-ref>.supabase.co`
- the **publishable key** — `sb_publishable_…`, safe in public source
- the **service_role key** — secret. It goes in your password manager and into a
  terminal environment variable when you seed. It never goes in a file in this
  repo, never in a chat window, and never in the website.

## Step 2 — put the schema on it

Production's schema is not in one file. It is `supabase_schema.sql` plus 105
patches applied over time, and the ordinary way to copy it — `supabase db dump`
— **does not work on this machine**: it runs `pg_dump` inside Docker, and Docker
is not installed here. It also wants the database password.

So the schema is rebuilt by replaying every `.sql` file in the order production
received it, through the Management API, which needs neither Docker nor the
password — only the Supabase CLI login you already have.

```bash
node scripts/apply-schema.mjs <dev-ref>
```

The order lives in `supabase/dev/apply-order.txt`: git history order, with the
base schema forced first and every `*_fix` file moved behind the `*_patch` it
repairs. Ordering is still a guess in places, so failures are retried while any
of them is still succeeding. A few files will fail permanently and should — the
ones that backfill or clean up data have nothing to act on in an empty database.

The script refuses to run against production. It builds copies, only.

### Then prove it matches, rather than hoping

```bash
node scripts/schema-fingerprint.mjs <dev-ref> supabase/dev/fingerprint-dev.txt
node scripts/schema-diff.mjs supabase/dev/fingerprint-prod.txt supabase/dev/fingerprint-dev.txt
```

`supabase/dev/fingerprint-prod.txt` is committed and was taken from production
on 29 August 2026. It is 1,396 lines describing every table, column, constraint,
index, RLS flag, policy, function signature, trigger, enum, view, extension,
realtime subscription, storage bucket and role grant — and not one row of
anybody's data, which is why it is safe in a public repository.

Production at that moment:

| | |
|---|---|
| Tables | 26, RLS on all of them |
| Policies | 87 |
| Functions | 56 |
| Triggers | 39 |
| Views | 3 |
| Realtime tables | 16 |
| Buckets | `job-files` (private), `releases` (public) |

The diff names anything missing. Fix it in dev by running the patch it came
from, and run the diff again until it says identical. A dev environment that is
*nearly* production is worse than none: it passes tests production would fail.

Two differences are expected and harmless — `GRANT` lines and `EXTENSION`
version numbers can differ between projects created months apart.

### Never copy production data down

Not once, not "just the jobs table". Real customers' names, addresses, phone
numbers and card history do not belong in a database that exists to be broken on
purpose, and dev is exactly where a stray test webhook or a mistyped `send` would
reach them.

Dev gets invented people instead:

```bash
# PowerShell
$env:SUPABASE_DEV_URL = "https://<dev-ref>.supabase.co"
$env:SUPABASE_DEV_SERVICE_KEY = "<dev service_role key>"
$env:DEV_SEED_PASSWORD = "<a password you choose>"
node scripts/seed-dev.mjs
```

That makes one company — Palmetto Fence Co. (DEV), on the Pro plan — with an
owner, a foreman and a crew member, three customers, and four jobs chosen so the
whole product has something to show:

- a **quote sent** and not yet viewed, so the quote page and the 3D have a job
- one **accepted and scheduled** four days out, so the calendar is not empty
- one **in progress**, with a teardown run, approved and unapproved shifts, a
  part-paid balance and a half-ticked checklist
- one **completed and paid in full**, so reports and AR aging have history

Fence runs carry real drawn geometry in `FenceCodec`'s own format — `x:y` points
and `x:y:width:mounting:swing` gates, at 20 units to the foot — including a walk
gate, a double drive gate and a wall-mounted gate, so the takeoff, the estimate,
the PDF and the 3D all render something.

The seed reads the service key from the environment and writes it nowhere. There
is no default password, because a default in a public repository is a published
password. It is safe to re-run: it deletes its own company and rebuilds it, it
touches nothing it did not create, and it refuses to run against production.

## Step 3 — deploy the functions

```bash
node scripts/deploy-functions.mjs <dev-ref>
```

All twelve, not the three that `deploy-functions.cmd` sends to production. The
`verify_jwt` flags come from `supabase/config.toml` and are not repeated in the
script — that file stays the only place they are decided. `--project-ref`
overrides the `project_id` pinned at the top of it while leaving every
per-function flag alone.

Secrets do **not** carry over. The dev project starts with none, and a function
missing its secret fails at runtime, not at deploy. In the dashboard under
**Edge Functions → Secrets**:

| Secret | Value |
|---|---|
| `STRIPE_SECRET_KEY` | the same `sk_test_…` production uses — test keys can be shared |
| `STRIPE_WEBHOOK_SECRET` | a **new** `whsec_…`, from a second Stripe test endpoint pointed at dev |
| `SITE_URL` | the dev site, e.g. `https://fenceflowapp.com/dev` |

The webhook secret is the one that cannot be shared: Stripe issues it per
endpoint, so reusing production's makes every dev event fail its signature check
— silently, the way these failures always are.

Point a second Stripe **test mode** webhook at:

```
https://<dev-ref>.supabase.co/functions/v1/stripe-webhook
```

## Step 4 — pointing the app at dev

One line in `local.properties`, which is gitignored and never travels with the
repo:

```properties
fenceflow.env=dev

supabase.dev.url=https://<dev-ref>.supabase.co
supabase.dev.key=sb_publishable_<dev publishable key>
```

Remove the line, or set it to `prod`, to go back. `supabase.url` and
`supabase.key` keep their current meaning as the production pair, so a build
with no `fenceflow.env` at all behaves exactly as it always has.

Every build prints which database it is talking to before it compiles anything:

```
FenceFlow backend: PRODUCTION  https://newcrgafcptspmapacrx.supabase.co
FenceFlow backend: DEV         https://<dev-ref>.supabase.co
```

And `fenceflow.env=dev` with the two dev properties missing **fails the build**
rather than falling back to production. A dev build that quietly reverts to the
live database is the exact accident this exists to prevent, and it would look
like a working dev build right up until it charged somebody.

### The phone says so, permanently

A build pointed at dev paints a red frame around every screen and a
`DEV — TEST DATA` label under the status bar. It is drawn over everything,
applied once at the root, and cannot be dismissed. The dev app is otherwise
pixel-identical to the real one — same icon, same screens — so a phone on the
truck seat is one glance away from being trusted with a real deposit.

It costs a production build nothing: `BuildConfig.IS_DEV_BACKEND` is a
compile-time constant, so the shrinker removes the drawing code entirely.

### The one sharp edge

Dev and production builds share an application id, so they share the phone's
local database. Flipping `fenceflow.env` does **not** clear it: the app will
start up holding whatever the other environment had cached and sync it upward.

**Clear the app's storage, or uninstall and reinstall, whenever you flip.**

The alternative was a build flavor with a different application id, which is the
tidier Gradle answer and is deliberately not what this is. Flavors rename every
task — `assembleDebug` becomes `assembleProdDebug` — which breaks
`copyDebugApkToDrive`, `publish-release.mjs`, and the Android Studio run
configuration; and an `applicationIdSuffix` changes the application id, which is
the one thing `app/build.gradle.kts` already warns never to do, because every
phone carrying the old id opens the new build with nothing in it.

Worth reconsidering once there are real customers and installing both side by
side is worth the churn.

## Step 5 — the dev website

The four pages that talk to Supabase used to carry the project URL and the
publishable key inline, in four separate files. They now read one shared file:

```
website/config.js   ->  window.FENCEFLOW_CONFIG = { ENV, SUPABASE_URL, SUPABASE_KEY }
```

`admin.html`, `dashboard.html`, `welcome.html` and `quote.html` load it before
anything else. A dev copy of the site differs from the live one by exactly those
three lines.

GitHub Pages serves one branch, so the dev copy is a folder rather than a
branch:

```
https://fenceflowapp.com/        live
https://fenceflowapp.com/dev/    dev
```

Generate it:

```bash
node scripts/build-dev-site.mjs https://<dev-ref>.supabase.co sb_publishable_<dev key>
```

It copies the site into `website/dev/` and rewrites that one file. It refuses a
production URL, and refuses anything that looks like a secret key rather than a
publishable one — this folder is committed to a public repository.

Because it is a copy and not a link, **an edit to `website/dashboard.html` does
not reach the dev site until you re-run it.**

Every dev page wears a red `DEV ENVIRONMENT` bar across the top, for the same
reason the phone does.

Preview either one locally before pushing:

```bash
node scripts/serve-website.mjs           # live copy, port 8080
node scripts/serve-website.mjs dev 8081  # dev copy, port 8081
```

(A server is needed because `dashboard.html` is an ES module and browsers refuse
to load modules over `file://`.)

## The rule from here on

**Schema and functions go to dev first.**

1. Write the patch. Apply it to **dev**.
2. Check it there — and check the fingerprint diff, so you know what it actually
   changed rather than what you meant it to change.
3. Only then apply the same file to production.
4. Commit the `.sql` file and add it to `supabase/dev/apply-order.txt`, so a dev
   project rebuilt from scratch tomorrow still matches.

**App builds get tested against dev before a release.**

1. `fenceflow.env=dev`, clear app storage, build, exercise the change.
2. Flip back to `prod`, clear storage again, build the release.
3. Publish.

The point is not ceremony. It is that the first time any change meets real data,
it has already been wrong somewhere else first.

## What is not done

- The dev Supabase project does not exist. Steps 1–3 are yours.
- `scripts/seed-dev.mjs` and `scripts/apply-schema.mjs` have never been run
  against a real dev project, because there is not one yet. They are written
  against the true production schema, read from production by introspection
  rather than assumed — but expect to fix something on first run.
- The website rewiring is verified only by static check: every page loads
  `config.js`, no page still carries a hardcoded URL or key, and the values in
  `config.js` are byte-identical to what the pages hardcoded before. It has not
  been opened in a browser. Serve it once and load the dashboard before pushing.
