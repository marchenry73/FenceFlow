# What to check, and exactly how — 22 October 2026

Replaces CHECK_LIST_2026-10-21.md. Everything still outstanding from that one
is repeated here, so this is the only list you need.

**Eighteen changes shipped in three days and nobody has looked at any of them.**
They compile and pass every gate, and I rendered several in a browser myself —
but a test cannot tell you whether a number is right, and a browser with no
data cannot tell you whether a screen is useful.

Each check below is **where to go → what to do → what you should see**. If what
you see differs, tell me the words on screen; that is usually enough for me to
find it.

---

## 0. The two-minute version

If you only do one thing, do this. It proves the biggest new piece end to end.

1. Office → **Time**
2. You should land on **Weekly timesheet**, not a flat list of shifts.
3. One shift is waiting for sign-off. Find the row with a grey **Waiting** pill.
4. Press **Sign off** → it turns to a green **Signed off** pill with your name
   under it.
5. On another row press **Turn down** → it must refuse to do anything until you
   type a reason. That refusal comes from the server, not the page.

---

## 1. Office, screen by screen

### Time
| Do this | You should see |
|---|---|
| Open **Time** | Opens on **Weekly timesheet** (not the entry list) |
| Look at the top | Range chips, **Who** and **Job** dropdowns, "12 shifts · 84.5 hours" |
| Look under the chips | Flag chips, including **1 overlapping** |
| Click **1 overlapping** | The list narrows to those shifts. Click it again to clear |
| Switch to **Clock In / Out** | A **Signed off** column: Waiting / Signed off / Turned down |
| Press **Sign off the N with nothing flagged** | Only shifts tripping no flag are signed; anything flagged is left for you |
| Reports → **Payroll CSV** | It now tells you how many finished shifts it left out for not being approved |

> The overlapping pair is John on job Marco, 29 August — two shifts 23 seconds
> apart. It is test data, not money. The flag finding it is the point.

### Catalog
| Do this | You should see |
|---|---|
| Open **Catalog** | Four dropdowns beside the search box, and "Showing N of 124 items" |
| Check the **Status** dropdown | It opens on **In use** — retired parts are hidden on purpose |
| Set **Status** to Retired | Only retired parts, and the count changes |
| Press **Open all** | Every fence-type section opens. Press again to close them all |
| Filter to **Fence type = Vinyl**, then **Change prices by %** | A panel opens. **Apply must be greyed out** |
| Type `8`, press **Preview** | A table of **every** affected item: name, type, Now, After |
| Change `8` to `5` without previewing | **Apply goes grey again** — this is the guard against the accident |
| Press **Preview**, then **Apply** | "N prices changed", and the catalog repaints |
| Press **Undo** | Every price goes back. Check two of them by eye |

> Preview and undo are the only reason that feature exists. Of Shopify, Square,
> Lightspeed, ServiceTitan, Housecall Pro and Jobber, only ServiceTitan does
> percentage changes at all — and it has neither.

### Schedule
| Do this | You should see |
|---|---|
| Open **Schedule** | A **Week / Month** toggle beside Today |
| Press **Week** | Seven tall columns, Sun–Sat, today outlined |
| Find a busy day | Every job shown — **no "+N more"**. That is the whole point of week view |
| Press **›** | Moves one week, not one month |
| Press **Month**, then **›** | Moves one month |
| Scroll below the calendar | **"N sold with no date yet"**, oldest first. Click one to open the job |

### Jobs
| Do this | You should see |
|---|---|
| Open **Jobs** | Two new columns: **Stage** and **Total** |
| Click the **Stage** header | Sorts down the pipeline — New Lead first, Done last. Not alphabetical |
| Click **Total** | Sorts by value |

### Reports
| Do this | You should see |
|---|---|
| Open **Reports** | Six **tabs**, not six accordions. Only one group on screen |
| Look above the tabs | The headline tiles stay put whichever group you pick |
| Look at the date range line | "… · N jobs" — a count, not just two dates |
| Leave and come back | It opens on the group you left it on |

### Email
| Do this | You should see |
|---|---|
| Open **Email** with nothing selected | The list takes the **full width**, one conversation per line: sender, subject, grey snippet, date hard right |
| Click a thread | The list narrows and the thread opens beside it |
| Look under the toolbar | **"296 of 300 emails left today"** |
| Send one | The number drops by one |

### Pipeline
| Do this | You should see |
|---|---|
| Open **Pipeline** | Every stage on the page — it **wraps** onto a second row instead of running off the right edge |
| Use the mouse wheel | The page scrolls down. No sideways shoving |

### Materials → now **To order**
| Do this | You should see |
|---|---|
| Look at the left nav | The tab is called **To order** |
| Open it | A line saying this is the ordering list, not the price list, and **six** sold jobs waiting on materials |
| Open **Catalog** | The matching line pointing back the other way |

### Alerts (Settings → Your alerts)
| Do this | You should see |
|---|---|
| Scroll to **Your alerts** | Pills wrapped in a box with **its own scrollbar**. The rest of Settings does not move |
| Untick one | It dims, and the count changes ("19 of 26 on") |
| Press **All off**, then **All on** | One press each, not twenty-six |

### A job sheet
| Do this | You should see |
|---|---|
| Open any job, scroll down | Two new panels: **Snag list** and **Change orders** |
| Type into the snag box, press **Add** | It appears in the list |
| Press **Done** on it | It dims and drops below the outstanding ones |
| Look at **Change orders** | Read-only, with a line saying they are raised on the phone because they need a signature |

> Both are empty today. That is expected — they have never been reachable from
> the office before, which is exactly why neither has ever been used.

---

## 2. Admin console

| Do this | You should see |
|---|---|
| Open the console → **Audit log** | A new tab with real data: who changed what, when, before → after |
| Set **Company** and a date range, press **Show** | The list narrows; the line above says how many it is showing |
| Scroll to the bottom | **Show older** when there are more than 200 |
| Press **CSV** | A file of exactly what is on screen, before and after values included |
| Open **Crashes** | An office error carries an **Office website** pill and is never hidden by the "only on 1.708" tick box |

---

## 3. The phone

| Do this | You should see |
|---|---|
| Open the app on any phone | An update prompt for the newest build, **with no "Later"** — 1.708 onward is mandatory |
| The handset still on 1.687 | Must take the update. It is the only one still reporting the jobs-list crash |

---

## 4. Yours to do, not mine

- [ ] **Supabase dashboard → Authentication → SMTP → point it at Resend.**
      Password resets currently come from `mail.app.supabase.io` and share a
      project-wide limit of a few per hour. I cannot do this one.
- [ ] **Decide the mail fallback.** When the daily allowance runs out: send
      from a different address, or stop and tell you? The machinery is built
      and needs a Brevo account and key, which only you can create.

---

## 5. Known, and not broken

- **Snag lists and change orders are at zero.** The test of whether they were
  merely unreachable has not started. Give it a week of real use.
- **No dev database.** Every schema change still goes at the live one.
- **The pricing engine's last hardcoded guess** — 20 pixels per foot where a
  job has no calibration — is still there. Zero live jobs are affected.
- **One test is red on purpose.** `a32-join-transition` waits on a
  TRANSITION_PANEL catalog item, and its own header says to confirm you want
  that item before anybody builds to it. That is a decision, not a bug.
- **Green deploys do not mean a green publish.** They are different gate sets;
  the publish runs more. Found the hard way on 22 October.
