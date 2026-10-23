# What to check, and exactly how — 23 October 2026 (overnight)

Replaces CHECK_LIST_2026-10-22.md for everything shipped since. The older list
still stands for anything on it you have not looked at yet.

**You were asleep for this.** Three app releases went out (1.743, 1.745, 1.750,
all mandatory), the website deployed nine times, and I went through all 225 test
files. Everything below is **already live** — the app will prompt you to update
on next open, and the website needs nothing but a reload.

Each check is **where to go → what to do → what you should see.** If what you
see differs, tell me the words on screen.

---

## 0. The two-minute version

The deposit was the thing you said twice. Do this one first.

| Do this | You should see |
|---|---|
| Open a job that is **not** signed or approved, and change its price (add a run, change a panel) | The **deposit asked moves with it**, precisely, with no tapping |
| Now press **Set deposit** on the job page, then change the price again | It **still** moves. That is the fix — pressing that button used to freeze it for good |
| Type a deposit by hand, then change the price | It never moves again. Deliberate — and the estimate now says so, with a **Follow the price again** tap |
| Open a **signed** job and change the price | The deposit stays, and the estimate says the customer has agreed to it. No tap to override: changing that is changing the deal |

> **Why it was broken.** The rule shipped in 1.734 and was right. "Set deposit"
> stored the app's *own* suggested figure as if you had typed it, so pressing
> the button we told you to press is what switched the feature off.

---

## 1. The payment link now goes out on the quote

The two buttons on the phone that texted or emailed the link are **gone**.

| Do this | You should see |
|---|---|
| Open a job with a payment link, look at the Payment section | No **Text Link** / **Email Link** buttons. The link and the stale warning are still there |
| Open that job's customer quote link in a browser | Under **How to pay**, a **Pay online** row first, with your link and "Opens your contractor's secure payment page" |
| Open the quote for **James Bond** or **James** | **No Pay online row.** Those two links ask for the wrong money — $21,520 against an $8,101 deposit, and $160 against $3,500. Remake them and it will appear |

---

## 2. Delete forever, and the deleted-items lists

| Do this | You should see |
|---|---|
| Phone → Account → **Deleted Items**, on a deleted **job** | A red **Delete forever** under Restore |
| Tap it | A dialog naming what is destroyed and saying money is never destroyed |
| Try it on a job that has a **payment** on it | Refused, in the server's own words: "That job has N payment record(s) against it" |
| Office → **Deleted items** (new tab, under Account) | Everything deleted on any device, newest first, with who and when |

> Restore stays on the phone only, on purpose: restoring a job also brings back
> the parts deleted *with* it, and that rule lives in the app. I would not write
> a second copy of it.
>
> **On the CREW login** (`marchenry73123@gmail.com`) you will see "only people
> who can delete can restore" and no button. That account is CREW in your own
> company.

---

## 3. Your clients' companies, with their history

| Do this | You should see |
|---|---|
| Admin console → Companies → **Manage** on any company | A **History** section, shut, at the bottom |
| Open it | The company's dates — invited, joined, finished setting up, signed the agreement, trial/grace/subscription ends, last seen — then every change written down, newest first, with **Show more** |
| App → Admin → tap a company → **History and details** | The same thing on the phone |

---

## 4. Mail reads as a conversation

| Do this | You should see |
|---|---|
| Office → Email → open a thread | What arrived on the **left**, what you sent on the **right** with a blue edge |
| Tap a bubble | It opens full width and keeps its side |
| On a phone | The whole message, not three words — name and time on their own line |
| Start a reply **from FenceFlow**, type something, close it | **The draft is kept.** It never was before: every autosave was refused by the database and nothing said so |

---

## 5. A test payment now says it is a test

| Do this | You should see |
|---|---|
| Make another test card payment | A push: "TEST payment went through… NOTHING has been recorded against the job" |
| Check your email | A receipt, marked **[TEST]**, sent to **you** — not to the customer |

> A test payment still never touches the books, and that is deliberate: four
> test checkouts on a real job once left it reading $57,240 paid against a
> $10,595 contract. **Every Stripe row you have is test mode**, which is why
> you have never seen a payment reach the books. The first live card will.

---

## 6. Both decisions are now made (23 Oct, answered)

1. **Who pays for the shared post — CONFIRMED.** "The shared posts is 6ft and
   when it goes down to 4 ft, it becomes 4ft, charge appropriately." That is
   taller-wins, which is what both engines already do, so nothing changed. The
   note in the code that was waiting on you is closed.

2. **The 6 ft to 4 ft transition item — DECIDED AGAINST.** "It is a 6ft panel,
   I cut it to go down to 4 ft." So the raked bay is an ordinary 6 ft panel at
   the 6 ft price. The spec for a priced transition item is removed: its test
   file, section 6 of the joining document, and the column the migration used
   to create. The joining test's own case P10 already proves a 6-to-4 fence
   prices as **10 ordinary panels and zero transition panels**, which is your
   rule.

   The `is_transition` column still exists on the live database — nothing reads
   it and no run carries it. I left it rather than dropping it: a column drop
   is irreversible and that one costs nothing.

## 7. Two things that are not finished

- **Email your clients from the admin portal.** Not started. It needs a sender
  that posts as FenceFlow rather than as your company inbox, and I was not
  going to build something that sends email to your customers unattended.
- **The receipt's actual send is the one link I could not exercise.** Every
  piece is proved — the words, the once-only claim, the function boots and
  gates — but I have no way to make it send without your credentials. Your next
  test payment will show it, and if it fails the webhook writes why.
