import pg from 'pg';

const connectionString = "postgresql://postgres.qgrpmahkhkmtqljpyhgm:%40Autoresponse%40123@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true";

const dmTemplate = `كل عام وأنت بخير بمناسبة العيد! 🎉✨ أهلاً بك {username}،
إليك "عيدية المبرمجين" الخاصة بك 🎁: 9 دورات برمجية وتطويرية مجانية 100% لفترة محدودة!

سجل الآن في الدورات التي تهمك قبل انتهاء صلاحية الكوبونات:

🤖 1. Agentic AI (الذكاء الاصطناعي العملي)
🔗 https://www.udemy.com/course/agentic-ai-arabic/?couponCode=ELAMIR-100

🐹 2. لغة GoLang (من الصفر إلى الاحتراف)
🔗 https://www.udemy.com/course/golang-course-in-arabic/?couponCode=ELAMIR-100

📱 3. لغة Swift (برمجة تطبيقات الآيفون)
🔗 https://www.udemy.com/course/swift-programming-language-in-arabic/?couponCode=ELAMIR-100

🐍 4. لغة بايثون Python للمبتدئين
🔗 https://www.udemy.com/course/python-for-beginners-in-arabic-/?couponCode=ELAMIR-100

[SPLIT]

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

async function run() {
    const pool = new pg.Pool({ connectionString });
    try {
        console.log('Connecting to database...');
        console.log('Updating Eid Bundle campaign template...');
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
