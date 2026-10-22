#!/usr/bin/env node
/**
 * Adds the Ads A8 (audiences) block to CLAUDE.md, which lives only in the main checkout (a worktree hook blocks editing it there).
 *
 *   node scripts/apply-claude-md-a8.mjs [path/to/CLAUDE.md]     (default: ./CLAUDE.md, run from the main checkout)
 *
 * Inserts the block right before the "## If this becomes a SaaS" heading (the end of the Ads section). Asserts: exits 1 when the
 * heading is missing, or when the block is already there (idempotent). Then delete this script.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'CLAUDE.md';
const ANCHOR = '## If this becomes a SaaS';
const MARK = '**A8: audiences**';

const BLOCK = `${MARK} (\`ads/audiences.ts\`, \`ads/hashing.ts\`, \`ads/legalSignoff.ts\`, \`routes/adsAudiences.ts\`, \`dashboard/js/pages/ads_audiences.js\`;
FLOWS.md §7.6; Help → Ads: audiences, lookalikes, customer-lists; \`docs/ADS_GUIDE.md\` "Audiences"; migration v56, which also holds A9's
\`ads_rules\` / \`ads_rule_runs\`).
- **Custom Audience Terms are accepted in Meta's UI only.** \`tos_accepted\` from the account read (\`health.account.tosAccepted\`) false ->
  409 \`TERMS_NOT_ACCEPTED\` with the link; a create refused 200/1870090 fails its op and the card says the same.
- **Flagged (\`operation_status\` 471) is unusable** and reviewable only in Meta. Names are neutral: \`validateAudienceName\` refuses health,
  money-trouble, religion, orientation, politics and DM-bot segment words; the bot's conversation labels never become a name or a seed.
- **Customer lists are locked per tenant** until the platform admin records a non-revoked \`customer_lists\` row in \`ads_legal_signoffs\`
  (tenant detail -> "Ads: legal sign-off"); 403 \`LOCKED_LEGAL\` is answered before the text is read. Egypt PDPL deadline 2026-11-01.
- **Never store raw contacts.** Parse + normalise + SHA-256 in the request; opted-out (WhatsApp \`opted_out_at\`, marketing consent withdrawn,
  \`customer_list_optout\` hashes) and uncovered-country rows dropped; \`audience_users\` ops on \`{dep}/users\` with \`scrub: true\`; the row
  keeps only counts. \`ads.audiences.test.ts\` pins that no raw value reaches the queue, the DB, the audit or the answer.
- **Rollout:** \`npm run migrate\` (v56) BEFORE the merge.

`;

const text = readFileSync(file, 'utf8');
if (text.includes(MARK)) {
    console.error(`${file} already has the A8 block; nothing changed.`);
    process.exit(1);
}
const at = text.indexOf(`\n${ANCHOR}\n`);
if (at < 0) {
    console.error(`Anchor "${ANCHOR}" not found in ${file}; nothing changed.`);
    process.exit(1);
}
writeFileSync(file, `${text.slice(0, at + 1)}${BLOCK}${text.slice(at + 1)}`);
console.log(`Inserted the A8 audiences block before "${ANCHOR}" in ${file}.`);
