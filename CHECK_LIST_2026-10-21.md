# What to check — 21 October 2026

Everything below shipped in the last three days and **no human has looked at any
of it**. It compiles, it is tested, and tests do not tell you whether a logo
looks right on a quote.

Work down the list. Anything that behaves differently to the "should" line,
tell me what you saw — the words on screen are usually enough to find it.

---

## 0. Tonight, 11:32 PM

Every company's trial ends. Seven of them, including yours. After that the
office shows the blocked screen again and nobody can work.

Either pick a plan, or extend: **app → Settings → Admin → the company → +1 day
or +14 days.** Takes a thumb.

---

## 1. The logo — nothing else in this list works until this is done

**Office → Settings → Business Settings → Company logo → Upload.**

- [ ] The file goes up and the preview appears beside the button
- [ ] **The bar at the top of the office** now shows it, next to "FenceFlow
      Office", without reloading the page
- [ ] Press **Remove** — it disappears from both places. Put it back.

Then on the phone (**Settings → Business profile → Company logo**):

- [ ] The logo you uploaded in the office is already there — it syncs down
- [ ] **Add a logo** opens the picker, then the crop screen
- [ ] Drag moves it, pinch zooms it, **As it is / Wide / Square** change the
      shape, **Rotate** turns it
- [ ] **Use this** saves it, and the bar at the top of the Jobs screen shows it

> If the crop comes out different to what the preview showed, that is the one
> thing I most want to hear about — the preview and the save read the same
> rectangle, and if they disagree it is a real bug.

---

## 2. The quote, end to end

Pick a real job with a customer email and a phone number.

- [ ] **Send quote → Email** — the toast says it was emailed, not an error
- [ ] Underneath the buttons: **"Emailed to the customer …"** with today's date
      and the time
- [ ] The customer's copy has **your logo at the top**
- [ ] Open the quote link yourself — logo at the top of the page too
- [ ] On that page, **Download a copy** — the saved file still has the logo
      (it is baked in, so it survives with no internet)

> This is the one that was broken yesterday — "something went wrong on
> FenceFlow's side". That was a database permission, fixed, and nothing to do
> with the app version. If it comes back, tell me the exact words.

- [ ] **Send quote** (the main button) — your **texting app opens**, addressed
      to the customer, with the link in the message
- [ ] The "Emailed to the customer" line does **not** change after a text.
      That is deliberate: nothing can tell the app a text actually left.

---

## 3. The PDF

- [ ] Make a PDF quote and a contract
- [ ] **Your logo is top-left**, with the business name, phone and licence
      beside it
- [ ] Nothing overlaps, and the line under the header does not cut through the
      logo
- [ ] A company with **no** logo prints exactly as it used to

> Tested by compiling and reading only. Spacing is the likely fault.

---

## 4. Satellite and the drawing

- [ ] Open a job with an address, turn satellite on
- [ ] Zoom the grid out past 400 ft — **the photo keeps covering the site**
      instead of thinning out into graph paper
- [ ] Go out to 2,000 ft on a big lot — still covered, coarser but complete
- [ ] The fence line stays where it belongs on the ground as you zoom

> Before this, imagery stopped at about 776 ft. The picture gets less sharp as
> you go wider — that is the trade and it is deliberate.

- [ ] **The grid itself has still never been looked at by anyone.** Draw a
      fence at 50 ft, 400 ft and 2,000 ft and check the measurements read right.

---

## 5. The office's satellite trace — please actually test this one

- [ ] In the office, trace a fence on satellite and save it to a job
- [ ] Open the same job on the phone and check **the footage matches**

> This was wrong until yesterday: traces were saved at a fixed scale, so on a
> job drawn at 100 ft the fence was stored — and priced — at a quarter of its
> real length. Three of your jobs are not at 400 ft. Worth one real test.

---

## 6. Admin on the phone

**Settings → Admin** (asks for your authenticator code).

- [ ] Companies list, with plan, state and days left
- [ ] **+1 day** on a company — it asks first, then the row updates
- [ ] **Suspend** then **Reinstate** on a ZZ TEST company, not a real one
- [ ] Releases, Errors and Sign-ins tabs load

---

## 7. Crew

- [ ] A crew member still sees no money anywhere
- [ ] Their own pay card still shows the right hours and amount

> Crew pay now measures footage by the job's real scale instead of a fixed one.
> On a job drawn at anything other than 400 ft the per-foot figure will have
> **changed** — it was wrong before. Check one against what you would pay.

---

## Known, not broken

- **Brevo is not set up.** The app can use it; there is no account and no key.
  You are still on Resend. Parked at your word.
- **No dev database.** Every schema change goes straight at the live one.
  Creating a second Supabase project needs your login and bills your account.
- **The pricing engine still assumes 20 px/ft** where a job has no calibration.
  No live job is affected — I checked, zero — but it is the last place that
  guess survives.
