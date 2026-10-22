#!/usr/bin/env node
/**
 * Adds the Ads A10 (lead ads, locked) block to CLAUDE.md, which lives only in the main checkout (a worktree hook blocks editing it there).
 *
 *   node scripts/apply-claude-md-a10.mjs [path/to/CLAUDE.md]     (default: ./CLAUDE.md, run from the main checkout)
 *
 * Inserts the block right before the "## If this becomes a SaaS" heading (the end of the Ads section). Asserts: exits 1 when the
 * heading is missing, or when the block is already there (idempotent). Then delete this script.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'CLAUDE.md';
const ANCHOR = '## If this becomes a SaaS';
const MARK = '**A10: lead ads, locked**';

const BLOCK = `${MARK} (\`ads/leads.ts\`, \`routes/adsLeads.ts\`, \`dashboard/js/pages/ads_leads.js\`, the Leads goal in \`ads/spec.ts\` and
\`ads_create.js\`; FLOWS.md §7.8; Help → Ads: lead-ads, leads-and-privacy; \`docs/ADS_GUIDE.md\` "Lead ads"; migration v57).
- **Locked per tenant** until the platform admin records a non-revoked \`lead_ads\` row in \`ads_legal_signoffs\` (tenant detail ->
  "Ads: legal sign-off"). Locked: no form (403 \`LOCKED_LEGAL\`), no \`goal: 'leads'\` draft (\`checkLeadSpec\`, also every target country
  must be in the sign-off), no \`leadgen\` Page subscription, and a stray \`ads.lead\` job fetches nothing. Egypt PDPL deadline 2026-11-01.
- **The \`leadgen\` subscription follows the lock.** \`subscribePage(…, extraFields)\` + \`leadgenFieldsFor\` (a \`subscribed_apps\` POST
  REPLACES the fields, so the connect path passes it too); the admin sign-off routes call \`syncLeadgenSubscription\`; the 6-hourly
  catch-up re-syncs. The app-level Page webhook needs the \`leadgen\` field (App Dashboard; \`diagnose.mjs\` notes it).
- **Page token, not the ads token, not \`ads_ops\`.** Forms: ONE \`POST /{page}/leadgen_forms\` (idempotency key per dialog, no retry; a
  timeout stays \`pending\` until the catch-up adopts it by name). Leads: webhook -> \`ads.lead\` job (ids only) -> \`GET /{leadgen_id}\`;
  a throttle is \`throttled\`, never retried; the catch-up reads \`/{form}/leads?filtering=[time_created GREATER_THAN …]\` every 6 h.
- **Personal data.** \`answers_enc\` = AES-256-GCM (\`crypto.ts encryptBytes\`); \`person_keys\` = HMAC (\`personKey\`) of the normalised
  email/phone, for erasure. Retention \`leadRetentionDays\` (default 90): \`purgeExpiredLeads\` nulls both and keeps a count row, and a
  lowered setting applies to old leads. Erasure by email/phone deletes whole rows. Never logged, never to an AI (proposal GOALS have
  no 'leads'), nothing contacts a lead. CSV export audited (\`ads.leads_exported\`, counts only). Leads are owner-only, reads included.
- **Rollout:** \`npm run migrate\` (v57) BEFORE the merge. A sign-off for the owner's real tenant is the owner's decision, not ours.

`;

const text = readFileSync(file, 'utf8');
if (text.includes(MARK)) {
    console.error(`${file} already has the A10 block; nothing changed.`);
    process.exit(1);
}
const at = text.indexOf(`\n${ANCHOR}\n`);
if (at < 0) {
    console.error(`Anchor "${ANCHOR}" not found in ${file}; nothing changed.`);
    process.exit(1);
}
writeFileSync(file, `${text.slice(0, at + 1)}${BLOCK}${text.slice(at + 1)}`);
console.log(`Inserted the A10 lead ads block before "${ANCHOR}" in ${file}.`);
