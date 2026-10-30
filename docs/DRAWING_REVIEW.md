# The drawing: what is there, what is weak, what is worth adding

Written 30 Oct 2026, overnight, in answer to:

> "Also what are some parts of the drawing that needs to be worked on, how can
> we make it better, more efficient and what can be added?"

Everything in **What is already there** and **What is actually weak** was read
out of the code, not remembered. The **worth adding** list is my
recommendation and says so.

## What is already there

Two files, 9,657 lines: `SurveyDrawScreen.kt` (5,375) and
`SurveyViewModel.kt` (4,282). The feature list is longer than most fence apps
ship:

- **Drawing**: tap-to-place points, curve taps, closed loops, double-tap to
  finish a side, type an exact length for a segment, snap to nearby vertices,
  per-vertex arrow-pad nudging (because a finger covers the point it is
  moving).
- **Joining**: sides joined end-to-end share one post — offered automatically
  after a snap or a draw, with a confirm step, and the far end slides to meet
  when a joined end moves.
- **Scale**: three ways — a calibration tap on a survey photo, a grid with a
  settable feet-per-square, and satellite imagery with automatic zoom
  selection and tile cover checks.
- **On it**: gates (placed, moved, removed), site markers (house, pool,
  driveway, easement, utility, tree, slope, obstacle), teardown runs with
  their own charge.
- **Undo**: a real history, persisted per job and restored on reopen, plus
  redo, erase-segment, erase-run, and move-the-whole-drawing with a put-back.
- **Live numbers**: a running footage readout for the active side and for all
  sides together, which re-prices as the drawing changes.

That is a lot, and it mostly works. The notes below are not a complaint about
the drawing; they are where I would spend the next days on it.

## What is actually weak

**1. A height change mid-side cannot be seen or made on the drawing.**
This is the biggest one, and it is new this month. `RunSplit` — split one
side into a 4 ft piece and a 6 ft piece — is reachable only from the side
editor (`RunEditScreen`). The drawing has no notion of it: the only
`heightFt` the drawing paints belongs to site markers (an existing fence or
wall), never to the fence being built. So the exact job you asked for last
week ("mark a side or a part of a side as 4 ft, and the other part as 6 ft")
is done in a list screen and then invisible on the picture the crew works
from. **Fix: label each side with its height on the canvas, and show the
split point as a marked vertex.** Until then, nobody looking at the drawing
can tell a 4 ft run from a 6 ft one.

**2. No side carries a name the customer or crew would use.**
Sides are labelled "Side 1, Side 2" by `nextQuickRunLabel`. An HOA letter, a
pull sheet and a crew conversation all want "Back", "Front", "Pool side".
The field exists — it is simply never prompted for. **Fix: offer the four or
five names you actually use the moment a side is finished, one tap.**

**3. There is no setback line.** Nothing in either file mentions a setback or
a property line offset (`grep` for "setback": zero hits). Fences get built
on or near a line that an HOA and a county both care about, and the drawing
has no way to express "this run sits 6 inches inside the line". **Fix: an
optional offset on a side, shown as a dashed guide.** This is also what makes
the satellite imagery worth more than a backdrop.

**4. No exact angle entry.** A segment's LENGTH can be typed
(`setSegmentLengthFeet`); its direction cannot. Every corner that is not
snapped is as accurate as a fingertip. For a rectangular back yard that is
fine; for a lot with an angled corner it is a guess that the takeoff then
treats as exact. **Fix: let a corner be typed as 90 degrees — most of them
are — and square the rest automatically.**

**5. The two files are too big to change safely.** 5,375 lines in one
composable file means the draw screen is one of the slowest things in the
build, and the region most likely to go wrong in a merge. It is not urgent,
and splitting it is a day of work that produces no visible change, so I have
not touched it. But it is why a small drawing change costs 30 minutes of
build time.

**6. The drawing cannot be printed or sent on its own.** `PdfExporter`
exists, but the drawing reaches the customer only inside the quote. An HOA
asking "where exactly" wants the picture, and the HOA letter I built tonight
has to say "ask us and we will send the drawing" rather than attaching it.
**Fix: render the canvas to the PDF the letter already attaches.**

## Worth adding, in the order I would do it

My recommendations, not measured facts.

1. **Height labels on the canvas, and the split point marked** — makes the
   mixed-height work you asked for actually visible. Half a day.
2. **Name the side when it is finished** — one dialog, four buttons, pays for
   itself in every email, pull sheet and HOA packet. Two hours.
3. **The drawing in the PDF** — attach the picture to the HOA letter and the
   quote. Half a day, and it reuses the PDF writer that already exists.
4. **Square-that-corner** — a tap that snaps a corner to 90 degrees, and a
   typed angle for the ones that are not. Half a day, and it removes the
   commonest source of a wrong takeoff.
5. **Setback offset per side** — dashed guide, optional, carried into the HOA
   letter. A day.
6. **Copy a side** — there is no duplicate anywhere (`copyRun`: zero hits).
   Four sides of a rectangular yard are four draws today. Two hours.
7. **Split the two files** — no visible change, but every later drawing change
   gets cheaper and safer. A day.

## What I deliberately did not do

I did not touch the drawing tonight. It is the most intricate part of the app,
every change to it needs a 30-minute build and a real look on a phone to judge
— and "it looks right" is a judgement I cannot make for you from here. The
list above is ordered so you can pick one and I can do it properly.
