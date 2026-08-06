# HANDOFF: Rebuild /draft-order as a step-by-step questionnaire

Written 2026-08-06 by the previous Claude session, at Mikey's request. Read fully before coding.

## What Mikey wants (his words, paraphrased)
The current Create a Draft Order page has too many moving parts shown at once. A customer
walks in / calls and staff fumble. He wants a **step-by-step wizard**, and specifically:
- **Address comes FIRST (for local delivery)** so the local delivery fee is calculated
  automatically from the ZIP — today staff must add the fee manually and forget/get it wrong.
- Gift card message must be part of the flow (it's currently forgotten).
- Fewer visible decisions per screen. His staff is not computer-savvy — one question at a time.

## Suggested step order (confirm with Mikey before building)
1. **How is it going out?** Pickup / Local delivery / Shipping (3 big buttons)
2. If local delivery → **address + ZIP first** → fee auto-added from the ZIP table, shown big.
   ZIP table already exists: `DELIVERY_FEES` object in index.js (used by the order-lookup ZIP tool).
   If ZIP not in table → tell staff "not in our delivery area — ask Mikey", don't guess.
3. **Products** — reuse existing product search + custom item (qty × price) from current page.
4. **Gift message?** yes/no → if yes, textarea (prints on gift card via the normal flow).
5. **Customer** — name / phone / email (email optional but needed for emailed pay link).
6. **Review screen** — everything on one card → Create Draft → then the existing two-path
   payment choice (phone = Collect payment in Shopify; email = send pay link).

## What already exists (REUSE, don't rebuild)
All in `index.js` of repo TheSweetToothusa/sweet-tooth-printer (Render auto-deploys main
in ~1-2 min to sweet-tooth-printer-automation.onrender.com):
- `POST /draft-order/create` — creates the Shopify draft: line_items (variantId or custom
  title/price/qty), shipping line (title+price — use this for the local delivery fee),
  discount, email, note. Returns admin URL + invoice URL.
- `POST /draft-order/send-invoice` — emails Shopify pay link for a draft id.
- `GET /draft-order/products` — product search endpoint used by the current page.
- `DELIVERY_FEES` — ZIP→fee map (source of truth; the driver app's table).
- `dashPage()/dashTile()` — shared page chrome. Every page must keep the centered HOME button.
- Design language: white cards, #FAF7F8 bg, #F7B5CD pink accents, big rounded inputs,
  emoji icons, font-size ≥15px. Look at /switch-shipping and /create-discount for tone.

## House rules that apply (from Mikey, non-negotiable)
- Internal pages open SAME tab (they have HOME); only external sites get target=_blank.
- Simple language on all UI text — sixth-grade level, no jargon.
- Never invent facts/claims in customer-facing text.
- MANDATORY visual QA: screenshot desktop + mobile of every screen BEFORE telling Mikey done.
- Test end-to-end by creating a real draft order, verify in Shopify, then DELETE the test
  draft (DELETE /admin/api/2025-01/draft_orders/{id}.json). Never send test emails to real
  customer addresses.
- Credentials for Shopify API: ~/sweet-tooth-shopify/CLAUDE.md (admin token; theme token).
- After shipping: update the Notion "WHERE IS IT?" page (id 2fb95c8d-ebe1-81e3-80c6-e763ea90acc4)
  — the employee-dashboard section — and bump its Last Updated date.

## Context that will save you mistakes
- Phone orders typed by staff on the STORE website get auto-tagged st_staff_entered (IP-based).
  Draft orders created through this wizard are inherently staff-entered — consider tagging the
  resulting draft/order st_staff_entered too so the reporting stays complete.
- Staff already know the current page; don't rename the tile ("Create a Draft Order").
- Mikey approves UI copy: show him the step titles + any customer-facing wording and WAIT
  for GO before deploying (internal layout itself is fine to build).
- Keep the old /draft-order reachable until the new flow is approved (e.g. build at
  /draft-order-new, swap the tile after GO).

## Verify-done checklist for the new session
[ ] ZIP in table → fee auto-appears; ZIP not in table → clear "ask Mikey" message
[ ] Draft created with delivery fee as shipping line; gift message arrives on the draft note
    or attributes so it prints on the gift card like web orders (CHECK how web orders carry
    it: note_attributes "Gift Message" — mirror that)
[ ] Pay-by-phone and email-pay-link paths both work from the review screen
[ ] Desktop + mobile screenshots shown to Mikey
[ ] Test draft deleted; Notion updated
