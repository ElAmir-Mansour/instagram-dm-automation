/**
 * Environment Variable Validator
 * Fails fast at startup if required configuration is missing.
 */

const REQUIRED_VARS = [
    { key: 'DATABASE_URL', description: 'Supabase PostgreSQL connection string' },
    { key: 'META_VERIFY_TOKEN', description: 'Token for Meta webhook verification handshake' },
    { key: 'META_APP_SECRET', description: 'Facebook App Secret for signature validation' },
    { key: 'GEMINI_API_KEY', description: 'Google Gemini API Key for AI direct messaging response generation' },
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

    const dashboardPassword = process.env.DASHBOARD_PASSWORD;
    if (!dashboardPassword || dashboardPassword === 'admin') {
        console.warn('\n⚠️  SECURITY WARNING: DASHBOARD_PASSWORD is not set or is using the default "admin" value.');
        console.warn('   Please configure a strong password in your production environment variables.\n');
    }
}
