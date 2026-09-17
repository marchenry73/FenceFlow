# Re-approval when the drawing changes

**The rule, from the owner:** if the drawing changes after the customer approved,
the quote needs approving again. A customer must never be bound to a fence they
did not agree to, and the office must not be able to quietly enlarge an approved
job.

Enforced in the database (`supabase_reapproval_on_drawing_change.sql`), because
both the phone and the office write `fence_runs`.

## What counts as "material"

Compared per run, off the takeoff maths (a port of `FenceGeometryEngine.analyze`
and `EstimateEngine.linearFeet`), not off the row bytes:

| In the fingerprint | Why |
|---|---|
| built linear feet (0.1 ft) | what the labour rate and the material list are priced from |
| teardown linear feet (0.1 ft) | bills at `teardown_rate_per_ft`, kept separate |
| corner count (turn ≥ 15°) | corner posts |
| end count (0 closed loop, 2 open) | end posts |
| gate count, total gate width | gate items and gate rate |
| gate mountings (WALL/LINE/LINE_TO_WALL) | decides concrete and hardware |

Not material, so these never disturb an approval: `label`, `color_or_finish`,
`sort_order`, `suppressed_roles`, `updated_at`, gate **swing**, a gate sliding
along the line at the same width and mounting, the whole polyline dragged to sit
better on the survey photo, the point list reversed, an extra vertex dropped on a
straight stretch, and an empty run added or removed.

Run **inserts** and **deletes** (hard or soft) count, unless the run was empty.

## What happens

On a material change to a job whose `quote_approved_at` is set:

1. `quote_reapprovals` gets a row with the whole prior approval (name, time,
   whether the phone gate ran, contract total, `signed_at`, signature path) plus
   the before/after takeoff. Nothing is deleted; `jobs.signed_at` and
   `jobs.signature_storage_path` are left alone.
2. `audit_log` and `field_changes` each get a line, so the office feed and the
   phone both see it.
3. `jobs.quote_approved_at` / `quote_approved_name` /
   `quote_approved_without_phone_check` are cleared, and
   `jobs.reapproval_required_at`, `reapproval_reason`, `reapproval_count` are
   stamped.
4. **No money column is written.** `deposit_amount`, `amount_paid`,
   `payment_status`, `contract_total`, `refunded_amount`, `job_payments` and
   the payment ledger are untouched. What the cleared approval blocks is
   `create-payment-link` asking for *more*, since it gates on
   `quote_approved_at`.

Re-approval is the ordinary approval: the customer opens the same quote link,
passes the same last-4 phone gate, types their name, and `quote-view` (service
role) sets `quote_approved_at` again. That clears `reapproval_required_at` and
resolves the history rows. There is no other route: `hold_quote_gate_columns()`
still pins those columns for every API caller, and `hold_reapproval_columns()`
now pins the three new ones the same way, so a crew member, an accountant, a
suspended company or an anon caller cannot clear an approval or hide the banner
by poking `jobs`.

## New columns / tables

- `jobs.reapproval_required_at timestamptz` — non-null means **needs approving again**
- `jobs.reapproval_reason text` — an English sentence naming the date and the run
- `jobs.reapproval_count integer`
- `public.quote_reapprovals` — the history (company-readable, client-unwritable)

`quote-view`'s GET response carries `reapprovalRequiredAt` and
`reapprovalReason`.

---

# What the UI must add

`website/dashboard.html` and `app/` are owned by other agents. This is what they
need to add; nothing below is done yet.

## 1. Office — `website/dashboard.html`

- **Job row / job detail badge.** Wherever `j.quote_approved_at` currently
  decides the "Approved" pill (search `quote_approved_at` — around the alert
  tests near lines 5046–5054 and the job detail panel), add: if
  `j.reapproval_required_at` is set, show an amber **"Needs approval again"**
  pill instead of "Not approved", with the date, and `j.reapproval_reason` as
  the tooltip / sub-line.
- **Column list.** Add `reapproval_required_at`, `reapproval_reason`,
  `reapproval_count` to the job select list at ~line 6082 and ~7339, or the
  banner will silently never appear (the field simply arrives `undefined`).
- **Alerts.** Add an alert kind `needs_reapproval` next to `unsigned_approved`
  (~line 6972): jobs with `reapproval_required_at` set, sorted oldest first,
  keyed `needs_reapproval:<id>` with `fp: j.reapproval_required_at`.
- **History.** On the job's activity/audit panel, list `quote_reapprovals` rows
  for the job: date, what changed (`takeoff_before` → `takeoff_after`), who was
  on the prior approval (`prior_approved_name`), and whether it was resolved.
  The old approval must remain visible — this is the record that the customer
  did agree, once, to a different fence.
- **Do not** offer any office-side "approve anyway" button. There is no server
  route for it.

Suggested strings (add to the dashboard `tr()` table, en/es/fr):

| key | en | es | fr |
|---|---|---|---|
| `badgeNeedsReapproval` | Needs approval again | Necesita aprobación de nuevo | Nouvelle approbation requise |
| `reapprovalWhy` | The drawing changed on {0}. The customer has to approve the quote again. | El plano cambió el {0}. El cliente debe aprobar el presupuesto de nuevo. | Le plan a changé le {0}. Le client doit approuver le devis à nouveau. |
| `alertTxtNeedsReapproval` | {0}: the drawing changed after approval — waiting on the customer for {1} days | {0}: el plano cambió después de la aprobación — esperando al cliente desde hace {1} días | {0} : le plan a changé après l'approbation — en attente du client depuis {1} jours |
| `reapprovalHistoryTitle` | Withdrawn approvals | Aprobaciones retiradas | Approbations retirées |
| `reapprovalPrior` | Approved by {0} on {1}, withdrawn {2} | Aprobado por {0} el {1}, retirado el {2} | Approuvé par {0} le {1}, retiré le {2} |
| `reapprovalMoneySafe` | Payments already taken are not affected. | Los pagos ya recibidos no se ven afectados. | Les paiements déjà reçus ne sont pas affectés. |

## 2. Phone — `app/`

- **Room entity + sync.** `Entities.kt` (`Job`), a migration in `AppDatabase.kt`,
  and `JobSync.kt`'s column list need `reapprovalRequiredAt`,
  `reapprovalReason`, `reapprovalCount`. Pull-only: the phone must never push
  these three or `quote_approved_*` (the server pins them anyway, so a push
  would just be silently discarded and read back as drift).
- **Job screen banner** (`ui/jobs/`): when `reapprovalRequiredAt != null`, an
  amber banner above the estimate — title `reapproval_banner_title`, body
  `reapproval_banner_body` with the date, and a "Send the quote again" action
  that re-sends the existing quote link (the token does not change).
- **Survey screen warning** (`ui/survey/`): when the job is approved and the
  user starts editing the drawing, warn *before* the edit lands —
  `reapproval_warn_editing`. This is the one place a person can be told what is
  about to happen rather than discovering it afterwards.
- **Home dashboard** (`ui/jobs/HomeDashboard.kt`): count these jobs in the
  "waiting on the customer" tile rather than in "approved".
- **Crew view**: a job needing re-approval should read as *do not build yet*.

Suggested strings (`values/strings_jobs_polish.xml` + `values-es` + `values-fr`):

| name | en | es | fr |
|---|---|---|---|
| `reapproval_banner_title` | Needs approval again | Necesita aprobación de nuevo | Nouvelle approbation requise |
| `reapproval_banner_body` | The drawing changed on %1$s, so the customer's approval no longer covers this job. Send the quote again. | El plano cambió el %1$s, por lo que la aprobación del cliente ya no cubre este trabajo. Envíe el presupuesto de nuevo. | Le plan a changé le %1$s : l'approbation du client ne couvre plus ce chantier. Renvoyez le devis. |
| `reapproval_warn_editing` | This quote is approved. Changing the fence line or the gates will withdraw the approval and the customer will have to approve it again. | Este presupuesto está aprobado. Cambiar la línea de la valla o las puertas retirará la aprobación y el cliente tendrá que aprobarlo de nuevo. | Ce devis est approuvé. Modifier la ligne de clôture ou les portails retirera l'approbation et le client devra approuver à nouveau. |
| `reapproval_money_safe` | Payments already taken are not affected. | Los pagos ya recibidos no se ven afectados. | Les paiements déjà reçus ne sont pas affectés. |
| `reapproval_do_not_build` | Do not build yet — waiting on the customer to approve the change. | No construya todavía: esperando que el cliente apruebe el cambio. | Ne construisez pas encore : en attente de l'approbation du client. |

## 3. Customer quote page

`quote-view` returns `reapprovalRequiredAt` / `reapprovalReason`. The quote page
should say, above the approve button: **"We updated your drawing on {date}.
Please review it and approve again."** (es: "Actualizamos su plano el {date}.
Revíselo y apruébelo de nuevo." / fr: « Nous avons mis à jour votre plan le
{date}. Veuillez le vérifier et l'approuver à nouveau. ») The approve button
itself is unchanged — same phone gate, same typed name.
