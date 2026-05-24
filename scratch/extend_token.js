import pg from 'pg';
import axios from 'axios';

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function extendTokenInDb() {
    try {
        console.log('Fetching active creator from DB...');
        const result = await pool.query('SELECT id FROM creators WHERE is_active = true LIMIT 1');
        
        if (result.rows.length === 0) {
            console.log('No active creator found.');
            process.exit(0);
        }

        const creatorId = result.rows[0].id;
        
        // Use the hardcoded token provided by the user
        const token = "EAAMDC1xPrj8BRmP5yOmTuItdwSOzyVo6zTptIMTDRnD30ZAzFkjyvBvGZBMVHriBa1ztctBWvZCijZAo8zOVXASLqxmP9ATJ77yk64eCPIaZCstFcbbyAGiYdMnE8g8ZB1SDq5vRuerYCs67Ns02zGKOiwIBMpmUFC05vvDixLJ6zIM8x1KlNSZAuwuIKlSpaFXUHMBMtym8E31uKYztm5M8CLWZAjPKaaTxcaO53pHURgZDZD";
        
        console.log('Using hardcoded token. Attempting to extend...');
        const appId = process.env.META_APP_ID;
        const appSecret = process.env.META_APP_SECRET;

        if (!appId || !appSecret) {
            console.log('Missing META_APP_ID or META_APP_SECRET in .env');
            process.exit(1);
        }

        const extendRes = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
            params: {
                grant_type: 'fb_exchange_token',
                client_id: appId,
                client_secret: appSecret,
                fb_exchange_token: token
            }
        });

        if (extendRes.data && extendRes.data.access_token) {
            const newToken = extendRes.data.access_token;
            console.log('Successfully extended token!');
            
            await pool.query('UPDATE creators SET page_access_token = $1 WHERE id = $2', [newToken, creatorId]);
            console.log('Saved new never-expiring token to database.');
        } else {
            console.log('Extension response did not contain an access_token:', extendRes.data);
        }
        
    } catch (err) {
        console.error('Error during extension:', err.response?.data || err.message);
    } finally {
        await pool.end();
    }
}

extendTokenInDb();
