# Overnight run — 24/25 Oct 2026

Written as I go. Everything here is either done with evidence, in flight, or
waiting on you with the reason stated.

---

## Decisions waiting on you

These are yours because guessing puts wrong rules in your app, not because
they are hard.

1. **C1 — cancellation.** `JobStatus` is `DRAFT, SENT, ACCEPTED, COMPLETED,
   DECLINED`. There is no CANCELLED anywhere. Before it can be built:
   when a scheduled job with a deposit paid is cancelled, is the deposit
   **refunded, kept, or partly kept**? Does the job leave the list like a
   declined one? Does it count in reports and in the won/lost figures?
2. **E2 — sandbox.** Is the TEST product key a **real company** you hand a
   setup code to (r42 assumes this), or the app's **existing guest demo**
   (local sample jobs, read-only, wiped, needs no key)? If the second, r42
   PART 1 still stands and PART 2 is unnecessary.
3. **D3 — "so nothing goes in the marker area."** I could not work out what
   this asks for. Everything else in D3 is already built and verified.
4. **Labour display, no fallback.** A job the server has never priced shows
   "Re-price to see this" instead of a figure — on day one that is every job.
   I think it beats five jobs quietly reading as more profitable than they
   are, but it is a visible change and I would rather you chose it.
5. **r41 — setup-code lookalikes.** Written, **not applied**. 1,291 of 4,000
   generated codes (32%) contain `O`, `I`, `0`, `1` or `L`; corrected order
   gives 0 of 4,000. Codes are read down the phone and shown once. Applying
   it changes only codes minted from then on.

---

## Shipped today, with evidence

| | Proof |
|---|---|
| Auto-charge, end to end | deposit saves the card (opt-in, consent shown above the pay button) → webhook records customer/card/consent → office offers to charge it. 11/11 companies opted in. |
| App 1.791 published | hosted filename carries commit `7a61c66`, bytes match the build |
| Four schedulers alive | mail-scheduled, mail-sync, attention-sweep all fixed; follow-ups already worked |
| Pay-here button | `paymentsReady: true` on the deployed function, verified live |
| Reply-to reaches the company | routed address → validated `companies.email` → nothing |
| Money audit | `tests/a4-money-formula.test.mjs`, 76/76, every rule canaried |
| `smoke.ts` revived | 132/132, now gates deploys **and** releases |
| Teardown shows its pricing | `tests/d5-teardown-shows-its-pricing.test.mjs`, 39/39 |
| Sync latch fixed | `tests/b2-device-latch-and-displaced-push.test.mjs`, 38/38 |
| Office reads the engine's labour | r43 applied; three money tests moved onto the new contract and canaried |

### The five that mattered, none of which were on the list

Every one reported success while doing nothing:

1. **A phone could stop syncing permanently.** One failed claim in the window
   right after sign-in latched it for the life of the install, while the card
   read "it will go up on the next sync".
2. **The Pay-here button had never been drawn** on a single quote, for any
   company, while the checkout behind it worked.
3. **The attention sweep had never run** — refused 401 every hour since it was
   written, showing a green tick throughout.
4. **Scheduled email never sent** — the GitHub secret was never saved.
5. **`smoke.ts`** — 130 money assertions, red, wired to nothing.

### Stale list entries, verified already built

F3, D1, D2(b), D3. The list is dated 2026-09-25 and contradicted itself
(line 16 said F3 was verified; line 146 had it open). Ticked with evidence.

---

## In flight / queued overnight

- Restore **test-mode Stripe** so the auto-charge chain is testable without
  real money (dual signing secret, test money still refused at the books).
- Resolve the **unreachable report functions** (`labourEstVsActualTotals`,
  `materialEstVsActualTotals`) — wire up or remove, with evidence.
- **GATE_POST → END_POST fallback** — a company with no `GATE_POST` row in its
  catalog currently bills **nothing** for gate posts. Yours has ten, so your
  quotes are unaffected. Must land in BOTH engines together or the parity gate
  refuses the release, and the 90 fixtures may need regenerating.
- Carry-overs: the sync card still cannot say *"another phone holds this
  login"* (needs an `UnsyncedReason` entry and two screens); `pagedList` stops
  silently at 50 pages / 50,000 rows; engine comments still say
  `LINE is GATE_POST 2` when the code does `GATE_POST 1 + END_POST 1`;
  `jd_teardown_length` / `jd_teardown_note` are orphaned strings.
- **G1 — drawing versions**, finish whatever remains.
- Bug hunting across areas nobody has swept.

---

## Things I chose NOT to do, and why

- **No second publish.** You asked for one. Each publish prompts every phone.
- **No `r41`.** Not approved, and it changes codes you hand to customers.
- **No policy guesses** on C1, E2, D3 or the labour fallback.
- **No third copy of a money rule in the browser.** The office now reads the
  engine's labour figure rather than recomputing it; two copies already drifted
  and a third would be invisible to the parity gate.
