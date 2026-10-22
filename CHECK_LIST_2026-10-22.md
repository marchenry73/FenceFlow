# What to check — 22 October 2026

Replaces CHECK_LIST_2026-10-21.md. Everything on that list that is still
outstanding is repeated here, so this is the only one you need.

**Seventeen changes shipped in three days and no human has looked at any of
them.** They compile, they pass 17 deploy gates, and I rendered several of
them in a browser myself — but a test cannot tell you whether a number is
right, and a browser with no data cannot tell you whether a screen is useful.

Work down the list. Anything that behaves differently to the "should" line,
tell me the words on screen and I can usually find it from that.

---

## 0. The quickest test in here

**Time → there is one shift waiting for sign-off right now.**

- [ ] Open it, press **Sign off**. It should turn to a green "Signed off" pill
      with your name under it.
- [ ] Press **Turn down** on another and it should refuse to go anywhere until
      you type a reason. That refusal is the server's, not the page's.

> This is the single fastest way to prove the new Time tab works end to end,
> and it exercises the one thing that was never possible from the office
> before.

---

## 1. The office, screen by screen

### Reports
- [ ] Six groups are now **tabs**, not six accordions. Only one shows at a time.
- [ ] The headline tiles stay above whichever group you pick.
- [ ] The date range says **"… · N jobs"** — a number, not just dates.
- [ ] It opens on the group you left it on.

### Time
- [ ] Opens on **Weekly timesheet**, not the flat list. (Every employer product
      does this; the flat list is the correction layer.)
- [ ] Range chips, **Who** and **Job** filters at the top. All time is the
      default — deliberately, because you have twelve shifts in total and
      "This week" would open an empty tab.
- [ ] Flag chips appear only when something is wrong. Expect to see
      **1 overlapping** — two shifts for the same person covering the same
      minutes. It is 23 seconds on 29 August, so it is test data, not money.
- [ ] Payroll CSV now says how many finished shifts it left out for not being
      approved.

### Catalog
- [ ] Four filters beside the search box: fence type, role, supplier, status.
- [ ] **Status opens on "In use"** — retired parts are hidden, because a
      retired part in a price list is a part that gets quoted again.
- [ ] "Showing 112 of 124 items" under the filters.
- [ ] **Open all** opens every section; press again to close them.
- [ ] **Change prices by %** — try +8 on a filtered set. It must show you
      **every** affected row, old price and new, before Apply does anything,
      and Apply must be dead until you have previewed. Change the percentage
      after previewing and Apply should go dead again.
- [ ] After applying, **Undo** puts every price back.

> The preview and the undo are the only reason this feature exists. Of every
> product I compared — Shopify, Square, Lightspeed, ServiceTitan, Housecall
> Pro, Jobber — only ServiceTitan does percentage changes at all, and it has
> neither.

### Jobs
- [ ] Two new columns: **Stage** and **Total**. Both sort.
- [ ] Stage sorts down the pipeline, not alphabetically.

### Schedule
- [ ] A **Week / Month** toggle. Week shows seven tall columns with nothing
      hidden behind "+N more".
- [ ] The arrows step a week at a time in week view, a month in month view.
- [ ] Under the calendar: **"N sold with no date yet"**, oldest first. Click
      one to open it.

### Pipeline
- [ ] The board **wraps** instead of running off the right edge. Every stage on
      the page, mouse wheel works.

### Materials → now called **To order**
- [ ] The tab is renamed, and both it and Catalog say in one line what the
      other one is for. There should be **six** sold jobs waiting on materials.

### Email
- [ ] With nothing open, the list takes the **full width**, one conversation
      per line — sender, subject, grey snippet, date hard right. Open a thread
      and it narrows to two panes.
- [ ] Under the toolbar: **"296 of 300 emails left today"**. Send one and the
      number should drop.

### Alerts (Settings → Your alerts)
- [ ] Twenty-six pills wrapped inside a box with **its own scrollbar** — the
      rest of Settings should not move.
- [ ] Switched-off ones are dimmed. The bar says "19 of 26 on".
- [ ] **All on / All off** is one press.

### A job sheet
- [ ] Two new panels: **Snag list** (add, tick off) and **Change orders**
      (read-only; they are raised on the phone because they need a signature).
- [ ] Both are empty today. That is expected — they have never been reachable
      from the office before, which is why neither has ever been used.

---

## 2. The admin console

- [ ] **Audit log** — a new tab. 5,170 rows of who changed what, filterable by
      company, table, person and date, with CSV. This is the one new screen
      with real data in it from the first second.
- [ ] **Crashes** — an office error now shows an "Office website" pill and is
      never hidden by the "only on 1.708" filter.

---

## 3. What is still yours to do

- [ ] **Point Supabase Auth at Resend** (dashboard → Authentication → SMTP).
      Password resets currently come from `mail.app.supabase.io` and share a
      project-wide limit of a few per hour. I cannot do this one.
- [ ] **Decide the mail fallback**: when the allowance runs out, send from a
      different address, or stop and tell you? The machinery is built; it needs
      a Brevo account and key, which only you can create.
- [ ] **Update the phone that is still on 1.687.** 1.708 is marked mandatory
      now, so it will be prompted and cannot dismiss it.

---

## 4. Known, and not broken

- **Change orders and snag lists are at zero.** The test of whether they were
  merely unreachable has not started. Give it a week of real use.
- **No dev database.** Every schema change still goes at the live one.
- **The pricing engine's last hardcoded guess** — 20 pixels per foot on a job
  with no calibration — is still there. Zero live jobs are affected; I checked.
- **Two tests are red on purpose.** `a32-join-transition` waits on a
  TRANSITION_PANEL catalog item, and its own header says to confirm you want
  that item before anybody builds to it. That is a decision, not a bug.
