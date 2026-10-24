# FenceFlow competitor matrix

**Access date for every web source below: 2026-10-24** (the day this was written).
Prices change; re-read the cited page before quoting any number externally.

## How to read this document

Each claim is tagged with how I know it:

- **[read]** I fetched the page itself and read it.
- **[snippet]** I only saw a search-result summary of the page (the page blocked my fetch, or I did not fetch it). Weaker evidence; the URL is given so you can check.
- **[vendor-pub]** Published by a rival vendor that ranks itself first (Contractor+, Projul, MyQuoteIQ). Promotional.
- **[inferred]** My reasoning, not a sourced fact.
- **unverified** I could not confirm it. Where I know why, I say so.

**Review coverage limits (important).** Capterra, G2 and community.getjobber.com returned HTTP 403 to my fetches, and the search tool refuses reddit.com. So I read **no** review page directly and **no** Reddit threads at all. Every complaint below comes from search-result summaries of review sites (marked [snippet]) and is a signal, not a sample. I found no independent review of Visual Fence Pro or FenceTracer.

**FenceFlow's own facts.** The facts you gave me are used as given. Two extra FenceFlow facts come from files I could check: the plan prices (Solo $99 / Crew $199 / Pro $349, with 1 / 6 / unlimited logins) are from the project's plan-tier notes dated 2026-08-24 and were not re-verified against live Stripe prices today; the QuickBooks finding comes from reading `website/dashboard.html` today (section 5, B1).

---

## 1. Pricing and plans

| Product | Tiers and dollar amounts (as published) | Trial | Source |
|---|---|---|---|
| **Jobber** | List prices after the promo period, per month. Annual: Core $29 (1 user), Connect $99 (1 user), Grow $149 (1 user), Plus $399 (5 users). Monthly no-commitment: Core $49, Connect $139, Grow $199, Plus $499 (5 users). Extra users $29/mo each. First-period promo prices are lower. | 14 days, full Grow access, no card | [read] https://getjobber.com/pricing/ |
| **Housecall Pro** | Basic $59 annual / $79 monthly (1 user); Essentials $149 / $189 (5 users); Max $299 / $329 (8 users, +$35 per extra user). The page also shows a "$XX/mo" placeholder on some plans, so some figures are unconfirmed. | 14 days, no card, full MAX access | [read] https://www.housecallpro.com/pricing/ |
| **Contractor Foreman** | Annual-billed, per month: Basic $49 (1 user), Standard $105 (3), Plus $166 (8), Pro $221 (15), Unlimited $332. Monthly-billed: Standard $139, Plus $199, Pro $279, Unlimited $399 (Basic is annual only). | 30 days on annual plans; monthly plans state none | [read] https://www.contractorforeman.com/pricing/ |
| **ServiceTitan** | No dollar amounts. Tiers Starter / Essentials / The Works, "Request Pricing", per-technician. | None stated; demo only | [read] https://www.servicetitan.com/pricing |
| **Joist** | Basics $12 monthly ($8.34 or $10 annual; the page is inconsistent); Pro $17 ($14.17); Elite $32 ($26.67); Run $100 ($58.33). AI Receptionist add-on $49/mo. | 14 days, no card | [read] https://www.joist.com/pricing/ |
| **ArcSite** | Annual / monthly per month: Draw Basic $10 / $14.99; Draw Pro $30 / $34.99; **Takeoff $99 / $119.99**; **Estimates $129 / $159.99** (proposals, approvals, payments, invoicing); Enterprise custom. The page does not say whether prices are per user. | 14 days on Draw plans; Takeoff and Estimates say "Book Demo" | [read] https://www.arcsite.com/pricing |
| **Fence Cloud** (Software Design Associates; sold through Merchants Metals) | Essential $220/mo (1-3 users), Professional $345 (4-10), Ultimate $545 (11-16), Enterprise: call. Annual: $2,200 / $3,450 / $5,450 per year. Every tier has the full feature suite. | None stated; demo | [read] https://fence.cloud/pricing and https://fence.cloud/ |
| **Visual Fence Pro** | "Founder rate" (50% off, locked in "if you sign up by Oct 31, 2026"): Free Forever $0 (1 user, 10 estimates/month); Starter $39 (list $79); Pro $89 (list $179); Enterprise $149 (list $299). A July 2026 third-party guide listed a different promo (70% off through Aug 31), so the promo keeps changing. | No trial; free tier instead | [read] https://www.visualfencepro.com/ ; [vendor-pub] https://myquoteiq.com/best-satellite-measuring-software-fencing-businesses-2026/ |
| **QuoteIQ** (MapMeasure Pro) | Own pricing page: Essentials $29.99, Beginner $99.99, Pro $199.99, Elite $299.99, Max $699.99 per month; extra users $25. The July 2026 MyQuoteIQ guide listed $29.99 / $74.99 / $149.99 / $299 / $699, so prices moved. The vendor pricing page does not mention fencing. | 14 days, card required | [read] https://myquoteiq.com/pricing/ ; [vendor-pub] the guide above |
| **DripJobs** (fencing CRM page) | Pro $97/mo, Advanced $147/mo; "no long-term contracts". | None stated | [read] https://dripjobs.com/fencing-business-crm |
| **Houzz Pro** | **Unverified.** The vendor fence page lists no prices. Third-party sources conflict ($99 / $199 / $399+ in one set of blogs; "starting at $399" on review listings). | "Start Free Trial" button, length not stated | [read] https://pro.houzz.com/for-pros/software-fencing-contractor ; [snippet] https://capterra.com/p/199689/Houzz-Pro/ |
| **Contractor+** | **Unverified.** No official price found. Third-party listings say free for 1 user, PRO from $29/user, PRO TEAM from $58; App Store paywall data is inconsistent and dated Sept 2024. | Reported 14-day PRO trial | [snippet] https://www.g2.com/products/contractor/software_advice_form_fill/new ; [vendor-pub] https://contractorplus.app/blog/8-best-fence-contractor-software-platforms-in-2026 |
| **FenceTracer** (Canada) | CA$180/mo flat per Capterra listing (currency label inconsistent across regional pages). Capterra shows zero reviews. | Free trial noted | [snippet] https://www.capterra.com/p/10045959/FenceTracer/ |
| **FenceFlow** | Solo $99 / Crew $199 / Pro $349 (1 / 6 / unlimited logins) | 14 days, card up front | Project notes 2026-08-24 (not re-verified today) |

---

## 2. Capability matrix

Legend: **Y** = stated on a page I read; **Y?** = stated only in a snippet or vendor-pub source; **N** = the source says the opposite or says it is manual; **-** = nothing found on the pages I read (not proof it is absent); **unv** = unverified.

| Product | Fence material takeoff (posts/panels/pickets/concrete) | Scheduling | Crew mgmt | Time tracking | Mobile app | Offline | Customer mgmt | Invoicing / payments | Reporting |
|---|---|---|---|---|---|---|---|---|---|
| **Jobber** | **N**: "enter your material and labor costs with markups"; no takeoff or material calculation claimed [read] https://getjobber.com/industries/fence-software/ | Y (all tiers) | Crew scheduling with team @mentions on Plus only | Time and expense tracking from Connect; automatic time tracking from Grow | Y | Effectively none: staff say only internal notes work offline [snippet] (see section 3) | Y | Y; online payments on Core; QuickBooks Online sync from Connect | Built-in performance reporting; custom reports on Plus |
| **Housecall Pro** | **N** as a feature; price book and custom line items. Contractor+ describes "linear-foot via custom line items" [vendor-pub] | Y; dispatch | Y; employee GPS tracking from Essentials | - (GPS tracking and commissions on Essentials) | Y | **Partial, read-only.** "Editing without cell service or WiFi connection is not supported at this time." A job must have been opened online first. [read] https://help.housecallpro.com/en/articles/4747652-housecall-pro-mobile-faq | Y | Y; payments, consumer financing (Basic), QuickBooks Online (Essentials) | Job costing (Basic); others not itemised |
| **Contractor Foreman** | Takeoffs listed generally, not fence-specific; estimates with e-signature [read] https://www.contractorforeman.com/features/ | Y; Gantt, crew scheduling with reminders | Y | Y; time cards with GPS and geofencing | Y | **unv** from the vendor (features page silent); reviewers report clock-in failing on poor signal [snippet] | Y; client portal, leads | Y; invoices, online payments, Stripe, QuickBooks | Job-costing reports tied to time cards |
| **ServiceTitan** | - (no fence takeoff stated) | Y (not itemised on pages I read) | Y (not itemised) | Works offline per help article | Y | **Y, broad.** Estimates create/edit offline, time tracking, signatures, photos; payments queue; contracts/proposals and financing need a connection. [read] https://help.servicetitan.com/docs/servicetitan-field-mobile-app-offline-capabilities ; marketing says "all its features are available in offline mode" [read] https://www.servicetitan.com/features/field-mobile-app (broader than the help article) | Y | Y | Y (not itemised) |
| **Joist** | **N** stated; plans list line items, photos, work orders | Run plan only ("visit scheduling") | - | - | Y (iOS/Android) | **unv.** No Joist statement found either way | Y; unlimited clients on Pro | Y; online payments, estimates-to-invoices | Business and sales reports on Elite |
| **ArcSite** | **Y.** Fencing page: takeoffs for posts, panels, pickets and concrete [read] https://www.arcsite.com/pro/fencing . Automated takeoff is on the paid Takeoff tier ($99+) [read] pricing page | Y? (fence page lists scheduling) | - | - | Y (tablet/phone) | **Y, partial.** Open/edit synced projects, create drawings, add products, photos, preview proposals offline. Login, sending proposals, team sync, loading a never-downloaded project, and QuickBooks/Salesforce sync need a connection. [read] https://support.arcsite.com/en/articles/14291214-using-arcsite-offline (the pricing page itself does not mention offline) | CRM listed | Estimates tier: proposals, e-approval, payments, invoicing | Reports and dashboards on Takeoff tier |
| **Fence Cloud** | **Y** (material breakdown for chain link, wood, vinyl, ornamental; 100+ supplier catalogs) [read] https://fence.cloud/ | Calendars, text/email reminders | "Teams" mentioned, nothing dedicated | - not mentioned | Not specifically; "from anywhere you have service" | - not mentioned (wording implies a connection) | Lead and estimate tracking | "Invoices & Orders" on the pricing page; the home page lists contracts, work orders, estimates | - |
| **Visual Fence Pro** | **Y** (vendor claim): draw runs on satellite maps, automatic bill of materials, 42 styles [read] vendor pricing page; [snippet] G2 listing. No independent review found. | Pro and above | - | - | Listed iOS and Android; desktop apps too | - not mentioned | "Customer CRM & Bid Scheduling" | E-signature (all plans), Stripe and QuickBooks (Pro+) | Dashboard analytics (Pro+) |
| **QuoteIQ** | Satellite linear-foot tracing; fence material inventory on Elite+ per vendor-pub guide. Vendor pricing page does not mention fencing. | Y? | - | - | Y (iOS/Android) | - | Y? | Y? | - |
| **DripJobs** | Linear-footage estimating (wood, vinyl, chain link, aluminum, composite) with itemised gates; job costing tracks posts, rails, pickets, concrete, hardware. The page does not use the word "takeoff". [read] | Crew assignment, Google Calendar sync | Y | - | Phone use for proposals and deposits | - | Y (CRM) | Invoices, deposits | Job costing on Advanced |
| **Houzz Pro** | **Y?** takeoff tool: wood, chain link, fittings, gates; upload plans and mark up [read] https://pro.houzz.com/for-pros/software-fencing-contractor | Y | - | Y (stopwatch; adds to invoices) | Y | View-only; creating or editing while disconnected errors [snippet] https://pro.houzz.co.uk/pro-help/r/offline-mode-on-the-houzz-pro-app | Y | Y | Exports, QuickBooks Online sync |
| **FenceTracer** | **Y?** drawing-based takeoff incl. fabric, posts, hardware [snippet] | Y? drag-drop crew scheduler | Y? worker app | - | Y? iOS/Android | - | Pipeline view | Quotes with HST/QST | - |
| **Merchants Metals Fe-Fence Estimator** (supplier tool) | Web tool: breaks a job down at the customer's own supplier pricing and submits orders; **existing Merchants Metals customers only** [snippet] https://www.merchantsmetals.com/fence-estimator/ | - | - | - | - | - | - | - | - |
| **FenceFlow** | **Y.** Traced over satellite or grid: posts, panels, pickets, rails, concrete bags, gates; two engines held to byte-identical agreement by a 91-fixture gate | Y | Y (roles; Crew/Pro plans) | Y (clock in/out, time entries) | Y (Android) + web office portal | **Y** (Room database, sync) | Y | Y; Square and Stripe per project notes; cash/check on Solo | Y (profit/margin analytics, AR aging on Pro) |

**Supplier estimators (PoolCorp and others).** I searched for Master Halco, Fastenal and Merchants Metals estimators. Only the Merchants Metals one turned up (above). I could not confirm an estimator from Master Halco or Fastenal, and I did not research PoolCorp specifically: **unverified**. Search also returned several machine-generated "9+ Best Metal Fence Calculators" pages on unrelated domains; I discarded them.

---

## 3. Customer complaints (what people say)

All are [snippet] unless stated. I could not read Capterra, G2 or Reddit directly.

- **Jobber.** (a) Offline: Jobber staff on the community forum say the app has no offline support except internal notes; notes show "Waiting to sync until online", teammates cannot see them until sync, files cannot be attached offline, and an unsynced note is lost if you log out, delete or update the app. https://community.getjobber.com/discussions/job-details-scheduling/struggling-with-accessing-job-info-in-remote-areas-%E2%80%93-any-offline-workarounds/5262 . (b) Billing: a BBB complaint says a user was charged for an accidentally added user and refused a refund (https://www.bbb.org/ca/ab/edmonton/profile/computer-software/jobber-0017-214334); a competitor's compilation page claims an automatic $68,000 refund, which I treat as unverified (https://myquoteiq.com/jobber-reviews/). (c) Clumsy job closing, duplicate notifications, onboarding and support complaints: https://softwarefinder.com/field-service/jobber/reviews?page=2 .
- **Housecall Pro.** Trustpilot reviewers describe slow or generic support and constant software changes; Software Advice reviewers mention lag and bugs when managing multiple jobs; one Capterra reviewer says it is expensive while others call it fair. Capterra support score cited as 4.7/5. https://www.trustpilot.com/review/housecallpro.com?page=2 , https://www.softwareadvice.com/field-service/housecall-profile/reviews/ . I found no source for a price-increase complaint.
- **Contractor Foreman.** A reviewer says the team cannot clock in or use the app when the connection is poor and calls it their biggest problem; GetApp's summary mentions limited offline functionality; billing complaints (charged six months after six days of use; refund terms hard to meet) and slow support. https://capterra.com/p/166113/Contractor-Foreman/reviews/ , https://www.getapp.com/sales-software/a/contractor-foreman/ . App Store: 4.3 average, 176 written reviews, 79.5% positive, per https://appshunter.io/ios/app/contractor-foreman/id1239787613/reviews .
- **ServiceTitan.** Cancellation and contract complaints (a Trustpilot reviewer quoted a $29,000 cancellation fee after trying to cancel within 90 days of buying Market Pro; a Capterra reviewer locked in for two years; a G2 reviewer says cost doubled mid-contract) and "built for larger operations". Editorial sources suggest Jobber or Housecall Pro for 1-10 technician shops. https://www.g2.com/products/servicetitan/reviews_and_filters , https://at.trustpilot.com/review/servicetitan.com , https://projul.com/blog/servicetitan-pricing-analysis-2026 (vendor-pub).
- **Joist.** Basic reporting, weak project tracking (cannot assign job names to estimates and invoices), QuickBooks Online as the only integration, features gated by tier, a fee on received payments, and some reports of downtime and slow support, including a 1.0/5 "from great to garbage" review. SelectHub reports 82% satisfaction across 111 reviews. https://www.capterra.ie/reviews/1004933/joist , https://www.selecthub.com/p/contractor-software/joist-com/ .
- **ArcSite.** Capterra overall 4.7 (160 reviews per the snippet). Complaints: crashes and white-screen resets on iPad, slowness around 70+ elements, bugs unresolved for months, price significant at small-business level, one reviewer says it "doesn't work offline sometimes". Support is praised. https://capterra.com/p/156735/ArcSite/reviews/ . I found no report of lost drawings.
- **Fence Cloud, Visual Fence Pro, FenceTracer.** No independent reviews found (FenceTracer: Capterra shows zero). The Visual Fence Pro G2 page is vendor-controlled.
- **Cross-cutting themes [inferred]:** (1) the app does not work without signal, (2) per-user pricing and tier gating, (3) slow or scripted support, (4) contract or refund traps. FenceFlow addresses (1) directly and, with seats included, partly (2).

---

## 4. Section A: where FenceFlow is genuinely stronger

**A1. Fence takeoff inside a job-management product at this price. Evidence: strong against the horizontal tools, narrower against fence-specific ones.**
- Jobber states quoting is manual cost-plus-markup [read]. Housecall Pro, Joist and ServiceTitan publish no fence takeoff on the pages I read. FenceFlow produces a posts/panels/pickets/rails/concrete/gates list from a traced drawing. That gap in the horizontal tools is verified for Jobber and "not found" for the others.
- Against fence-specific tools I must not overstate it. ArcSite sells takeoff for posts, panels, pickets and concrete [read]; Visual Fence Pro claims satellite tracing with an automatic bill of materials (vendor-stated, no independent review); Fence Cloud generates material breakdowns. So "nobody else does takeoff" is false. The defensible claim is: I could not find another product that combines takeoff, scheduling, crew time and payments in one product, with a published price under about $350/month and an offline app.
- Price [inferred from section 1]: Fence Cloud is $220-$545/month for 1-16 users; FenceFlow is $99 / $199 / $349. The ArcSite comparison is unresolved because its page does not say whether prices are per user.

**A2. Offline that includes creating and editing. Evidence: strong against Jobber, Housecall Pro and Houzz Pro; not unique against ArcSite or ServiceTitan.**
- Verified: Jobber has essentially none (notes only), Housecall Pro is read-only, Houzz Pro is view-only, Contractor Foreman reviewers report clock-in failing on weak signal.
- Not unique: ArcSite lets you draw, add products, photograph and preview proposals offline, and ServiceTitan officially supports offline estimates, time tracking, signatures and queued payments. FenceFlow's position is "ArcSite-style offline drawing plus the rest of the job, at small-shop price", not "the only offline fence tool".
- Caveat: I did not test FenceFlow offline beyond what you stated. The competitors' own lists of what still needs a connection (login, sending a proposal, loading a job never opened) are a good checklist to test FenceFlow against before this is claimed in marketing.

**A3. Pricing parity gate (phone Kotlin vs server TypeScript, 91 fixtures). Evidence: absence only.**
- I found no competitor claiming to prove two pricing engines agree. That is absence in marketing copy, not proof rivals lack it. The value is [inferred]: the contractor never quotes one number on the phone while the office or the customer sees another. It is real engineering, but customers cannot see it unless it is expressed (improvement 4).

**A4. Customer-approvable quote page with a 3D fence view. Evidence: partial.**
- Online approval is table stakes: Jobber lets clients approve, request changes, pay a deposit or sign [read]; ArcSite Estimates has digital approvals; Visual Fence Pro has e-signature and Stripe payments. What I did not find in any rival source is an interactive 3D view of the customer's own measured layout. Visual Fence Pro advertises AI renders (2 per day on the free tier), a generated image rather than a model driven by the measured drawing. The 3D view is the differentiator; the approval page is not.

**A5. Crew clock-in/out and time entries inside the plan. Evidence: moderate.**
- Jobber puts time tracking at Connect (list $99-$139) and automatic tracking at Grow; Housecall Pro puts employee GPS tracking at Essentials ($149-$189); FenceFlow Crew ($199, 6 logins) includes it. Contractor Foreman is cheaper ($49 Basic annual, geofenced time cards), so this is a strength against Jobber and Housecall Pro, not against Contractor Foreman.

**A6. A stated, simple price with seats included and a 14-day trial. Evidence: moderate.**
- ServiceTitan publishes no price; Jobber and Housecall Pro use multi-axis grids with changing promo first-period prices; Jobber adds $29 per extra user; Fence Cloud has no trial. [Inferred] QuoteIQ and Visual Fence Pro changed their published prices within a few months of each other (section 1), so a public price-lock promise is a credible differentiator.

---

## 5. Section B: where FenceFlow is weaker or missing something contractors need

FenceFlow items are tagged as verified in source today, or taken from older project notes and not re-verified.

**B1. Accounting integration is a CSV export, not a sync.** [Verified in source today] `website/dashboard.html` has a "QuickBooks CSVs" button that downloads three files (customers, invoices, payments) for manual import; the code comment says "Not a sync". Jobber (Connect+), Housecall Pro (Essentials+), Contractor Foreman, ArcSite, Visual Fence Pro (Pro+) and Joist all list QuickBooks sync on pages I read. It is the most commonly listed integration among rivals.

**B2. Consumer financing.** Jobber, Housecall Pro (Basic), ArcSite (Estimates) and Contractor Foreman (SweetPay) list it [read]. FenceFlow: project notes from early September list Wisetack as a pending runbook item. A grep of the repo today found no Wisetack or Twilio matches in the app source, edge functions or dashboard (matches only in docs, one workflow file and two test files, which I did not open). Status in the live product: **unverified**. Fence jobs are large-ticket, so this plausibly affects close rate [inferred].

**B3. Quote follow-up and a customer hub.** Jobber lists automated quote and invoice follow-ups (Connect) and client reminders [read]. Project notes from 2026-09-07 say nothing chases a quiet quote and the quote page "is a page, not a hub". Today's backlog (`docs/overnight-2026-10-24/MASTER_BACKLOG.md`) says the scheduled-email backend is committed but has no UI on either surface and needs a trigger secret before it can run, so this gap is partly built and not usable. [Verified in the backlog; the backlog itself says the new sweep is untested.]

**B4. Two-way SMS.** Jobber lists two-way SMS on Grow [read]. FenceFlow's notes list Twilio as a pending runbook item (see B2 for what I did and did not check). Email-only follow-up is weaker than text for field customers [inferred]. Status: **unverified**.

**B5. Drawing precision.** Project notes from 2026-09-07 say ArcSite offers typed exact lengths, tap-to-dimension, angle lock and custom snap points while FenceFlow has a one-foot nudge pad and a loupe. Today's backlog lists the undo/redo timeline as built but not wired, and gate editing and a move-scope chooser as not started. ArcSite is also the best-reviewed direct rival (4.7 on Capterra per the snippet), so contractors will compare precision against it.

**B6. No independent review record or store listing.** Project notes from 2026-09-07 say there is no Play Store listing and no review record (not re-verified today). Rivals show hundreds of reviews (Trustpilot lists 583 for Housecall Pro; ArcSite 160 on Capterra per snippet; Contractor Foreman 176 App Store reviews). For a $99-$349/month purchase, an empty review page is a conversion cost [inferred].

**B7. iPhone.** Every mobile product in the matrix shows iOS and Android apps (Jobber, Housecall Pro, Contractor Foreman, Joist, ArcSite, FenceTracer and QuoteIQ by snippet or vendor page; Visual Fence Pro states both). FenceFlow is an Android app plus a web office portal. [Inferred] An iPhone user can reach only the portal. I did not verify how well the portal works on a phone.

**B8. Reporting and job-costing depth versus Contractor Foreman.** Contractor Foreman lists time cards feeding job costing, change orders, purchase orders, AIA-style billing and bid management [read]. FenceFlow has profit/margin analytics, cost breakdowns and AR aging on Pro. Most small residential fence shops do not need AIA billing, so this matters mainly for commercial work. Notes from 2026-09-07 say job costing is thinner; not re-verified.

**B9. Supplier pricing and ordering.** Fence Cloud advertises 100+ supplier catalogs [read]; the Merchants Metals estimator submits orders to local service centers at customer-specific pricing (existing customers only) [snippet]. FenceFlow prices from the contractor's own catalog (the project has a catalog editor); live supplier pricing or one-click material orders: **not found in anything I read**. A takeoff is most valuable when it becomes a purchase order [inferred].

**B10. Extras that are probably not worth chasing.** Jobber Plus lists a marketing suite, pipeline and AI receptionist; Joist sells an AI Receptionist at $49/mo; Housecall Pro lists recurring service plans and route optimization. Recurring plans do not fit fence installs; route optimization may matter for multi-crew shops.

**B11. Continuity and trust signals.** [Inferred] A single-developer product that holds a contractor's payments and payroll-adjacent data needs visible proof of continuity (backup statement, full export, support response time). Rivals draw complaints about contract traps (ServiceTitan) and surprise charges (Jobber, Contractor Foreman), which leaves room for an explicit "cancel anytime, export everything" statement.

---

## 6. Section C: the five improvements with the most value, ranked

Ranking logic: how often rivals publish the capability (buyers expect it) x how close a prospect is to paying x how cheaply FenceFlow can build it from what exists. The first two raise close rate; the next three protect trust and the core product.

**1. Live QuickBooks Online sync (customers, invoices, payments) in place of the CSV export.**
Why first: I found QuickBooks sync on the pricing or feature page of Jobber, Housecall Pro, Contractor Foreman, Joist, ArcSite and Visual Fence Pro. A contractor with a bookkeeper hears "export three CSVs and import them by hand" as "not finished". The three export shapes already exist in the dashboard, so the data mapping is mostly done. Risk: OAuth and duplicate handling are real work; start one-way (FenceFlow to QuickBooks) and keep the CSVs as a fallback.

**2. Consumer financing at the quote, plus a quote follow-up sequence that is actually switched on.**
Why second: fence jobs are large-ticket, four rivals advertise financing, and Jobber advertises automated quote follow-up. The scheduled-email backend is already committed, so the quickest win is finishing its UI (send later, queue, cancel) and setting the trigger secret, which is already an approval item in the backlog. Both attack the same problem: quotes that sit unsigned. Caveat: whether financing lifts close rate for this customer base is [inferred]; I found no fence-specific evidence.

**3. Raise drawing precision to what ArcSite sets: typed lengths, tap-to-dimension, angle lock, snap points, and finish wiring the undo timeline.**
Why third: the drawing feeds the takeoff, the quote and the 3D view, and the one strongly reviewed rival (ArcSite) wins on precision. The undo core is built and tested but unwired. Highest regression risk of the five, but the 91-fixture parity gate is exactly the safety net for it, which most rivals do not publish having.

**4. Make the invisible strengths visible: an airplane-mode demo, a plain-English "your phone and the office can never disagree on a quote" claim, and a public price-lock and cancel-and-export promise.**
Why fourth: offline and the parity gate are real, but a customer only meets them after a failure. The competitors' own offline limits (section 2) show where to be specific and honest. This is mostly copy, demo and design, which is why it ranks below the engineering items despite being cheap.

**5. Close the trust gaps: collect real reviews, get a Play Store listing, and document what an iPhone user can do through the portal.**
Why fifth: B6 and B7 cost conversions but are mostly not engineering: reviews need customers, a listing needs your Play Console time. The engineering piece is checking and documenting phone-browser portal behavior. Rivals show hundreds of reviews and iOS apps, so an unreviewed product asks the buyer to take a leap that a better feature list alone does not remove.

**Considered and ranked lower:** supplier catalog and ordering integration (high value for larger shops, large build, demand not verifiable from what I could read); AI receptionist and marketing suites (not fence-critical); route optimization and recurring plans (not fence-critical).

---

## 7. What I could not verify

- Any Reddit opinion: the search tool refuses reddit.com. Nothing from r/fencing or similar was read.
- Direct reads of Capterra, G2 and the Jobber community forum: all returned HTTP 403. Review content above is from search-result summaries.
- Independent reviews of Visual Fence Pro, FenceTracer, Fence Cloud, QuoteIQ and Contractor+: none found.
- Contractor Foreman offline behavior from the vendor (features page silent) and Joist offline behavior (no source either way).
- Houzz Pro and Contractor+ official prices: sources conflict or are third-party.
- Whether ArcSite's Takeoff and Estimates prices are per user.
- PoolCorp, Master Halco and Fastenal estimators: nothing found.
- FenceFlow items not checked today: live Stripe prices; whether Wisetack, Twilio and a QuickBooks sync exist anywhere beyond what the repo grep and the dashboard showed; Play Store presence; iPhone portal behavior.
- Vendor-published roundups (Contractor+, Projul, MyQuoteIQ, OneCrew, SelectHub) have commercial incentives. I used them for product names and pointers, and quoted a figure from them only where the vendor's own page was unreachable or to show that prices moved, and I tagged each one.

## 8. Source list (all accessed 2026-10-24)

Read directly: getjobber.com/pricing/ ; getjobber.com/industries/fence-software/ ; housecallpro.com/pricing/ ; help.housecallpro.com/en/articles/4747652-housecall-pro-mobile-faq ; contractorforeman.com/pricing/ ; contractorforeman.com/features/ ; servicetitan.com/pricing ; servicetitan.com/features/field-mobile-app ; help.servicetitan.com/docs/servicetitan-field-mobile-app-offline-capabilities ; joist.com/pricing/ ; arcsite.com/pro/fencing ; arcsite.com/pricing ; support.arcsite.com/en/articles/14291214-using-arcsite-offline ; fence.cloud/ ; fence.cloud/pricing ; visualfencepro.com/ ; myquoteiq.com/pricing/ ; dripjobs.com/fencing-business-crm ; pro.houzz.com/for-pros/software-fencing-contractor ; contractorplus.app/blog/8-best-fence-contractor-software-platforms-in-2026 (vendor-pub) ; myquoteiq.com/best-satellite-measuring-software-fencing-businesses-2026/ (vendor-pub) ; projul.com/blog/best-fence-contractor-software (vendor-pub; names no fence products).

Snippet only: capterra.com (ArcSite, Contractor Foreman, Joist, Houzz Pro, FenceTracer pages) ; g2.com (ServiceTitan, Contractor+) ; community.getjobber.com ; trustpilot.com (Housecall Pro, ServiceTitan) ; softwareadvice.com ; getapp.com ; softwarefinder.com ; bbb.org (Jobber) ; appshunter.io ; selecthub.com ; pro.houzz.co.uk offline article ; merchantsmetals.com/fence-estimator/ ; projul.com/blog/servicetitan-pricing-analysis-2026.
