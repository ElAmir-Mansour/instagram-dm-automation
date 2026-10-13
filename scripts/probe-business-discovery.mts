/**
 * Does Business Discovery work for an account that has no role on our app? READ-ONLY, ONE call. (docs/onboarding/03 §1, plan P22.)
 *
 *   npx tsx --env-file=../.env scripts/probe-business-discovery.mts --handle natgeo
 *
 * The onboarding draft reads a tenant's public Instagram through the PLATFORM's own connected account, by handle:
 * `GET /{our-ig-id}?fields=business_discovery.username(<handle>){…}`. That is proven for the accounts in the Growth
 * competitor list, which are public brands, but nothing has proven it for a stranger's account in production. This asks
 * once, for a public handle that should have no role on the app (a big brand), through the app's own code, and prints what
 * came back.
 *
 * What it does: reads the creator the platform discovers as (the setting `onboarding.discovery_creator_id`, else the
 * owner's tenant) through `connectReadOnly`, decrypts that creator's page token with `src/config/crypto.ts` exactly as the
 * app does, and makes ONE Graph GET (`probeBusinessDiscovery`, the field expression the draft sends, through `GraphSession`).
 * Nothing is posted, commented, messaged or written: the database connection is `BEGIN READ ONLY` per statement, and the
 * one Graph request is a GET.
 *
 * What it prints: the handle, the Graph version, the HTTP status and Graph error code, and for the answer the NAMES of the
 * fields that came back with their counts and lengths. Never a value (no bio, no caption, no count, no id, no cursor) and
 * never the token.
 *
 * Exit: 0 Meta returned a profile · 1 it did not (the report says why) · 2 usage, or the script could not run.
 */
// @ts-ignore: plain ESM, no declaration file
import { connectReadOnly, describeDbTarget, loadEnv, parseArgs } from './lib/live.mjs';

const USAGE = `Business Discovery probe. Read-only: one Graph GET.

  npx tsx --env-file=<.env> scripts/probe-business-discovery.mts --handle <instagram username>

  --handle <name>   the public account to look up (a Business or Creator account with no role on the app, e.g. natgeo)
  --env <path>      .env to read DATABASE_URL and TOKEN_ENCRYPTION_KEY from (default: the nearest one above this checkout)
  --help

Exit: 0 profile returned · 1 not returned (see the report) · 2 usage, or could not run.`;

const KNOWN = new Set(['_', 'handle', 'env', 'help', 'h']);

const stop = (message: string, code = 2): never => {
    process.stderr.write(`${message}\n`);
    process.exit(code);
};

const args = parseArgs(process.argv.slice(2)) as Record<string, string | boolean | string[]>;
if (args.help || args.h) {
    console.log(USAGE);
    process.exit(0);
}
const unknown = Object.keys(args).filter((k) => !KNOWN.has(k));
if (unknown.length > 0) stop(`unknown option ${unknown.map((k) => `--${k}`).join(', ')}\n\n${USAGE}`);
if ((args._ as string[]).length > 0) stop(`unexpected argument "${(args._ as string[])[0]}"\n\n${USAGE}`);
if (typeof args.handle !== 'string') stop(`--handle needs an Instagram username.\n\n${USAGE}`);
if (args.env !== undefined && typeof args.env !== 'string') stop('--env needs a path.');

// The environment first: the modules below read TOKEN_ENCRYPTION_KEY and META_API_VERSION when they are used.
loadEnv(typeof args.env === 'string' ? args.env : null);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set. Pass --env <path-to-.env> or export it.');
if (!process.env.TOKEN_ENCRYPTION_KEY) stop('TOKEN_ENCRYPTION_KEY is not set: the stored page token cannot be read. Pass --env <path-to-.env>.');
const target = describeDbTarget(process.env.DATABASE_URL);

const { setLogSink } = await import('../src/utils/log.js');
// The report is what gets pasted: the app's own log lines are not part of it.
setLogSink(() => {});
const { decryptSecret } = await import('../src/config/crypto.js');
const { metaHttp } = await import('../src/services/http.js');
const { API_VERSION } = await import('../src/services/instagram.js');
const { normalizeInstagramHandle } = await import('../src/services/onboarding/handles.js');
const { probeBusinessDiscovery } = await import('../src/services/onboarding/igDiscovery.js');
const { formatProbeReport, pickDiscoveryCreatorId } = await import('../src/services/onboarding/discoveryProbe.js');
const { scrubSecrets } = await import('../src/services/onboarding/sourceError.js');

const handle = normalizeInstagramHandle(args.handle);
if (!handle) stop(`"${String(args.handle).slice(0, 40)}" is not an Instagram username (letters, digits, "." and "_", at most 30).`);

// How many HTTP requests actually left, retries included: the claim is "one", so it is counted and not assumed.
let httpRequests = 0;
metaHttp.interceptors.request.use((config) => {
    httpRequests++;
    return config;
});

let token = '';
let igUserId = '';
const db = await connectReadOnly('autoreply-bd-probe').catch((err: unknown) => stop(`could not connect to ${target}: ${String((err as Error)?.message ?? err).slice(0, 160)}`));
try {
    const setting = (await db.query("SELECT value FROM app_settings WHERE key = 'onboarding.discovery_creator_id' AND is_secret IS NOT TRUE")).rows[0]?.value ?? null;
    const owner = (await db.query('SELECT id FROM creators ORDER BY created_at, id LIMIT 1')).rows[0]?.id ?? null;
    const creatorId = pickDiscoveryCreatorId(setting, owner);
    if (!creatorId) stop('The database has no tenant to discover as.');
    const row = (await db.query('SELECT instagram_page_id, page_access_token FROM creators WHERE id = $1', [creatorId])).rows[0];
    if (!row?.instagram_page_id || !row?.page_access_token) stop('That tenant has no Instagram account and token connected.');
    igUserId = String(row.instagram_page_id);
    token = decryptSecret(row.page_access_token);
} catch (err) {
    stop(`could not read the discovery account: ${scrubSecrets(String((err as Error)?.message ?? err), [token])}`);
} finally {
    await db.end().catch(() => undefined);
}

const result = await probeBusinessDiscovery({ token, igUserId }, handle!);
const lines = formatProbeReport({
    handle: handle!,
    graphVersion: API_VERSION,
    askingAccountIdLength: igUserId.length,
    result: { ...result, requests: httpRequests },
});
// Belt and braces: the report is built from names, counts and codes, but if the token somehow reached a line it is removed here.
console.log(lines.map((line) => (token ? line.split(token).join('[token]') : line)).join('\n'));
process.exitCode = result.ok && lines.some((l) => l.startsWith('VERDICT: works') || l.startsWith('VERDICT: partly')) ? 0 : 1;
