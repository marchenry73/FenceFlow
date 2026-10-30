# More than one crew member on a job: it is built, and it has never been switched on

Written 30 Oct 2026, overnight. **Nothing in here has been applied.** It needs
one decision from you, and it takes about a minute.

## What you asked for

> "I also want to be able to add multiple crew members to a job."

## What I found

It already exists. All of it.

`website/dashboard.html` has carried the whole feature since September: the
pickers that add and remove crew on a job, the access-request queue with
approve/deny, the calendar chips that name who is on each job, and the
"a truck and a crew go somewhere on a date nobody put a name against" alert.
The database half is `supabase_crew_job_scope.sql` — 1112 lines, written
22 September 2026.

**It was never applied.** And the office hides those sections when the table
is missing, on purpose, so nothing ever looked broken:

> "This page can ship before that SQL is applied, so a table that is not
> there yet is an expected answer, not a failure: the new sections stay
> hidden, silently, exactly as the page was before any of this existed."

That is why you have never seen it. I found it by listing every table and
function the office asks for and comparing that against the live database.
Four things were missing, and all four belong to this one feature:

| Missing | What it does |
|---|---|
| `job_access_requests` | a crew member asking to see a job they are not on |
| `set_job_crew` | sets the whole crew list for a job |
| `end_job_assignment` | takes one person off a job |
| `decide_job_access` | approves or denies a request |

Everything else the office uses — 40 tables and 55 functions — is present.

## Something I broke and then put back

Before I found any of the above, I added my own `job_assignments` table
(r53) to provide multiple crew, because nothing in the database did. It
worked, and it was the wrong table: the office expects columns `kind`
(`CREW`/`ACCESS`) and `ended_at`; mine had `crew_role` and `removed_at`.

That mattered more than being merely redundant. `supabase_crew_job_scope.sql`
starts with `create table if not exists public.job_assignments`, so my table
would have **satisfied that test and the real definition would have been
skipped** — the apply would have reported success and left the wrong columns
behind the office, the three functions and their foreign keys. Half-applied,
silently.

`supabase_r56_undo_r53_wrong_crew_table.sql` drops it (0 rows, nothing read
it) and refuses to run if the table in front of it is the real one. Applied
and verified. The way is clear.

## What applying it actually does, with your numbers

The file's own header warns:

> "A login with no crew record correctly sees NO jobs once this is applied.
> On 2026-09-21 no company in production had a single employee linked to a
> login."

That has changed since it was written. Measured tonight against live data:

| | |
|---|---|
| crew logins | **1** |
| crew logins NOT linked to an employee record | **0** — the prerequisite is already met |
| employee records | 4 (1 has a login) |
| jobs with a lead assigned | **7 of 13** |

So applying it would mean: your one crew login sees the jobs it leads, and
the **6 jobs with nobody assigned would disappear from the crew's view**
until somebody is put on them. The office keeps seeing everything.

That is the feature working as designed — but it is your crew's Monday
morning, so it is your call and not a 4am one. It is also why I stopped here:
the file's own apply order says to ship it *with* an app release, and an older
build handles a job that stops arriving by keeping its local copy and having
its pushes refused row by row — noisy, never lossy, but noisy.

## To switch it on

1. In the office, put someone on the 6 jobs that have nobody — or accept that
   the crew will not see those 6 until you do.
2. Then, from the project folder:

```bash
npx supabase db query --linked --project-ref newcrgafcptspmapacrx -f supabase_crew_job_scope.sql
```

3. Check it with its own probe, which is read-only:

```bash
npx supabase db query --linked --project-ref newcrgafcptspmapacrx -f supabase_crew_job_scope_probe.sql
```

The file is written to be safe to re-run, and every part of it is idempotent.

## If you would rather not narrow the crew view at all

Say so and I will split the file: the crew-assignment half (the table, the
three functions, the office pickers coming to life) without the
visibility-narrowing half. You would get "more than one person on a job" and
the crew would carry on seeing every job, exactly as they do now. That is a
couple of hours of careful work, not a rewrite — the two halves are separate
parts of the file.
