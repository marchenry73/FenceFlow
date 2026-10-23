# What to check, and exactly how — 23 October 2026 (overnight)

Replaces CHECK_LIST_2026-10-22.md for everything shipped since. The older list
still stands for anything on it you have not looked at yet.

**You were asleep for the first part.** Three app releases went out overnight
(1.743, 1.745, 1.750, all mandatory), the website deployed nine times, and I
went through all 225 test files. Sections 0 to 6 are that work.

**Since you woke up:** **1.757** and **1.759** are published, both mandatory,
and all 29 server functions are deployed. That covers everything in sections 7
and 8 — the drawing fixes, Move Fence, the 0.001 rounding fix, and emailing
your clients. Nothing on this list is waiting on a build any more.

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

## 7. The drawing, and the rounding fix

**Tap to remove**, **the closing side of a loop** and **the ghost line** went
out in 1.757. **Move the whole fence** and **the 0.001 rounding fix** are in
1.759. Both are published and mandatory, so your phone will prompt on next
open.

### Move the whole fence — ON, and the rounding fix you approved is in

> "I need to be able to move the entire fence and everything connected to
> wherever I want on the drawing."

| Do this | You should see |
|---|---|
| Open a drawing → the tool picker → **Move Fence** (next to Move View) | A line under the canvas: drag anywhere to move the whole drawing |
| Drag anywhere | **Everything** goes with your finger — every side, every gate, every marker — and the **photo, the satellite picture and the grid stay put**. That is the difference from Move View, which moves the picture and the fence together |
| Lift your finger | **"Drawing moved."** with **Put it back** |
| Check the estimate | **The same number.** Nothing changed length, so nothing changed price |
| Press **Put it back** | Everything returns where it was, and the price with it |
| Switch tool mid-drag, on purpose | The drawing snaps back to where it really is. It never sits looking moved when it is not |

> **Move View vs Move Fence.** Move View changes where you are looking from
> and moves no stored point — the drawing lands back on the same bit of photo.
> Move Fence moves the drawing itself, which is what you want when the whole
> thing was traced ten feet off the line, or when the photo was fitted
> afterwards and everything has to slide across to meet it.
>
> **Undo does not cover a whole-drawing move; Put it back does.** Undo holds
> one drawing per side and acts on the selected side only, so it would put one
> side back and leave the rest moved. Pressing Undo after a move says there is
> nothing to undo — that is the move clearing a history that no longer applies,
> not a fault.

### The 0.001 fix — done, and it changed nothing that already exists

You said do it, so it is in both engines: a thousandth of a foot comes off the
length before bays, panels and pickets round up. One place on the phone and one
on the server, so a count added later gets it without being told.

**Why it was needed.** A bay count is the length divided by the post spacing,
**rounded up**. A 96 ft side at 8 ft spacing is exactly 12 bays — and reads 13
the moment the length comes back at 96.000008, which is what 32-bit arithmetic
hands you after a few operations. That is a post, a panel, a cap and a bag of
concrete on a quote you may already have signed. Aimed at that boundary,
**4.5% of whole-fence moves flipped a count** before this.

**What it changed for your existing jobs: nothing.** Checked two ways, both
before it went anywhere:

| Check | Result |
|---|---|
| All 91 pricing fixtures regenerated and compared | **0 changed.** Every one is identical apart from its timestamp and the version string |
| Every live fence run re-measured against the new rule | **0 of 31 change a count.** The closest any run comes to a bay boundary from above is 0.059 ft — **59 times** the tolerance |

So no quote moves, nothing needs re-approving, and the boundary bug is closed.

**What it does not swallow.** A hundredth of a foot is an eighth of an inch,
and that still buys the next panel. Tested on both engines: an exact multiple
stays N, a hair over stays N, a real overhang still charges N+1, and a span
smaller than the tolerance keeps the answer it always had. Each suite has a
planted failure proving it can actually fail.

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

## 8. Email your clients from the admin console — built

This was the "not started" item. It is deployed and live.

| Do this | You should see |
|---|---|
| Admin console → **Email clients** (new, next to Companies) | Every company listed, with the address each one would go to |
| Look at the line under the list | **"0 ticked. 6 of 11 companies can be emailed"** — the rest are test companies or have no address on file. A company with no address is shown and cannot be ticked |
| Tick a few, write a subject and a message, press **Send** | A confirmation naming **who** it is going to, then a row per client saying what happened |
| Press **Send** twice quickly | The second press sends **nothing** and says "already sent" |
| Look at **Already sent** below | Every send on the record — when, who, the subject, the outcome, and which admin sent it |

> **Each client gets their own email.** Not one message with nine addresses on
> it — that would show every client who else uses FenceFlow, which is your
> customer list.
>
> **The address never comes from the browser.** The console sends company
> *ids*; the address is read from the company's own row. That is what stops the
> page being turned into a way to mail anybody from a FenceFlow address.
>
> **"Could not confirm" is not a failure.** If the mail service takes the
> message and then does not answer, it may well have gone — so it is never
> reported as failed and never retried on its own. Check before sending again.
>
> Proved against the live database before it shipped: with your second factor
> you see the 6 mailable clients; **without** it, another signed-in person, and
> an anonymous caller all see none. The exactly-once claim was exercised six
> ways in a transaction that rolled back, so your database gained nothing from
> the test.

## 9. The one thing still not finished

- **The receipt's actual send is the one link I could not exercise.** Every
  piece is proved — the words, the once-only claim, the function boots and
  gates — but I have no way to make it send without your credentials. Your next
  test payment will show it, and if it fails the webhook writes why.
