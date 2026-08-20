# Backups

There are three separate things here, and they protect against different
failures. Having one does not cover the others.

| Layer | Protects against | Who runs it |
|---|---|---|
| **Supabase's own backups** | The database being lost or corrupted | Supabase, if your plan includes it |
| **`scripts/backup-cloud.mjs`** | Your Supabase project being deleted, suspended, or emptied by a bad migration | You, on a schedule |
| **Export Everything (in the app)** | A single company wanting their records out | Each company owner |

## 1. Check what Supabase is actually doing for you

**Do this first — the answer changes everything below.** Open the Supabase
dashboard → Project Settings → check your plan.

- **Free plan: there are no automated backups.** If the project is deleted or
  the data is destroyed, it is gone. Free projects also **pause after a period
  of inactivity**, which for a business app means the app stops working for
  everyone until someone logs into the dashboard and resumes it.
- **Pro plan** ($25/month) adds daily backups and point-in-time recovery, and
  the project does not pause.

If real companies are relying on this app, Pro is not optional — not for the
backups so much as for the pausing. A fencing crew standing in a yard unable to
open a job because the database went to sleep is not a recoverable situation
socially, whatever the data does.

## 2. Take your own backup

Independent of Supabase, so it survives the project itself being deleted:

```bash
node scripts/backup-cloud.mjs "D:/FenceFlowBackups"
```

Writes a timestamped folder of JSON files, one per table, plus a MANIFEST.txt
with the row counts. Takes a few seconds on a small database.

It refuses to write anywhere inside this repository. **The repository is
public** — a backup committed to it would publish every company's customer
names, addresses, phone numbers and payment history to the internet. The script
checks rather than trusting you to remember.

It exits non-zero and says so if it captured nothing, so a scheduled run that
silently breaks shows up as a failure instead of a folder of empty files.

### Scheduling it

Windows Task Scheduler → Create Basic Task → Daily → Start a program:

- Program: `node`
- Arguments: `scripts/backup-cloud.mjs "D:/FenceFlowBackups"`
- Start in: `C:\Users\march\AndroidProjects\FenceEstimator`

Point the destination at a synced folder (Google Drive, OneDrive) and the
backup leaves the machine on its own. **Do not** point it at a folder that syncs
into anything public.

### What it does and does not capture

Captures: every row of every table — jobs, payments, estimates, crew, hours,
settings.

Does **not** capture:

- **The schema.** Tables, RLS policies, functions and triggers are not in the
  dump. Restoring into an empty project means recreating those first from the
  `supabase_*.sql` patch files in this repo, then loading the JSON.
- **Storage files** — signatures, survey photos, job photos. These *are* in the
  cloud, in Supabase Storage, so they survive a phone being lost or replaced.
  They are simply not in *this* dump, which reads database tables. Backing them
  up separately means downloading the `job-files` bucket from the Supabase
  dashboard.
- **Auth users.** Accounts live in Supabase's auth schema. A restore would need
  people to sign up again, and `profiles` rows rematched to the new user ids.

So this is a *data* backup, not a one-click restore of the whole platform. It
is the difference between "we lost three days" and "we lost everything", which
is the difference that matters.

## 3. Per-company export

Any company owner can take their own records at any time: **Settings → Export
Your Data → Export Everything**. A zip of spreadsheets that opens in Excel or
Sheets, with no involvement from you.

This is deliberate. A contractor's job history is their business, and an export
they have to request is one that stops being answered the moment the
relationship sours.

## If you ever have to restore

1. Recreate the schema in a new project by running the `supabase_*.sql` files.
2. Load the JSON files, parents before children: `profiles`, then `jobs`, then
   everything that references a job.
3. Have people sign up again, then repoint `profiles.id` at the new auth ids.
4. Storage files: copy the `job-files` bucket across, or let the phones
   re-upload anything they still hold locally.

Step 3 is the awkward one and is the strongest argument for being on a plan
where Supabase's own point-in-time restore exists, since that keeps auth intact.

## What is covered where

| | In the cloud | In `backup-cloud.mjs` | On the phone |
|---|---|---|---|
| Jobs, payments, crew, hours | yes | yes | yes |
| Settings and catalog | yes | yes | yes |
| Signatures | yes | no — bucket | yes |
| Survey images | yes | no — bucket | yes |
| Job photos | yes, compressed | no — bucket | yes, full quality |
| User accounts | yes | **no** | — |

Job photos are shrunk to about 1600px on the long edge before upload, so the
cloud copy is good enough to show a customer and small enough not to eat a
crew's mobile data. **The full-quality original stays on the phone that took
it** — nothing is degraded, there is simply a lighter copy in the cloud as well.

Survey images and signatures are uploaded untouched, on purpose. A survey
carries the pixel space its fence line and scale are measured in, so resizing
one would silently reprice every job drawn on it; a signature is line art that
JPEG smears, and it is evidence.

## The honest summary

Right now the app-level export works and is genuinely good. The cloud backup
script works and is scheduled by you. Supabase's own safety net depends on a
plan setting you should go and check.

The gap worth closing before other companies depend on this: **nothing here
restores auth users**, so a total project loss means everyone signs up again
even in the best case.
