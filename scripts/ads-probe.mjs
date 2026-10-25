#!/usr/bin/env node
/**
 * Ads probe: "what does Meta say about this tenant's ad account right now?"
 *
 * READ-ONLY, twice over. The database is reached only through `connectReadOnly` (every statement in its own
 * `BEGIN READ ONLY … ROLLBACK`, scripts/lib/live.mjs), and every call to Meta is a GET. It never creates, edits,
 * pauses or deletes anything, and never prints the token, the app secret, or a funding display string in full.
 *
 *   node scripts/ads-probe.mjs                      the platform owner's tenant (first creator by created_at)
 *   node scripts/ads-probe.mjs --tenant <uuid>      a specific tenant
 *   node scripts/ads-probe.mjs --env ../.env        explicit .env (worktrees have none)
 *   node scripts/ads-probe.mjs --json               machine-readable
 *
 * What it prints (spec 002-meta-ads-manager, R22, T032), each as its own section, so one refusal from Meta does not
 * end the run:
 *   tier         the access tier and `acc_id_util_pct` from `x-ad-account-usage`, and the version Meta served
 *                (`facebook-api-version`) against the version asked for
 *   minimum_budgets   GET act_<id>/minimum_budgets
 *   account      GET act_<id>: status, currency, time zone, spend cap, amount spent, funding (type and present only),
 *                tos_accepted, business
 *   token        GET debug_token with the app token (META_APP_ID|META_APP_SECRET): type, expiry, scopes
 *   assets       GET me, me/adaccounts, me/accounts (with the linked Instagram account)
 *   eligibility  boost_eligibility_info of the last 5 Instagram reels of the tenant
 *
 * Money fields (`spend_cap`, `amount_spent`, `balance`, `min_daily_budget`, minimum budgets) are printed exactly as Meta
 * returns them: strings in the account currency's MINOR units. That is on purpose: knowing the units is part of what
 * this probe is for.
 *
 * Exit: 0 every section answered · 1 at least one section was refused or empty · 3 the probe could not run.
 */
import axios from 'axios';
import path from 'path';
import { pathToFileURL } from 'url';
import { connectReadOnly, decryptSecret, loadEnv, parseArgs, safeQuery } from './lib/live.mjs';

export const DEFAULT_VERSION = 'v26.0';
const GRAPH_HOST = 'https://graph.facebook.com';
const ACCOUNT_FIELDS = [
    'name', 'currency', 'timezone_name', 'timezone_offset_hours_utc', 'account_status', 'disable_reason',
    'is_prepay_account', 'spend_cap', 'amount_spent', 'balance', 'min_daily_budget', 'tos_accepted',
    'funding_source_details', 'business',
].join(',');

// ─── Pure helpers (exported for ads-probe.test.mjs) ──────────────────────────────────────────────────────────────────

/** A response header that holds JSON, or null when it is absent or not JSON. A missing header is never zero. */
export function parseJsonHeader(value) {
    if (value === undefined || value === null || value === '') return null;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * `x-ad-account-usage` → `{ tier, accIdUtilPct, resetTimeDuration }`. A field Meta did not send is null, not 0, and a
 * missing header is null as a whole.
 */
export function parseAdAccountUsage(headers) {
    const raw = parseJsonHeader(headers?.['x-ad-account-usage']);
    if (!raw) return null;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    return {
        tier: typeof raw.ads_api_access_tier === 'string' ? raw.ads_api_access_tier : null,
        accIdUtilPct: num(raw.acc_id_util_pct),
        resetTimeDuration: num(raw.reset_time_duration),
    };
}

/** The version Meta says it served, from `facebook-api-version`. Null when absent. */
export function servedVersion(headers) {
    const v = headers?.['facebook-api-version'];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** `••••1234`: only the last four DIGITS of a display string, so "Visa ····4242 exp 12/27" cannot leak more. Null when it has none. */
export function maskDisplayString(value) {
    if (typeof value !== 'string') return null;
    const digits = value.replace(/\D/g, '');
    if (digits.length === 0) return '••••';
    return `••••${digits.slice(-4)}`;
}

/** The funding source as the probe prints it: its type and whether there is one, never the display string in full. */
export function summariseFunding(details) {
    if (!details || typeof details !== 'object') return { present: false, type: null, display: null };
    return {
        present: true,
        type: details.type ?? null,
        display: maskDisplayString(details.display_string),
    };
}

/** Meta's error body (or a transport failure) as `{ code, subcode, message }`. */
export function metaError(responseOrError) {
    const body = responseOrError?.data ?? responseOrError?.response?.data;
    const e = body && typeof body === 'object' ? body.error : null;
    if (e && typeof e === 'object') {
        return { code: e.code ?? null, subcode: e.error_subcode ?? null, message: String(e.message ?? 'unknown error') };
    }
    const status = responseOrError?.status ?? responseOrError?.response?.status;
    if (status) return { code: null, subcode: null, message: `HTTP ${status} with no Graph error body` };
    return { code: null, subcode: null, message: String(responseOrError?.message ?? responseOrError ?? 'request failed') };
}

/**
 * A function that removes every given secret from a string. Applied to ALL output (text and JSON) as the last step, so
 * even an error message that quoted a token cannot print it. Secrets shorter than 8 characters are ignored: replacing
 * them would shred ordinary words and they are not credentials anyway.
 */
export function makeRedactor(secrets) {
    const list = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 8))].sort((a, b) => b.length - a.length);
    return (text) => {
        let out = String(text);
        for (const s of list) out = out.split(s).join('[redacted]');
        return out;
    };
}

/** `v26.0`-shaped, else the default: a garbled platform setting must not build a nonsense URL. */
export function pickVersion(stored) {
    return typeof stored === 'string' && /^v\d{1,3}\.\d{1,2}$/.test(stored.trim()) ? stored.trim() : DEFAULT_VERSION;
}

/** The first `count` reels out of a media page, in the order Meta returned them (newest first). */
export function pickReels(media, count = 5) {
    return (Array.isArray(media) ? media : []).filter((m) => m && m.media_product_type === 'REELS').slice(0, count);
}

// ─── Meta (GET only) ─────────────────────────────────────────────────────────────────────────────────────────────────

const http = axios.create({ timeout: 20000, validateStatus: () => true });

/**
 * One GET. The token travels in the `Authorization: Bearer` header, never in the URL. Returns `{ ok, status, headers, data,
 * error }` and never throws: a section reports Meta's refusal and the run goes on.
 */
async function graphGet(version, endpoint, token, params = {}) {
    try {
        const res = await http.get(`${GRAPH_HOST}/${version}/${endpoint}`, {
            params,
            headers: { Authorization: `Bearer ${token}` },
        });
        const ok = res.status >= 200 && res.status < 300 && !(res.data && res.data.error);
        return { ok, status: res.status, headers: res.headers ?? {}, data: res.data, error: ok ? null : metaError(res) };
    } catch (err) {
        return { ok: false, status: 0, headers: {}, data: null, error: metaError(err) };
    }
}

// ─── The run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h) {
        console.log(`
AutoReply Pro ads probe — read-only. What Meta says about a tenant's ad account.

  node scripts/ads-probe.mjs [options]

  --tenant <uuid>   the tenant (creators.id). Default: the first creator by created_at (the platform owner)
  --env <path>      .env to read DATABASE_URL, TOKEN_ENCRYPTION_KEY and META_APP_ID/META_APP_SECRET from
  --json            machine-readable output
  --help

Exit: 0 every section answered · 1 a section was refused or empty · 3 could not run.`);
        return 0;
    }
    loadEnv(typeof args.env === 'string' ? args.env : null);
    const JSON_OUT = Boolean(args.json);

    const secrets = [];
    let redact = makeRedactor(secrets);
    const out = (line = '') => { if (!JSON_OUT) console.log(redact(line)); };
    const report = { tenant: null, version: null, sections: {} };
    let failed = 0;

    // ── Database: the tenant, its ads settings, the pinned version. Nothing is written.
    let db;
    try {
        db = await connectReadOnly('autoreply-ads-probe');
    } catch (err) {
        console.error(redact(`Could not open a read-only database connection: ${err.message}`));
        return 3;
    }
    let creator, settingsRows;
    try {
        const tenantArg = typeof args.tenant === 'string' ? args.tenant : null;
        const c = tenantArg
            ? await safeQuery(db, 'SELECT id, instagram_page_id FROM creators WHERE id = $1', [tenantArg])
            : await safeQuery(db, 'SELECT id, instagram_page_id FROM creators ORDER BY created_at ASC LIMIT 1');
        if (c.error) throw new Error(c.error);
        creator = c.rows[0];
        if (!creator) throw new Error(tenantArg ? `no creator with id ${tenantArg}` : 'there are no creators');
        const keys = [`ads.settings.${creator.id}`, `ads.token.${creator.id}`, 'ads.api_version'];
        const s = await safeQuery(db, 'SELECT key, value, is_secret FROM app_settings WHERE key = ANY($1::text[])', [keys]);
        if (s.error) throw new Error(s.error);
        settingsRows = new Map(s.rows.map((r) => [r.key, r]));
    } catch (err) {
        console.error(redact(`Could not read the tenant or its ads settings: ${err.message}`));
        return 3;
    } finally {
        await db.end().catch(() => {});
    }

    let settings = {};
    try { settings = JSON.parse(settingsRows.get(`ads.settings.${creator.id}`)?.value ?? '{}') || {}; } catch { settings = {}; }
    const adAccountId = typeof settings.adAccountId === 'string' ? settings.adAccountId.replace(/^act_/i, '') : null;
    const version = pickVersion(settingsRows.get('ads.api_version')?.value);
    report.tenant = creator.id;
    report.version = version;

    let token = '';
    let tokenError = null;
    try {
        token = decryptSecret(settingsRows.get(`ads.token.${creator.id}`)?.value ?? '');
    } catch (err) {
        tokenError = err.message;
    }
    // From here on, nothing printed may contain these.
    secrets.push(token);
    const appId = process.env.META_APP_ID || '';
    const appSecret = process.env.META_APP_SECRET || '';
    secrets.push(appSecret);
    const appToken = appId && appSecret ? `${appId}|${appSecret}` : '';
    secrets.push(appToken);
    redact = makeRedactor(secrets);

    out(`Ads probe · tenant ${creator.id} · pinned version ${version}`);
    out(`ad account: ${adAccountId ? `act_${adAccountId}` : 'not set'} · token: ${token ? 'saved' : tokenError ? 'unreadable' : 'not set'}`);
    if (!adAccountId || !token) {
        const why = tokenError ? `the token could not be decrypted (${tokenError})` : !token ? 'no ads token is saved for this tenant' : 'no ad account id is saved for this tenant';
        out(`Nothing to ask Meta: ${why}.`);
        report.sections.setup = { error: why };
        if (JSON_OUT) console.log(redact(JSON.stringify(report, null, 2)));
        return 1;
    }

    const section = async (name, title, fn) => {
        out();
        out(`── ${title}`);
        let result;
        try {
            result = await fn();
        } catch (err) {
            result = { error: { code: null, subcode: null, message: err.message } };
        }
        report.sections[name] = result;
        if (result.error) {
            failed++;
            const e = result.error;
            out(`   refused: code ${e.code ?? '-'} / subcode ${e.subcode ?? '-'} / ${e.message}`);
        }
        return result;
    };
    const kv = (obj) => { for (const [k, v] of Object.entries(obj)) out(`   ${k}: ${v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : v}`); };

    // ── Account node first: it carries the usage headers every other call is judged by.
    const acct = await graphGet(version, `act_${adAccountId}`, token, { fields: ACCOUNT_FIELDS });

    await section('tier', 'Access tier and version', async () => {
        const usage = parseAdAccountUsage(acct.headers);
        const served = servedVersion(acct.headers);
        const data = {
            tier: usage?.tier ?? null,
            acc_id_util_pct: usage?.accIdUtilPct ?? null,
            reset_time_duration_s: usage?.resetTimeDuration ?? null,
            version_asked: version,
            version_served: served,
            version_match: served ? served === version : null,
        };
        kv(data);
        if (!usage) out('   (no x-ad-account-usage header on the account call)');
        return { data };
    });

    await section('minimum_budgets', 'Minimum budgets (minor units)', async () => {
        const r = await graphGet(version, `act_${adAccountId}/minimum_budgets`, token);
        if (!r.ok) return { error: r.error };
        const rows = Array.isArray(r.data?.data) ? r.data.data : [];
        out(`   ${rows.length} rows`);
        for (const row of rows.slice(0, 12)) out(`   ${JSON.stringify(row)}`);
        if (rows.length > 12) out(`   … ${rows.length - 12} more`);
        return { data: rows };
    });

    await section('account', 'Ad account', async () => {
        if (!acct.ok) return { error: acct.error };
        const a = acct.data ?? {};
        const funding = summariseFunding(a.funding_source_details);
        const data = {
            name: a.name ?? null,
            currency: a.currency ?? null,
            timezone_name: a.timezone_name ?? null,
            timezone_offset_hours_utc: a.timezone_offset_hours_utc ?? null,
            account_status: a.account_status ?? null,
            disable_reason: a.disable_reason ?? null,
            is_prepay_account: a.is_prepay_account ?? null,
            spend_cap: a.spend_cap ?? null,
            amount_spent: a.amount_spent ?? null,
            balance: a.balance ?? null,
            min_daily_budget: a.min_daily_budget ?? null,
            tos_accepted: a.tos_accepted ?? null,
            business: a.business ? { id: a.business.id ?? null, name: a.business.name ?? null } : null,
            funding,
        };
        kv(data);
        return { data };
    });

    await section('token', 'Token (debug_token)', async () => {
        if (!appToken) return { error: { code: null, subcode: null, message: 'unavailable: META_APP_ID / META_APP_SECRET are not set here' } };
        // debug_token takes the inspected token as a query parameter; the app token goes in the header.
        const r = await graphGet(version, 'debug_token', appToken, { input_token: token });
        if (!r.ok) return { error: r.error };
        const d = r.data?.data ?? {};
        const expires = d.expires_at === 0 ? 'never' : d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null;
        const data = {
            type: d.type ?? null,
            app_id: d.app_id ?? null,
            is_valid: d.is_valid ?? null,
            expires,
            data_access_expires_at: d.data_access_expires_at === 0 ? 'never' : d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000).toISOString() : null,
            scopes: Array.isArray(d.scopes) ? d.scopes : [],
        };
        kv(data);
        return { data };
    });

    await section('assets', 'Assigned assets', async () => {
        const [me, accounts, pages] = await Promise.all([
            graphGet(version, 'me', token, { fields: 'id,name' }),
            graphGet(version, 'me/adaccounts', token, { fields: 'account_id,name,currency,account_status', limit: 200 }),
            graphGet(version, 'me/accounts', token, { fields: 'id,name,instagram_business_account{id,username}', limit: 100 }),
        ]);
        const data = {};
        const errors = [];
        if (me.ok) { data.me = { id: me.data.id ?? null, name: me.data.name ?? null }; out(`   me: ${data.me.name ?? '-'} (${data.me.id ?? '-'})`); }
        else { errors.push(`me: ${me.error.code ?? '-'}/${me.error.subcode ?? '-'} ${me.error.message}`); }
        if (accounts.ok) {
            data.adAccounts = (accounts.data?.data ?? []).map((a) => ({ id: a.account_id ?? null, name: a.name ?? null, currency: a.currency ?? null, status: a.account_status ?? null }));
            out(`   ad accounts (${data.adAccounts.length}):`);
            for (const a of data.adAccounts) out(`     act_${a.id}  ${a.name ?? '-'}  ${a.currency ?? '-'}  status ${a.status ?? '-'}${a.id === adAccountId ? '   <- this tenant' : ''}`);
        } else { errors.push(`me/adaccounts: ${accounts.error.code ?? '-'}/${accounts.error.subcode ?? '-'} ${accounts.error.message}`); }
        if (pages.ok) {
            data.pages = (pages.data?.data ?? []).map((p) => ({ id: p.id ?? null, name: p.name ?? null, instagram: p.instagram_business_account ? { id: p.instagram_business_account.id ?? null, username: p.instagram_business_account.username ?? null } : null }));
            out(`   pages (${data.pages.length}):`);
            for (const p of data.pages) out(`     ${p.id}  ${p.name ?? '-'}  instagram: ${p.instagram ? `@${p.instagram.username ?? '-'} (${p.instagram.id})` : 'none linked'}`);
        } else { errors.push(`me/accounts: ${pages.error.code ?? '-'}/${pages.error.subcode ?? '-'} ${pages.error.message}`); }
        if (errors.length) { for (const e of errors) out(`   refused: ${e}`); data.errors = errors; }
        // A partial answer is still a finding: the run only counts as failed when every read was refused.
        return errors.length === 3 ? { error: { code: null, subcode: null, message: errors.join(' | ') } } : { data };
    });

    await section('eligibility', 'Boost eligibility of the last 5 reels', async () => {
        const ig = creator.instagram_page_id;
        if (!ig) return { error: { code: null, subcode: null, message: 'this tenant has no Instagram account id (creators.instagram_page_id)' } };
        const r = await graphGet(version, `${ig}/media`, token, { fields: 'id,media_product_type,timestamp,boost_eligibility_info', limit: 25 });
        if (!r.ok) return { error: r.error };
        const reels = pickReels(r.data?.data, 5);
        out(`   ${reels.length} reel(s) among ${(r.data?.data ?? []).length} recent media`);
        for (const m of reels) out(`   ${m.id}  ${m.timestamp ?? '-'}  ${JSON.stringify(m.boost_eligibility_info ?? null)}`);
        return { data: reels.map((m) => ({ id: m.id, timestamp: m.timestamp ?? null, boost_eligibility_info: m.boost_eligibility_info ?? null })) };
    });

    out();
    out(failed === 0 ? 'All sections answered.' : `${failed} section(s) were refused or empty.`);
    if (JSON_OUT) console.log(redact(JSON.stringify(report, null, 2)));
    return failed === 0 ? 0 : 1;
}

if (isMain) {
    main().then((code) => process.exit(code), (err) => {
        console.error(`ads-probe could not run: ${err?.message ?? err}`);
        process.exit(3);
    });
}
