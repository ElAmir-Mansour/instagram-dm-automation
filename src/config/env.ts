/**
 * Environment Variable Validator
 * Fails fast at startup if required configuration is missing.
 */

const REQUIRED_VARS = [
    { key: 'DATABASE_URL', description: 'Supabase PostgreSQL connection string' },
    { key: 'META_VERIFY_TOKEN', description: 'Token for Meta webhook verification handshake' },
    { key: 'META_APP_SECRET', description: 'Facebook App Secret for signature validation' },
];

export function validateEnv(): void {
    const missing = REQUIRED_VARS.filter(v => !process.env[v.key]);

    if (missing.length > 0) {
        console.error('\n❌ Missing required environment variables:\n');
        for (const v of missing) {
            console.error(`   • ${v.key} — ${v.description}`);
        }
        console.error('\n   Copy .env.example to .env and fill in the values.\n');
        process.exit(1);
    }
}
