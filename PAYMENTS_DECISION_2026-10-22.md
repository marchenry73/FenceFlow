# Payment, invoice, and what is actually still needed — 22 October 2026

> "The payment Invoice may not be needed anymore since it sends it in the link
> for the payment. I want the stripe link to be sent also, and you figure out
> what to do with the payment and invoice parts. Record a payment, request, idk
> if it is needed anymore since it sends through email and phone, text or
> email. Maybe a template to send it as it is sent to the email."

Read off the code, not guessed. **One of the four things you asked for already
exists**, and of the other three, deleting two would cost you money you are
currently collecting.

---

## 1. "I want the Stripe link to be sent also" — IT ALREADY IS

The moment a payment link exists on a job, two buttons appear under it:
**Text link** and **Email link**, both pre-filled with the customer's name, the
amount, the job address and the link.

You almost certainly have not seen them because they sit near the bottom of the
Payment section, on a page that was eighteen permanently-open sections long.
**That is fixed in the build going out now** — Payment is one of the three
sections that opens on arrival.

One real gap, and it is worth closing: **Email link opens a draft in whatever
mail app the phone has.** The quote email does not — it sends through the
company's own mailbox, under the company's name, and the phone is told whether
the provider took it. The payment email should do the same, which also means it
would carry the new branded card instead of whatever the phone's mail app makes
of it. Small change, and it is next on my list.

---

## 2. "Record a payment" — KEEP IT. It is not about the link.

It records **cash, cheque, Zelle, Cash App and wire** — every way you take money
that Stripe never sees. Without it:

- `amount_paid` never moves for those payments, so the job shows the full
  balance outstanding for ever;
- the deposit maths (asked minus paid) is wrong on every job you were paid in
  anything but card;
- AR aging and the reports count money you already have as owed;
- the customer's own quote page keeps asking for money they have paid.

You take Zelle and cash by hand. This is the only thing that tells the system so.

**Verdict: not redundant. The link covers cards; this covers everything else.**

---

## 3. "Request payment by card" — KEEP IT, with one thing worth knowing

This is what *creates* the Stripe link in the first place. The Text/Email
buttons in §1 only appear after it has run. Remove it and there is no link to
send.

What it is NOT, and this is the bit worth saying plainly: **the customer's quote
page already has its own Pay button**, which creates a link by itself without
you doing anything. So there are two ways to the same place:

| | Who starts it | When it makes sense |
|---|---|---|
| **Quote page Pay button** | the customer | they are reading the quote and ready |
| **Request payment by card** | you | she is not on the page — you are chasing a balance by text |

Both are useful. The second is the one you use when the job is finished and you
want the balance, which is not a moment she is sitting on the quote page.

---

## 4. "Invoice" — THIS is the one that may genuinely be redundant

The invoice is a PDF generated from the Estimate screen. What it gives that
nothing else does: a document that can be printed, filed, or sent to somebody's
accountant or HOA.

What now overlaps it:
- the quote link shows the price, what is included, the deposit and the balance;
- the approval email already sends the contract copy she keeps;
- the payment link bills the exact figure.

**My recommendation:** keep the ability to produce it, drop it from the main
flow. It stops being a step and becomes a button you press when somebody asks
for a PDF — which is what it actually is. Nothing is deleted, nothing can be
missed, and the screen gets shorter.

**I have not done this one.** It is the only change here that removes something
from where you are used to finding it, and I would rather you said yes first.

---

## 5. "Maybe a template to send it as it is sent to the email"

Worth doing, and it is nearly free now. Every customer-facing email this product
sends is written in one file (`_shared/email-templates.ts`) in three languages,
and as of today they all render through the same branded card — logo, company
name, one button, footer.

The payment request has no template of its own: it is a sentence assembled on
the phone and handed to a mail app. Giving it one would put it in the same place
as the rest, in all three languages, and send it the same way.

That is the same change as the gap in §1, which is why I would do them together.

---

## What I need from you

1. **Invoice** — move it off the main flow to a "make a PDF" button? yes / no
2. Anything in §2 or §3 you still want gone, now that you know what it does

Everything else here I will build without asking.
