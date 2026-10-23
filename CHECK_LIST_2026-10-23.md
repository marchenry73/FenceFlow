# What to check, and exactly how — 23 October 2026 (overnight)

Replaces CHECK_LIST_2026-10-22.md for everything shipped since. The older list
still stands for anything on it you have not looked at yet.

**You were asleep for this.** Three app releases went out (1.743, 1.745, 1.750,
all mandatory), the website deployed nine times, and I went through all 225 test
files. Sections 0 to 6 are **already live** — the app will prompt you to update
on next open, and the website needs nothing but a reload. **Section 7 is the
drawing work from after you woke up and is in the NEXT build**, which is
building now; it says so again at the top of that section.

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

## 7. The drawing: tap-to-remove, the ghost line, and one decision for you

In the **next** build, not the three that went out overnight. **Tap to remove**
and **the ghost line** are done and on. **Move the whole fence** is written and
switched off, and the one paragraph you have to read is why.

### Move the whole fence — BUILT, AND I AM NOT TURNING IT ON. ONE DECISION FOR YOU.

> "I need to be able to move the entire fence and everything connected to
> wherever I want on the drawing."

It is written, it works, and it has 18 tests. **You will not see a Move Fence
button, because I found something while testing it that can add money to a
quote, and I will not ship that while you are asleep.** Here is the whole
thing in plain terms, then the one question.

**What I believed.** Sliding the whole drawing cannot change a price, because
every length is the difference between two corners, and moving both corners by
the same amount leaves the difference alone. That is true in arithmetic.

**What the phone actually does.** It stores coordinates as 32-bit numbers,
which hold about seven digits. Move a corner and the new number gets rounded
to the nearest one it can hold. Do that to both ends of a side and the
difference can come back a hair different. I measured it over 200,000
grid-like drawings: **one move in eight changes the measured total, by up to
four ten-thousandths of a foot** — five thousandths of an inch. Nothing you
could see, measure or bill.

**Why that is still not safe.** The number of bays in a side is the length
divided by the post spacing, **rounded up**. A side that is an exact multiple
of the spacing — 96 ft at 8 ft spacing, an ordinary back yard — is exactly 12
bays. The moment it reads 96.000008 ft it becomes **13**: one more post, one
more panel, one more cap, one more bag of concrete. I aimed the test straight
at that boundary: **4.5% of moves flipped a bay count.** On a job already
signed, that is a price change nobody asked for and a re-approval you would
have to chase.

**I tried to dodge it.** A finger drag's exact sub-pixel offset means nothing,
so I searched for a nearby offset that moves the drawing with every side's
length bit-identical — the one you asked for, the same rounded to whole pixels,
and 81 neighbours. It works every time on grid drawings and **fails for two
thirds of long runs traced on a photo**, where the corners carry full precision.
There is no version of that trick that is safe in general.

**The actual fix is one line in each of the two pricing engines**, and it is
yours to make, not mine:

> Take **0.001 ft** off the length before rounding the bays up — in the phone's
> `EstimateEngine` (four places) and in the office engine's `ceilRoundToInt`,
> which every bay, panel and picket count already goes through.

It absorbs a hundredth of an inch of noise — two and a half times the worst I
measured — and still charges for any overhang a tape could read.

**Why I did not just do it.** It changes a quantity on exactly the jobs this
noise is mis-charging **today**: they would lose a surplus post and panel, so
the quote gets **cheaper**. A cheaper quote on an approved job can set off a
re-approval. That is a decision about live customer prices.

| Say this | And I will |
|---|---|
| **"Do the 0.001 fix"** | Land it in both engines with a parity proof, turn Move Fence on, and list any existing job whose total changes before anything goes out |
| **"Leave it"** | Leave Move Fence off. You still have **Fit photo**, which slides the picture under the drawing instead and changes no coordinate at all — for lining a traced fence up with a photo, that already does the job safely |

> One more honest detail, for when it is on. **Put it back** is right to about a
> ten-thousandth of an inch, not to the last decimal place, and it does not
> drift further however many times you use it. I had written in the code that
> it was exact; the test I wrote to prove that caught me.
>
> And **Undo does not cover a whole-drawing move** — Put it back does. Undo
> holds one drawing per side and acts on the selected side only, so it would
> put one side back and leave the rest moved.

### Tap something to remove it

> "Need to be able to click on something on the drawing to remove it."

| Do this | You should see |
|---|---|
| Tool picker → **Remove** | A line naming what a tap can take off: a side, a gate or a marker |
| Tap a **gate** | "Remove this gate?" naming its width and which side it hangs on. Undo brings a gate back |
| Tap the **house** or any marker | "Remove this marker?" and, in writing, that nothing is priced from it — so no fence changes |
| Tap a **fence line** | The same erase question you already get from a long press, with the same warning about splitting a side in two |
| Tap the side that **closes a loop** | "Erase the side that closes the loop?" — and it opens the loop. **This could not be reached at all before:** that one side exists because the loop is closed, so there was no corner to find and a finger on it picked whichever other side was nearest |
| Tap bare ground | "Nothing there to remove." It never guesses |

> Nothing here removes anything on the tap alone — every one of the four asks
> first. A tap is a cheap gesture and this one lands on a priced fence. The
> long press in Draw still works exactly as before; this is a second way to
> the same questions, not a new way to delete.
>
> **Remove is absent on a crew phone**, like every other way to take something
> off the drawing — not present and refusing. On the CREW login
> (`marchenry73123@gmail.com`) there is no Remove button at all.

### The line that came back after you deleted a side

> "I also saw past line show up after I had deleted a side, things like that
> is still happening, I don't want it to at all."

Found and fixed. **Deleting something here does two things**: it removes it
from this phone, and it queues the deletion for the cloud. Until the cloud
accepts it, the cloud's copy is **still live** — so the next sync asked for
every live side, got the deleted one back, could not find it on this phone,
and re-created it. "I cannot find this locally" and "I deleted this a second
ago" looked identical.

Every place that creates a row from the cloud now checks the queue first. The
sides pull did not, and nor did **site markers or change orders** — the same
hole, one table over, which would have put back a deleted house marker or a
deleted change order the same way.

| Do this | You should see |
|---|---|
| Delete a side, then pull down to sync, twice | It stays gone |
| Delete it with the phone in airplane mode, then turn the radio back on | It stays gone |
| Same with a **site marker** and a **change order** | They stay gone |

> One gap is left open deliberately and is written into the test rather than
> hidden: the **catalog** pull is not guarded this way. It re-keys a local item
> onto the cloud item's identity, so a naive guard there could stop catalog
> items syncing at all — worse than the fault it would fix, and not something
> to do unattended.

## 8. Two things that are not finished

- **Email your clients from the admin portal.** Not started. It needs a sender
  that posts as FenceFlow rather than as your company inbox, and I was not
  going to build something that sends email to your customers unattended.
- **The receipt's actual send is the one link I could not exercise.** Every
  piece is proved — the words, the once-only claim, the function boots and
  gates — but I have no way to make it send without your credentials. Your next
  test payment will show it, and if it fails the webhook writes why.
