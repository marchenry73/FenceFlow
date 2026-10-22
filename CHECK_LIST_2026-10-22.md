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

> **Two kinds of row below.** Anything marked **LIVE NOW** is already running —
> a database change or a website deploy, nothing to install. Anything marked
> **NEEDS A PUBLISH** is written and tested but is not in any build on your
> phone yet, so checking it today will show you the old behaviour.

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

## 1. New this afternoon

### Admin console — "Using it" — **LIVE NOW**
The list told you how many people and jobs a company has had **ever**, and a
total never goes down: a company that stopped in August looked exactly like one
that used it this morning.

| Do this | You should see |
|---|---|
| Open the console → **Companies** | A new **Using it** column, right beside Status |
| Look down it | One green **Active**, one amber **Quiet**, the rest red **Dormant** |
| Read the small line under a pill | `2 seen · 4 jobs · 4 quotes` — the counts the verdict came from |
| Hover the pill | The rule, in one sentence, so you can disagree with it |
| Click the **Using it** header | Dormant companies come to the top |
| Look at the tiles above | **1** — used it (30 days), with "7 dormant" under it |
| Press **CSV** | Four new columns: UsingIt, PeopleSeen30d, JobsCreated30d, QuotesSent30d |

> Three counts, not one, and that is the whole design. `last_seen_at` is
> written by the **phone**, so a company that only ever opens the office
> website reads as nobody-seen — a people-only rule would call it dormant while
> it quoted every day. A company that was invited and never signed in shows a
> grey dash, not a red pill: there is nothing to measure yet.
>
> **Your numbers today:** Fence solutions is the only Active one (2 seen, 4
> jobs, 4 quotes). Legacy is Quiet — somebody opened it on 24 September, which
> drops out of the 30 days in two days' time. Everything else is Dormant or has
> never joined.

### The console answers your address only — **LIVE NOW**
| Do this | You should see |
|---|---|
| Open the console as yourself | Exactly as before — all 11 companies |
| Nothing else to do | There is no second account to test with, and that is the point |

> It already needed the platform-admin flag **and** your authenticator. It now
> also needs the login to be `marchenry73@gmail.com`. Three locks, checked in
> one place that 19 functions and 11 policies go through, so new admin code is
> refused by default instead of having to remember.
>
> Proved both ways against the live database: your login, stepped up, sees all
> 11 companies; another real login, also stepped up, is refused and sees 0.
>
> **If you ever change your login email, change it in
> `supabase_r26_admin_is_one_address.sql` and re-run that file first** — doing
> it the other way round locks the console to nobody, and the way back in is
> the Supabase SQL editor.

### Phone → Admin → the mail panel — **NEEDS A PUBLISH**
The panel you photographed. It has **never worked**: the phone read
`mail_platform_settings` straight off the table, and that table is one of six
no signed-in account may touch at all. It now goes through an admin function,
the same door the button under it already used.

| Do this | You should see (once published) |
|---|---|
| Phone → Admin → scroll to **FenceFlow mail goes through** | **Resend (in use)**, no red text |

> The error suggested `GRANT SELECT ... TO authenticated`. Taking that advice
> would have given every signed-in user of every fence company a read of the
> platform's mail configuration, and broken the test that exists to stop
> exactly that. A database knows about privileges, not about who should have
> them.

### No error ever prints your access token again — **NEEDS A PUBLISH**
The red text in that photo carried `Authorization=[Bearer eyJ…]` — a live token,
about an hour's worth of your access, on screen in a picture you then sent.

| Do this | You should see (once published) |
|---|---|
| Cause any failure in the app (turn off wifi mid-save) | The reason only. No URL, no headers, no token |

> Crash **reports** have been redacted since the same hazard was found in the
> error log weeks ago. The **screen** was not. All sixteen places that put a
> failure into words now go through one function, so a new screen is redacted
> by default. **Treat the token in that photo as spent** — don't repost the
> picture; signing out and back in on the phone retires it immediately.

### Settings → Contract terms stays shut — **NEEDS A PUBLISH**
| Do this | You should see (once published) |
|---|---|
| Phone → Settings, scroll past **Contract terms** | It is **closed**, like every other card |
| Look at it | Red tile, red line under the heading, saying it needs review |
| Tap it | It opens, with the same warning inside |

> It opened itself whenever the terms still had the replace-me block in them —
> which meant a twelve-line editor and four paragraphs of notes unrolled across
> Settings every time you scrolled past. The alarm is worth one red line; it is
> not worth the scroll.

### The job page folds up — **NEEDS A PUBLISH**
Eighteen sections, every one of them open at once. That is why it scrolled
forever; it was never disorganised, it was all unrolled.

| Do this | You should see (once published) |
|---|---|
| Open any job | **Progress**, **Customer** and **Payment** are open. Everything else is shut |
| Look at a shut card | A line under the heading saying what is in it — the customer's name and number, how many sides, how many change orders |
| Tap a heading | It opens. Tap again, it shuts |
| Turn the phone | It stays how you left it |

### The estimate — **NEEDS A PUBLISH**
| Do this | You should see (once published) |
|---|---|
| Draw a side, open the estimate | The **Total feet** box carries the drawn figure instead of being blank |
| Change the price (add a run, change a panel) | The **deposit asked moves with it**, precisely |
| Type a deposit by hand | It never moves again. That is deliberate |
| On a part-paid job | **Set deposit** is there, and names what is still to collect |

### The logo — **NEEDS A PUBLISH**
| Do this | You should see (once published) |
|---|---|
| Settings → logo → pick a picture | Shapes and Rotate as before, plus **Remove the white background**, **Brightness** and **Contrast** |
| Turn the white off on a JPG logo | The white box around it goes. This is the one that stops your quotes looking homemade |
| Leave the sliders alone | The picture comes out exactly as it would have before |

### The email your customer opens — **LIVE NOW**
| Do this | You should see |
|---|---|
| Send yourself a quote | A white card, your logo **and** your company name at the top, one **Open it here** button instead of a blue link in a sentence, your signature under a line, a small grey footer |
| Open it on your phone | It fills the screen. It used to lay out at desktop width and shrink to a stamp |
| Read it with images off | Your company name is still there — most mail apps block images on first open |

> The words did not change. Every sentence is still the one that was there
> yesterday; what changed is how it looks.

---

## 2. Office, screen by screen

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

## 3. Admin console

| Do this | You should see |
|---|---|
| Open the console → **Audit log** | A new tab with real data: who changed what, when, before → after |
| Set **Company** and a date range, press **Show** | The list narrows; the line above says how many it is showing |
| Scroll to the bottom | **Show older** when there are more than 200 |
| Press **CSV** | A file of exactly what is on screen, before and after values included |
| Open **Crashes** | An office error carries an **Office website** pill and is never hidden by the "only on 1.727" tick box |

---

## 4. The phone

| Do this | You should see |
|---|---|
| Open the app on any phone | An update prompt for the newest build, **with no "Later"** — 1.708 onward is mandatory, and 1.727 is the current one |
| The handset still on 1.687 | Must take the update. It is the only one still reporting the jobs-list crash |

---

## 5. Yours to do, not mine

- [ ] **Supabase dashboard → Authentication → SMTP → point it at Resend.**
      Password resets currently come from `mail.app.supabase.io` and share a
      project-wide limit of a few per hour. I cannot do this one.
- [ ] **Decide the mail fallback.** When the daily allowance runs out: send
      from a different address, or stop and tell you? The machinery is built
      and needs a Brevo account and key, which only you can create.
- [ ] **Sign out and back in on the phone** once, to retire the access token
      that was printed in the Admin screenshot.

---

## 6. Asked for, not built yet

In the order you asked. None of these is started; they are listed so none gets
lost.

1. **Payment methods you can receive, flexible.** Today it is four fixed ones —
   Cash App, Zelle, wire, cash — hardcoded across the phone, the office, the
   quote page and nine tests. My recommendation is to keep those four, which
   have real validation behind them, and add an **"Other methods" list** you can
   add any number of rows to: a name and a line of detail (Venmo @handle, cheque
   payable to …, PayPal, ACH). It stores in a sibling key so the office's Save
   cannot wipe it, shows on the quote page with the rest, and does not disturb
   the four that already work. Say the word and I will build it that way, or
   argue me out of it.
2. **More to do to a logo than crop and wide.** Rotate, straighten, zoom and
   pan, brightness and contrast, and a white-background knockout are the
   realistic set on a phone.
3. **Everything the web console has, on the phone's Admin portal.** The web
   console has eight screens the phone does not; I need to go through them with
   you and decide which actually belong on a phone, because a few of them
   (bulk price changes, the audit log's CSV) are desk work.

---

## 7. Known, and not broken

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
