# Overnight, 19–20 October 2026

Three commits, all pushed. Nothing is published; the APK is built and waiting
for you.

| | |
|---|---|
| HEAD | `7d03cbb`, 696 commits → the build is **1.696** |
| Pushed | yes, `main` |
| Edge functions | four deployed to production and smoke-tested |
| SQL | one additive file applied, 13 proof rows all true |
| Published | **no** — see "What needs you" |

---

## 1. The quote email now actually sends

"Email the quote" used to hand a draft to whichever mail app the phone has.
That is why it deliberately did **not** mark the quote as sent: all it could
know was that something opened.

It now goes through `mail-send` with `from_account_id: "fenceflow"` — the same
path the office uses: Resend, under your company's name, replies coming back to
you. Because that answers once the provider has taken the message, the send is
knowable and the stamp is a fact.

It goes by mail-send's own `state`, not the HTTP code:

* **sent** → stamps `quote_sent_at` (keeping an existing one, so a resend does
  not move the clock the follow-ups count from)
* **sending** → "couldn't confirm it went out, check Sent before sending again"
  — never reported as a failure, because a retry could double it
* **failed** → shows mail-send's own words, so "20 an hour reached" or "no
  mailbox" reaches you instead of just "refused". Nothing is stamped and no
  mail app is quietly opened instead.

It sends the **link**, not an attached PDF, for the reason the quote is a link
in the first place: the page shows what the job says today, where a PDF freezes
the numbers and can disagree after a re-price. Say if you would rather it
attach.

## 2. Admin, from inside the app

Sign in as a platform admin and Settings grows an **Admin** button: companies
with their plans and states, releases, the error summary, recent sign-in
attempts, and creating or inviting a company — what the console website does.

Same second factor, and that is the server's rule, not the screen's:
`is_platform_admin()` has required `aal = 'aal2'` since the r7 migration, so a
password-only session cannot read a single admin row however the screen is
written. The screen asks for the code, offers enrolment if there is no factor,
and stays hidden entirely for anyone who is not a platform admin. Eight tests
pin every combination.

## 3. Your logo, on everything a customer sees

A private bucket (`company-logos`), 2 MB, PNG/JPG/WEBP. **Not SVG** — an SVG is
a document that can carry script, and a signed URL opened directly would run it
on the Supabase domain. Nobody's logo needs that.

Upload it in **Business Settings**, either in the office or on the phone. Owner
only, and that is a policy, not politeness: both halves of the write are
owner-only in the database, and a write a policy filters out comes back as zero
rows with *no error* — so a manager allowed to pick a file would be told
nothing at all.

It then appears on:

* the **PDF** quote and contract the phone prints — as a cached file, not a
  URL, so it is there in the yard with no signal;
* the **quote page** your customer opens, and the copy she downloads (inlined,
  so it still shows months later);
* the **top of every email** FenceFlow sends on your behalf — quote, follow-up,
  contract copy. HTML only: a plain-text reader gets the letter with no line of
  URL where a picture would be, and the alt text is your company name, because
  most mail clients block remote images by default.

Nothing fails over a picture. Every signer swallows its own error; a missing
file just means no logo. Proved live against a fixture pointed at an object
that does not exist — the quote page came back whole with `logoUrl: null`.

## 4. Nine tests that were lying

Eleven of the 208 website tests were red before any of this. Two are red on
purpose (the joining specs). Two needed PDF.js, which is not in the repo —
installed, and both pass: 289 assertions.

The other seven were pinned to a name, a count or a literal line and went red
on changes that were **correct**. One mattered a great deal:

> `a18` proves the gate-post-cap fix does something by reverting it in a
> scratch copy of the pricing engine. Its needle was the exact pre-refactor
> line. That line was later pulled into a named helper — so the replace matched
> nothing, **the scratch engine became a byte-identical copy of the real one**,
> and nineteen checks compared the engine with itself and found no difference.
> Thirty-one checks in the same file passed.

It is fixed and now asserts the revert actually reverted. 51 of 51.

**206 of 208 green**; the two are the joining specs, which say so themselves.

---

## What needs you

1. **Publish, when you want it.** The APK is built and verified at **1.696**.
   I did not publish it — that reaches the other companies' phones, and you
   have not seen this build. One command when you are ready.
2. **Upload your logo** once, in the office: Settings → Business Settings →
   Company logo. Everything above is waiting on that one file; until it is
   there, every surface behaves exactly as it did before.
3. **The PDF header has not been looked at on a screen.** The logo sits left of
   your business name, scaled to fit and never stretched, and the contact lines
   indent past it — but I have only compiled and tested it, not seen it. Make
   one quote PDF after uploading the logo and tell me if the spacing is wrong.
4. **Overtime, still latent.** The office lets a company override the 40-hour /
   1.5× rule in settings; the phone hardcodes the federal default. **No company
   has set an override** (checked, with a control proving the probe can see a
   key that is there), so nothing disagrees today — but the moment someone sets
   one, the phone and the office will pay different figures. Say the word and I
   will thread the setting through.
5. **The quote email sends a link, not a PDF.** Flagged above; it is a choice,
   not an oversight.
