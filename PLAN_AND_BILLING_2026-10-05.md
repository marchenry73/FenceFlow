# Your plan: what you can see, what you can change

Answered 5 October 2026. Verified against the source; every claim was
re-checked by a second reader before it was kept.

**1. Can he see his plan, and can he change it**

Partly. The plan appears in one place only, the Billing tab, and it can be changed there only through Stripe's test-mode flow. His company row was read live on 5 October. It is active, plan Pro, with a Stripe subscription present and a $0 price, so Billing should read "Active — Pro." with "Switch down to Solo" and "Switch down to Crew" buttons. Nothing else on the page names the plan, and a language change wipes that line to "Checking your plan…" until a reload. I could not see his screen, so which of these he hit is inferred from the code.

**2. What is actually there**

- **Where to find it.** `website/dashboard.html:1206` is the Billing tab (sidebar, Account group). `:1034` is the same item in the account menu, wired at `:28847-28850`. The panel is `:2445`.
- **Where it is not shown.** The header shows only `${user.email} · ${profile.role}` (`:10384`). The plan name also appears in a trial-ending banner, but only within 7 days of the end (`:10930`).
- **How it is fed.** `my_billing_status` (`supabase_plan_starts_patch.sql:57-62`) returns `subscription_plan`. `loadBilling` (`:11871`) prints it at `:11901`: `status === 'active' ? tr('billActiveLine', plan?' — '+plan:'', ...)`.
- **Which role sees the buttons.** Plan cards render for every role (`:11928-11932`). The server refuses non-owners: `create-checkout-session/index.ts:72-74`.
- **What the buttons do.** Each calls `startCheckout` (`:12203`), which POSTs to `create-checkout-session`. For an active or trialing company with a stored subscription id, it swaps the Stripe price in place with proration and writes the label (`index.ts:151-167`, `return json({ upgraded: true, plan })`). Otherwise it opens Checkout (`:186-204`).
- **Test mode.** The price ids are Stripe test-mode (`dashboard.html:11853-11855`, ids `:11863-11867`, `welcome.html:456-460`). `GO_LIVE.md:15-16` says the secrets are test values. That is documented, not provable from the code.
- **Seat refusals.** Switching to Solo would be refused with a 409, because he has 3 logins against a cap of 1 (`index.ts:108-121`). Crew (cap 6) would go through. I did not run an end-to-end swap.
- **Staff console.** `admin.html:618-627` has a Plan dropdown. `:3273` disables it when a Stripe subscription id exists, with the note "Set by Stripe — change it there, not here." His company has one, so it is locked for him, with no link anywhere.
- **Direct writes.** An owner's own UPDATE of the plan is silently reverted by `protect_billing_columns` (`supabase_r7_admin_second_factor.sql:168`, `new.subscription_plan := old.subscription_plan;`).

**3. Why he cannot do it**

Nothing is missing outright. The problems are these:

- **Plan not visible.** It appears nowhere except Billing. `#billState` carries `data-t="billCheckingPlan"` (`:2449`). `setLang` (`:8686`) runs `applyStaticText()` and redraws only `[renderFollowUps, renderAttention]` (`:8696`). After any language change the line reads "Checking your plan…" and stays that way.
- **Reproduced.** I reproduced that reset in a browser. The key exists in all three tables, so this is overwrite by design, not a missing key.
- **Can stick on its own.** `loadBilling` has one caller, the tail of `loadAll` (`:11839`). If anything earlier in `loadAll` throws, the placeholder stays. This is read from the code, not tested. Opening the tab never refreshes it, because `switchTab` (`:29199`) does not call `loadBilling`.
- **Change buttons overstate what they do.** They are real but test-mode, with no confirmation, and they alter a live Stripe test subscription with proration. The Pro card also prints a hardcoded "$349/month" (`:11936`) while his stored price is $0.
- **No hand route.** The only way to set his label without Stripe is SQL as the service role, because both the staff dropdown and the owner write are blocked.

**4. The smallest honest fix**

Only `website/dashboard.html` changes. No SQL and no edge-function change is needed.

1. **Show the plan in the header.** Add a `<span id="planChip">` beside `#who` (`:10384`). Fill it from JS where `loadAll` already reads the plan (`:11434`), for example "Plan: Pro". Do not put `data-t` on it. Give it `data-acct="billing"` so the existing handler (`:28847`) opens Billing. For a blank plan, show "Full access (no paid plan)".
2. **Stop the Billing line being erased.**
   - Remove `data-t` from `#billState` (`:2449`).
   - Cache the last billing row and split `loadBilling` into fetch and paint.
   - Add the paint step to the `setLang` redraw list (`:8696`).
   - Call `loadBilling()` from the `billing` case in `switchTab` (`:29199`).
3. **Fix the failed-read case.** After the error text at `:11881-11886`, `return`. Today it falls through to `:11955` and shows "Choose Solo/Crew/Pro" to someone who may already be paying. Show the buttons to OWNER only (`profile.role === 'OWNER'`). Others see the plan, read-only.
4. **Make the change honest.**
   - Add a `confirm()` in `startCheckout` before an in-place swap: "Switch to Crew now? Your Stripe subscription changes immediately and is prorated."
   - Add `const STRIPE_TEST_MODE = true` beside `PLANS` (`:11853`), flipped with the price ids at go-live. While true, show a Billing note: "Test mode: plan changes use Stripe test cards. No real money moves."
5. **Replace the missing controls with a stated reason.** Add one line on Billing: "To cancel, change your card, or get a plan the cards don't offer, email support@fenceflowapp.com." That mailto already exists on the public pages. For `past_due`, stop showing "Choose X" buttons (see section 5).

New translation keys, in en, es and fr: `planChipLabel`, `planChipNone`, `billTestModeNote`, `billSupportNote`, `billConfirmSwitch`. Verify all three tables, since a missing key erases the element.

A real card-update or cancel control needs a new Stripe customer-portal edge function and a portal setup in each Stripe mode. The customer id is already stored for 4 companies. That is a separate piece of work.

**5. Advertised but not enforced, or enforced but not advertised**

Advertised, not enforced or not delivered:
- **"Cloud photo & document backup" (Pro).** `index.html:591`. Every plan gets it. `FileSync.kt:32-64` has no plan check, and the storage policies are company-scoped only.
- **"Cost breakdowns" (Pro).** `index.html:588`. The "Where the money goes" chart is ungated for Crew (`dashboard.html:18127-18132`, `ReportsScreen.kt:303`). The comment at `dashboard.html:18125-18126` describes a gate that is not in the code.
- **"Priority support" (Pro).** `index.html:592` is a label only. There is one shared mailbox. The office dashboard shows no support address.
- **"Cancel any time".** `index.html:607` and `:721`, `terms.html:171`, `welcome.html:174`. There is no cancel control. Cancelling happens only in the Stripe dashboard, which `billing-setup/index.ts:112-116` confirms.
- **"Update your card".** Shown at `dashboard.html:4589`, `:4594` and `:10929`, and in the chase email at `admin.html:3510`. A `past_due` owner lands on Choose buttons. `index.ts:152` treats `past_due` as a new checkout, so it creates a second subscription (no trial). The webhook overwrites the stored id, and no code cancels the old one, so there is a double-charge risk.
- **Three identical "Start free trial" buttons.** `index.html:560`, `:577` and `:594`. The plan clicked is dropped and `welcome.html` asks again. No wrong plan is charged.
- **"Monday morning business digest" (Pro).** It is a phone notification only (`WeeklySummary.kt:61`), and the plan pages never say so.
- **New-owner phone-app step.** `welcome.html:201-202` says to install the app, with no link and no Android-only note.
- **Test mode.** No public page says Checkout takes test cards only.

Enforced, not advertised:
- **Solo hides three tabs no card names.** Production, Materials and Automation are hidden for Solo (`dashboard.html:26873-26878`). This is client-side only.
- **Card links refused for Solo, server-side.** `create-payment-link/index.ts:750`. A blank plan is allowed through.
- **Profit and aging reports gated server-side.** They are refused for solo and crew in `business_report`, `job_costing` and `ar_aging`. The deny-list is exactly those two labels, so any other label gets full access.
- **Blank plan means four things.**
  - Joining: capped at 1 login (`supabase_join_company_guard.sql:61`).
  - Billing and seat line: "no limit" (`dashboard.html:11981-11993`).
  - Admin dropdown: "nothing unlocked" (`admin.html:622`).
  - Reports and card links: full access.
- **MRR tile counts his company at $349.** `admin.html:2216-2218` uses list price, though he pays $0.
- **Go-live will break his in-place changes.** It needs three price ids swapped in two files and two Stripe secrets. The 4 stored test subscription ids, his included, will fail under a live key.
- **Stuck trials.** Legacy (10 Sep) and Marc (14 Sep) are still "trialing" past their trial end, and PeterLLC's trial ends today. Webhook delivery is unreliable, and the cause is not visible from the repo.

Lead form: nothing in these findings covers it, so this answer says nothing about it.

**Checked and not true**
- "His company is blank-plan, so the 'Full access' sentence hides his plan": his row is Pro with a Stripe id, so `dashboard.html:11947-11953` is not reached.
- "The plan is staff-only": Billing shows it to every role.
- "The plan buttons are inert": they call `create-checkout-session` and work, owner-only and in test mode.
- "A missing translation key erases the plan text": no key is missing in the dashboard, admin, index or welcome tables. The erase found is `#billState` being overwritten.
- "Nothing reads Stripe's real price back": the webhook writes `unit_amount` to `monthly_price` (`stripe-webhook/index.ts:846`, `:865`).
- "The webhook is the only writer of the plan": `create-checkout-session/index.ts:166` and `admin.html:3341` also write it.
- "A Stripe dashboard edit blanks the plan": the webhook exits at `index.ts:806` without `company_id` metadata, and an edit leaves the old plan in place.
- "The admin Account tab shows the plan": it does not. The Companies tab does.
- "Seat caps on the cards all agree with the page": not for a blank plan.