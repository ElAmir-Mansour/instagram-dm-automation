#!/usr/bin/env node

/**
 * Token Exchange Tool
 * 
 * Converts a short-lived token from the Graph API Explorer
 * into a PERMANENT Page Access Token that never expires.
 * 
 * Usage:
 *   node --env-file=.env scripts/exchange-token.mjs <SHORT_LIVED_TOKEN>
 * 
 * Requires .env file with META_APP_SECRET set.
 */

const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const API_VERSION = 'v21.0';

if (!APP_SECRET) {
    console.error('\n❌ META_APP_SECRET not found. Run with: node --env-file=.env scripts/exchange-token.mjs <TOKEN>\n');
    process.exit(1);
}
if (!APP_ID) {
    console.error('\n❌ META_APP_ID not found in .env. Add it to your .env file.\n');
    process.exit(1);
}

const shortLivedToken = process.argv[2];
if (!shortLivedToken) {
    console.error('\n❌ Usage: node --env-file=.env scripts/exchange-token.mjs <SHORT_LIVED_TOKEN>\n');
    process.exit(1);
}

async function main() {
    console.log('\n🔄 Step 1: Exchanging short-lived token → long-lived User token...');
    
    const exchangeUrl = `https://graph.facebook.com/${API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${shortLivedToken}`;
    const exchangeRes = await fetch(exchangeUrl);
    const exchangeData = await exchangeRes.json();
    
    if (exchangeData.error) {
        console.error('❌ Exchange failed:', exchangeData.error.message);
        process.exit(1);
    }
    
    const longLivedUserToken = exchangeData.access_token;
    console.log('✅ Got long-lived User token (60 days)');

    console.log('\n🔄 Step 2: Fetching Page Access Tokens...');
    const pagesUrl = `https://graph.facebook.com/${API_VERSION}/me/accounts?access_token=${longLivedUserToken}`;
    const pagesRes = await fetch(pagesUrl);
    const pagesData = await pagesRes.json();
    
    if (pagesData.error) {
        console.error('❌ Pages fetch failed:', pagesData.error.message);
        process.exit(1);
    }
    
    if (!pagesData.data || pagesData.data.length === 0) {
        console.error('❌ No pages found for this user.');
        process.exit(1);
    }
    
    console.log(`\n📋 Found ${pagesData.data.length} page(s):\n`);
    
    for (const page of pagesData.data) {
        const pageToken = page.access_token;
        const debugUrl = `https://graph.facebook.com/${API_VERSION}/debug_token?input_token=${pageToken}&access_token=${pageToken}`;
        const debugRes = await fetch(debugUrl);
        const debugData = await debugRes.json();
        const tokenData = debugData.data || {};
        const expiresAt = tokenData.expires_at;
        const expiryText = expiresAt === 0 ? '🟢 NEVER EXPIRES (Permanent!)' : `⚠️  Expires: ${new Date(expiresAt * 1000).toISOString()}`;
        
        console.log(`   Page: ${page.name} (ID: ${page.id})`);
        console.log(`   Expiry: ${expiryText}`);
        console.log(`   Scopes: ${(tokenData.scopes || []).join(', ')}`);
        console.log(`\n   🔑 PAGE ACCESS TOKEN:\n   ${pageToken}\n`);
    }
}

main().catch(err => {
    console.error('❌ Unexpected error:', err.message);
    process.exit(1);
});
