import pg from 'pg';

const connectionString = "postgresql://postgres.qgrpmahkhkmtqljpyhgm:%40Autoresponse%40123@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true";

const dmTemplate = `كل عام وأنت بخير بمناسبة العيد يا {username}! 🎉✨

تفضل "عيدية المبرمجين" الخاصة بك 🎁: 9 دورات برمجية وتطويرية كاملة مجاناً 100% لفترة محدودة!

سجل الآن في الدورات التي تهمك مباشرة بضغطة زر واحدة من الرابط التالي:
🔗 https://msg-response-auto.vercel.app/eid

💡 الكوبونات محدودة لـ 100 مقعد فقط لكل كورس، سارع بالتسجيل قبل النفاد! بالتوفيق! 🚀`;

async function run() {
    const pool = new pg.Pool({ connectionString });
    try {
        console.log('Connecting to database...');
        console.log('Updating Eid Bundle campaign template to short URL style...');
        const query = `
            UPDATE campaigns 
            SET dm_template = $1 
            WHERE trigger_keyword LIKE '%عيدية%' 
            RETURNING id;
        `;
        const res = await pool.query(query, [dmTemplate]);
        if (res.rows.length > 0) {
            console.log(`Successfully updated ${res.rows.length} Eid campaigns!`);
        } else {
            console.error('Error: Eid campaign not found.');
        }
    } catch (err) {
        console.error('Database update error:', err);
    } finally {
        await pool.end();
    }
}

run();
