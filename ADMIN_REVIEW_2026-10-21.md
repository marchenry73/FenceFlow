# The admin console, compared with other people's — 21 Oct 2026

Compared against vendor-side consoles in other industries: Stripe Dashboard,
Shopify Partners, Vercel, Sentry, PostHog, Supabase's own dashboard, Forest
Admin / Retool / Django-admin style back-offices, Metabase, WorkOS for support
access.

**Nothing below is taken on trust.** The outside research was done without
reading our code, so every "we don't have it" was then checked against
`website/admin.html` and the live database. Four of its findings were already
wrong, and they are corrected here.

---

## What we already have (and the research missed)

| It said we lack | We actually have |
|---|---|
| Revenue visibility | **MRR at list price** on Overview, plus Companies / On trial / Paying / Suspended, with an honest "at least this many" note when the list is paged |
| Data export | **Export CSV** on the Companies panel |
| Notes per company | **"Notes (only you see these)"** on the company editor |
| An audit trail | **`audit_log`, 5,163 rows** — actor, actor email, table, record, action, field, old value, new value, label |
| Plan/price control | Deliberately read-only: **"Set by Stripe — change it there, not here"** |

So the score it gave (4/10) is too harsh. On what is actually there I'd put it
at **6/10**, and the single biggest gap is not a missing feature — it is that
the audit log has **no screen at all**. Five thousand rows of exactly the thing
auditors and customers ask for, invisible.

---

## Where it is genuinely behind

| Area | Score | What the better ones do |
|---|---|---|
| Account / tenant management | 7 | A per-account timeline: contacts, who is in this account, what changed when |
| Billing and revenue | 5 | Stripe Billing shows MRR roll-forward, trial→paid conversion, churned MRR; **failed payments with retry state** is the one we have nothing for |
| Usage and engagement | **2** | Last sign-in, active users in 30 days, activity against the account's own baseline. Supabase has an Active Users chart; Shopify Partners shows installs and uninstalls |
| Errors and reliability | 6 | Sentry's release health: crash-free rate **per version**, adoption, regression tags, resolve/ignore |
| Audit trail | **3** | The rows exist; Forest Admin, Retool and Django all *show* them, searchable and exportable |
| Support tooling | **1** | "View as this company", read-only, reason required, banner shown, expires, logged. WorkOS and Lightdash both work this way |
| Communication | 2 | Targeted in-app banners by plan/version/company (Intercom), not just a mandatory-update flag |
| Feature flags | 3 | Per-company override with a kill switch and change history (PostHog buckets by company) |
| Search | 5 | Cross-entity: company, user email, job, quote number → jump to the record |
| Access control | 5 | A read-only second role. Low priority while you are the only admin |

**Overall: 6/10.** It is a sound operator's cockpit for lifecycle and
reliability — trials, suspend, versions, crashes, MRR. What it cannot tell you
is whether anyone is *using* the product, and it cannot show you its own
history.

---

## What to add, best value per effort first

1. **Show the audit log.** The table is already full. One panel: filter by
   company, actor and date, with CSV. *Small — and it is the highest-value
   thing on this list.*
2. **Health columns on Companies.** Last sign-in, active users in 30 days,
   jobs and quotes created in 30 days, red/amber/green at 30+ days dormant.
   The cheapest churn signal that exists. *Small.*
3. **Alerts to your phone.** New crash group, crash spike after a release,
   trial ending in 3 days, failed payment. You act on pushes, not panels.
   *Small.*
4. **Failed-payment panel.** Customer, amount, attempt count, next retry.
   Mostly reading Stripe. *Small–medium.*
5. **Release adoption.** Share of companies per version, crash-free rate per
   version, who is stuck behind a mandatory update. *Small–medium.*
6. **Weekly digest email to yourself.** At-risk companies, trials ending,
   crashes, failed payments, usage dips. *Small.*
7. **Cross-entity search box.** *Small.*
8. **Link each crash to a company and a version**, with resolve / ignore and a
   "came back" tag. *Small–medium.*
9. **Announcements** — banner by plan, version or company, with dates.
   *Small–medium.*
10. **Trial lifecycle emails** at 7, 3 and 1 days, and a trial-ended nudge.
    *Medium.*
11. **Revenue detail**: MRR movement month over month, trial→paid conversion,
    churned MRR. *Medium.*
12. **Read-only "view as this company"** — reason required, banner, 60-minute
    expiry, both identities logged. *Medium.*
13. **Per-company feature override** with a kill switch and history. *Medium.*
14. **Per-company export and delete** — one action that bundles everything a
    company owns, one that removes it on request. *Medium.* Also the tool the
    compliance duties below are satisfied with.
15. **Plan usage vs limits** (seats, storage) with threshold alerts. *Small.*
16. **Export on every panel**, not just Companies. *Small.*
17. **A read-only second admin role**, when there is a second person. *Small.*

---

## The compliance side

Not legal advice, and the research flagged parts of this as unverified.

- **Logging admin actions** is what a SOC 2 auditor asks for (actor, action,
  timestamp, affected record) and is a normal GDPR Article 32 measure. We
  already write it; it should also be **append-only**, so the console cannot
  edit its own history.
- **Impersonation**: no law found requiring per-session consent, but the
  practice everywhere is reason required, banner visible, session expires,
  both identities logged, and the customer able to see that log. Our terms
  should say support may access accounts.
- **Export and deletion**: as the vendor we are a processor for our customers'
  client data. GDPR Article 28 requires assisting with data-subject requests
  and returning or deleting data when the service ends. Real duties only if EU
  or UK personal data is held. US state law (CCPA and friends) was not
  researched.

Sources the research could verify: docs.stripe.com (billing analytics, revenue
recovery, dashboard roles), workos.com/docs/authkit/impersonation,
docs.lightdash.com, posthog.com/docs/feature-flags,
docs.forestadmin.com, metabase.com/docs, shopify.dev, docs.sentry.io/product/releases,
supabase.com/docs/guides/observability/reports, gdpr-info.eu/art-28-gdpr.
Not verified: Intercom's own docs, Stripe dashboard search, Vercel's audit log,
and whether GDPR requires logging explicitly.
