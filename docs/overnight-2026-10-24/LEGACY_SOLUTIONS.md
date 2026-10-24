# Legacy Solutions website: audit and build summary

Date: 2026-10-24. Nothing was deployed, committed, bought or sent. Only files
under `website/legacy/` and this note were written.

## Audit: what already exists

Searched the whole repo (excluding build output) for "Legacy" and for
"Legacy Solutions" specifically, plus a file-name search.

- **No Legacy Solutions logo, brand asset, page or stylesheet exists.**
  `website/media/` holds only the FenceFlow demo video and poster. No file name
  contains "legacy" other than two pricing fixtures and a compiled Kotlin class
  (all about "legacy" in the sense of old code).
- The exact phrase "Legacy Solutions" appears in only three places, none of them
  branding:
  - `app/.../estimate/PdfExporter.kt:368`: a code comment using it as an example
    of a long company name.
  - `tests/a24-dash-company-record-fields.test.mjs:126`: test data,
    `business_name: "Legacy solutions"`.
  - `CHECK_LIST_2026-10-05.md:188`: records that the phone's PDFs show
    "Legacy solutions" while the public page says "Fence Solutions", the company
    record says "Fence solutions", and the licensing reply email signs off
    "Fence Solutions Legacy". The owner's fence business name is already
    inconsistent in four places; Legacy Solutions adds a fifth if not settled.
- `docs/ONBOARDING_REALITY.md` mentions a signed-up company called "Legacy" (a
  customer record). Not branding; not used or referenced on the new site.
- `website/fence-solutions/index.html` is the existing contracting-business page
  ("Fence Solutions", Tampa Bay). It is a different thing from Legacy Solutions
  and was left alone.

## What was built

`website/legacy/` is a self-contained static site, one page with anchor
sections: home, software solutions, FenceFlow, FenceFlow plans, about, contact.

| File | Purpose |
|---|---|
| `website/legacy/index.html` | The whole page, with comment-marked placeholders |
| `website/legacy/styles.css` | Tokens, light and dark themes, layout |
| `website/legacy/legacy.js` | Year in footer; contact form stub that sends nothing |
| `website/legacy/favicon.svg` | Placeholder icon matching the placeholder mark |

House style: token names and the light/dark mechanism copied from
`fence-solutions/index.html` (`prefers-color-scheme` unless `data-theme="light"`,
plus `data-theme="dark"`); fonts are Barlow Condensed, IBM Plex Sans and IBM Plex
Mono, the families `website/index.html` already loads. Orange (FenceFlow's
colour) is used only for FenceFlow content; Legacy's own colour is the navy.
The only external fetch is the Google Fonts stylesheet. Outbound links go to
fenceflowapp.com.

Checked in the browser pane: no horizontal overflow at 320 and 375 px; dark and
light both render; the contact button and a synthetic submit event both only show
"not connected" and produce zero network requests; the form has no action or
method and its button is `type="button"`.

## Wording decisions

- No legal entity, incorporation, LLC, partnership or registration is stated or
  implied. No copyright symbol (to avoid reading as an entity claim); the footer
  says "Legacy Solutions . Florida . year".
- No testimonials, client names or logos, statistics, awards, certifications,
  partnerships, staff, or years in business. The About section has a labelled
  placeholder where real content would go.
- No licence or insurance claims anywhere. `docs/CUSTOMER_REPLY_LICENSING.md`
  says the contracting side is not yet licensed or insured, so do not add
  "licensed" or "insured" to this site unless that changes.
- FenceFlow content is the facts you supplied, plus the three plans' feature
  lists copied from the pricing section of `website/index.html`.
- Dollar prices are deliberately NOT repeated (single source of truth). The page
  links to `fenceflowapp.com/#pricing`. A comment in the plans section records
  that index.html currently shows $99 / $199 / $349.
- The plans text says "a card is taken when you pick a plan, first charge when
  the trial ends", matching the correction already in index.html.

## What the owner still needs to supply or decide

1. **Logo.** None exists. The header mark and `favicon.svg` are plain
   placeholders (a geometric "L").
2. **Real contact details.** The email and phone are visibly marked
   placeholders. FenceFlow product support (`support@fenceflowapp.com`) is shown
   because it is already public. Location is shown only as "Florida".
3. **Contact form endpoint.** The form is a stand-in. Wiring checklist is in the
   comment above the form in `index.html` and the comment in `legacy.js`
   (endpoint with validation, rate limit, honeypot `website`, delivery to a
   mailbox; switch the button to `type="submit"`; remove the preview notice and
   every `data-remove-at-launch` element). A mailbox for it also needs to exist;
   see the Zoho SMTP note in memory.
4. **Privacy notice and terms for Legacy Solutions itself**, needed once the form
   collects anything. The footer links currently go to FenceFlow's.
5. **Domain.** None chosen. The page is `noindex` and has no canonical or og:url
   until one exists (comment at the top of `<head>`).
6. **About content**, only if true: founder name/photo, story, credentials.
7. **Decision on custom work.** The "Another trade, a similar problem?" card is
   an invitation only. Say outright that Legacy Solutions takes custom work, or
   delete the card; the form's "Software for my trade business" option goes with
   it.
8. **Business name consistency** (existing checklist item): settle the single
   name used in Business Settings, PDFs and emails.
9. Not checked: whether "Legacy Solutions" is already in use by another business
   in Florida or as a trademark, and whether a fictitious-name registration is
   wanted. That is a question for the owner, not something the site asserts.

## Things noticed in passing (not changed)

- The Pro plan lists "Cloud photo and document backup", copied from index.html;
  the plan-tier notes say it is advertised but not gated. The new page repeats
  the existing claim.
- `website/index.html` has no dark mode; `fence-solutions/` does. The new site
  follows the latter.
