import pg from 'pg';

const connectionString = "postgresql://postgres.qgrpmahkhkmtqljpyhgm:%40Autoresponse%40123@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true";

const triggerKeywords = "عيدية, عيدية العيد, عيد, عيدية الكورسات, عيدية الكورس, عيديته, عيدية مبرمج, eid, eidia, gift";

const dmTemplate = `كل عام وأنت بخير بمناسبة العيد! 🎉✨ أهلاً بك {username}،
إليك "عيدية المبرمجين" الخاصة بك 🎁: 9 دورات برمجية وتطويرية مجانية 100% لفترة محدودة!

سجل الآن في الدورات التي تهمك قبل انتهاء صلاحية الكوبونات (مفعّلة تلقائياً عبر الروابط):

🤖 1. Agentic AI (الذكاء الاصطناعي العملي)
🔗 https://www.udemy.com/course/agentic-ai-arabic/?couponCode=ELAMIR-100

🐹 2. لغة GoLang (من الصفر إلى الاحتراف)
🔗 https://www.udemy.com/course/golang-course-in-arabic/?couponCode=ELAMIR-100

📱 3. لغة Swift (برمجة تطبيقات الآيفون)
🔗 https://www.udemy.com/course/swift-programming-language-in-arabic/?couponCode=ELAMIR-100

🐍 4. لغة بايثون Python للمبتدئين
🔗 https://www.udemy.com/course/python-for-beginners-in-arabic-/?couponCode=ELAMIR-100

🧠 5. حل المشكلات البرمجية Problem Solving بـ C#
🔗 https://www.udemy.com/course/problem-solving-25-problems-solved-with-c-in-arabic/?couponCode=ELAMIR-100

🎮 6. لغة C# للمبتدئين
🔗 https://www.udemy.com/course/csharpin5hours/?couponCode=ELAMIR-100

☕ 7. لغة Java للمبتدئين
🔗 https://www.udemy.com/course/java-for-beginners-in-arabic/?couponCode=ELAMIR-100

🌐 8. HTML5 للمبتدئين (تطوير الويب)
🔗 https://www.udemy.com/course/html5-full-course-with-2-projects-in-arabic/?couponCode=ELAMIR-100

🎨 9. CSS3 للمبتدئين (تصميم المواقع)
🔗 https://www.udemy.com/course/css3-full-course-with-project-in-arabic/?couponCode=ELAMIR-100

💡 الكوبونات محدودة بـ 100 مقعد لكل كورس، سارع بحجز مقعدك وابدأ التعلم الآن! بالتوفيق! 🚀`;

const publicReplies = "وأنت بخير وصحة وسلامة يا {username}! 🎉 أرسلت لك عيدية الكورسات التسعة على الخاص 🎁📩 | كل عام وأنت بخير {username}! شيك الخاص تفضل روابط الـ 9 كورسات مجاناً! 🚀✨ | تم إرسال عيدية الكورسات كاملة على الخاص بنجاح! عيدك مبارك 🎓🌟";

async function run() {
    const pool = new pg.Pool({ connectionString });
    try {
        console.log('Connecting to database...');
        const creatorRes = await pool.query('SELECT id FROM creators WHERE is_active = true LIMIT 1');
        if (creatorRes.rows.length === 0) {
            console.error('Error: No active creator found.');
            process.exit(1);
        }
        const creatorId = creatorRes.rows[0].id;

        console.log('Inserting Eid Bundle campaign...');
        const query = `
            INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active)
            VALUES ($1, $2, $3, $4, NULL, TRUE)
            RETURNING id;
        `;
        const res = await pool.query(query, [creatorId, triggerKeywords, dmTemplate, publicReplies]);
        console.log(`Eid Bundle Campaign created successfully! ID: ${res.rows[0].id}`);
    } catch (err) {
        console.error('Database seeding error:', err);
    } finally {
        await pool.end();
    }
}

run();
