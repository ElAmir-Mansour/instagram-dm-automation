/**
 * Environment Variable Validator
 * Fails fast at startup if required configuration is missing.
 *
 * The one place `console.error` is used deliberately rather than `src/utils/log.ts`. This
 * runs before anything is serving, there is no request to correlate against, and its actual
 * audience is a person reading a terminal after `npm run start:dev` — a multi-line checklist
 * of what to put in `.env` is the right output there, and a JSON line is not. The structured
 * counterpart is `startup.validation_failed`, emitted by the caller in src/index.ts.
 */

const REQUIRED_VARS = [
    { key: 'DATABASE_URL', description: 'Supabase PostgreSQL connection string' },
    { key: 'META_VERIFY_TOKEN', description: 'Token for Meta webhook verification handshake' },
    { key: 'META_APP_SECRET', description: 'Facebook App Secret for signature validation' },
    // The Instagram-Login app is a separate Meta app that signs with its own secret. Without
    // this the app 403s every `object: "instagram"` webhook, which looks exactly like no
    // events arriving at all.
    { key: 'INSTAGRAM_APP_SECRET', description: 'Instagram App Secret — the second webhook signing secret' },
    { key: 'GEMINI_API_KEY', description: 'Google Gemini API Key for AI direct messaging response generation' },
    { key: 'DASHBOARD_PASSWORD', description: 'Dashboard login password — also the session-token signing key' },
    { key: 'CRON_SECRET', description: 'Bearer secret guarding /api/cron/publish' },
];

/** The fallback this app used to ship with. It is in the public repo's history, so it is a published password. */
const PUBLISHED_DEFAULT_PASSWORD = 'admin';

export function validateEnv(): void {
    const missing = REQUIRED_VARS.filter(v => !process.env[v.key]);

    if (missing.length > 0) {
        console.error('\n❌ Missing required environment variables:\n');
        for (const v of missing) {
            console.error(`   • ${v.key} — ${v.description}`);
        }
        console.error('\n   Copy .env.example to .env and fill in the values.\n');

        // Throw rather than process.exit(1): on Vercel this module is evaluated inside the
        // request handler, so exiting kills the invocation with no HTTP response at all —
        // every request becomes an opaque 500 with nothing to read. The caller decides what
        // to do with the error; at least it can be logged and surfaced.
        throw new Error(`Missing required environment variables: ${missing.map(v => v.key).join(', ')}`);
    }

    if (process.env.DASHBOARD_PASSWORD === PUBLISHED_DEFAULT_PASSWORD) {
        console.error('\n❌ DASHBOARD_PASSWORD is set to the old default "admin".');
        console.error('   That value is committed in a public repository — treat it as compromised.\n');
        throw new Error('DASHBOARD_PASSWORD must not be the published default value.');
    }
}
