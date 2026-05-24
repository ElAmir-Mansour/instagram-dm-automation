import pg from 'pg';
import fs from 'fs';

const connectionString = "postgresql://postgres.qgrpmahkhkmtqljpyhgm:%40Autoresponse%40123@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true";
const csvPath = "/Users/elamir/Documents/copounscurrent.csv";

const COURSE_MAPPINGS = {
    "agentic ai": {
        triggerKeywords: "ذكاء, ذكاء اصطناعي, ايجنت, اجنت, ايجنتك, عميل ذكي, agentic, ai, agent, agents, agentic ai",
        dmTemplate: `أهلاً بك {username}! 👋\nسعيد جداً باهتمامك بدورة "Agentic AI: الدليل العملي لبناء ما تحتاجه بالذكاء الاصطناعي". 🤖🚀\n\nهذا هو رابط التسجيل المجاني المباشر الخاص بك (الكوبون مفعّل تلقائياً):\n🔗 {url}\n\n💡 الكوبون صالح لفترة محدودة ولـ 100 مقعد فقط. سارع بالتسجيل واستمتع بالرحلة التعليمية!\nإذا كان لديك أي استفسار، أنا هنا دائماً لمساعدتك. بالتوفيق! ✨`,
        publicReplies: "تم إرسال رابط الدورة والتفاصيل إلى الخاص بك يا {username}! تفقد رسائلك 📩🤖 | أهلاً بك {username}! شيك الخاص أرسلت لك كوبون التسجيل المجاني 🚀✨ | تم الإرسال على الخاص بنجاح! بالتوفيق في رحلتك التعليمية 🎓🌟"
    },
    "golang": {
        triggerKeywords: "جو, جولانج, كورس جو, لغة جو, go, golang, go lang, golang course",
        dmTemplate: `أهلاً بك {username}! 👋\nسعيد باهتمامك بتعلم لغة Go القوية مع دورة "GoLang Course: Learn Go in Arabic". 🐹🚀\n\nإليك رابط التسجيل المجاني المباشر الخاص بك (الكوبون مفعّل):\n🔗 {url}\n\n💡 الكوبون مخصص لـ 100 طالب وصالح لفترة محدودة. سجل الآن لتبدأ في بناء تطبيقات عالية الأداء!\nأراك داخل الدورة! 🎓✨`,
        publicReplies: "شيك الخاص يا {username}! أرسلت لك رابط الدورة المجاني 🐹📩 | تم إرسال كوبون لغة Go إلى الخاص بك بنجاح! بالتوفيق 🚀 | أهلاً {username}، تفقد صندوق الوارد للبدء فوراً! 🎓💡"
    },
    "swift": {
        triggerKeywords: "سويفت, ايفون, برمجة ايفون, تطبيقات ايفون, swift, swift programming, ios, swift arabic",
        dmTemplate: `أهلاً بك {username}! 👋\nخطوة رائعة لدخول عالم برمجة تطبيقات الآيفون والآيباد! 📱✨\nإليك رابط التسجيل المجاني المباشر في دورة "Swift Programming Language | in Arabic":\n🔗 {url}\n\n💡 الكوبون متاح لأول 100 مقعد فقط. لا تفوت الفرصة وابدأ الآن!\nبالتوفيق لك في مسيرتك البرمجية! 🚀`,
        publicReplies: "أهلاً بك {username}! تم إرسال رابط كورس سويفت على الخاص 📩📱 | شيك الخاص يا {username} لتجد كوبون الدورة المجاني! 🚀✨ | تم الإرسال بنجاح! بالتوفيق في برمجة تطبيقات iOS 🍏💡"
    },
    "css3": {
        triggerKeywords: "سي اس اس, css, css3, تصميم, تنسيق, ستايل, ويب, web design",
        dmTemplate: `أهلاً بك {username}! 👋\nهل أنت جاهز لتصميم مواقع ويب احترافية وجذابة؟ 🎨💻\nإليك رابط التسجيل المجاني المباشر في دورة "CSS3 For Beginners [In Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لفترة محدودة ومحدود بـ 100 عملية تسجيل.\nبالتوفيق وسأكون سعيداً برؤية تصميماتك! 🚀✨`,
        publicReplies: "تم إرسال كوبون كورس CSS3 إلى الخاص بك يا {username}! 🎨📩 | تفقد الخاص {username} لتجد رابط التسجيل المجاني! 💻✨ | أهلاً بك! تم الإرسال بنجاح، بالتوفيق في مسيرتك في تصميم الويب 🚀🌟"
    },
    "html5": {
        triggerKeywords: "اتش تي ام ال, html, html5, بناء موقع, ويب للمبتدئين, html beginners",
        dmTemplate: `أهلاً بك {username}! 👋\nأول خطوة في تطوير الويب تبدأ من هنا! 🌐💻\nإليك رابط التسجيل المجاني المباشر لدورة "HTML5 For Beginners [In Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لأول 100 طالب مسجل فقط. احجز مقعدك الآن!\nبالتوفيق لك في بدايتك الموفقة! 🚀✨`,
        publicReplies: "أرسلت لك رابط كورس HTML5 على الخاص يا {username}! 🌐📩 | تفقد رسائلك {username} للتسجيل في الدورة مجاناً! 🚀 | تم إرسال الكوبون بنجاح! بداية موفقة في تطوير الويب 💻✨"
    },
    "problem solving": {
        triggerKeywords: "حل مسائل, بروبلم, بروبلم سولفينج, سي شارب مسائل, logic, problem solving, c# problem",
        dmTemplate: `أهلاً بك {username}! 👋\nحل المسائل هو السلاح السري لكل مبرمج محترف! 🧠💻\nإليك رابط التسجيل المجاني في دورة "Problem Solving - with C# [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لـ 100 مقعد فقط. سجل الآن وابدأ بتدريب عقلك البرمجي!\nبالتوفيق لك! 🚀✨`,
        publicReplies: "تم إرسال رابط كورس حل المسائل على الخاص يا {username}! 🧠📩 | تفقد الخاص {username} لتجد الكوبون المجاني! 🚀✨ | تم الإرسال بنجاح! تمنياتي لك بالتوفيق في صقل مهاراتك المنطقية 💻🌟"
    },
    "java": {
        triggerKeywords: "جافا, كورس جافا, java, java for beginners, java course, java arabic",
        dmTemplate: `أهلاً بك {username}! 👋\nتعلم واحدة من أكثر لغات البرمجة طلباً واستخداماً في الشركات! ☕️🚀\nإليك رابط التسجيل المجاني المباشر في دورة "Java for Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون مخصص لـ 100 طالب وصالح لفترة محدودة. سجل الآن لتبني أساساً قوياً!\nبالتوفيق لك! 🎓✨`,
        publicReplies: "تم إرسال رابط كورس الجافا على الخاص يا {username}! ☕️📩 | شيك الخاص {username} للحصول على الكوبون المجاني 🚀 | تم الإرسال بنجاح! بالتوفيق في مسيرتك البرمجية 💻✨"
    },
    "python": {
        triggerKeywords: "بايثون, بايثون للمبتدئين, python, python arabic, python beginners, python course",
        dmTemplate: `أهلاً بك {username}! 👋\nالبداية الأسهل والأكثر متعة في عالم البرمجة هي لغة بايثون! 🐍🚀\nإليك رابط التسجيل المجاني لدورة "Python For Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لأول 100 طالب مسجل فقط. احجز مقعدك الآن!\nأتمنى لك رحلة ممتعة وموفقة! ✨`,
        publicReplies: "شيك الخاص يا {username}! أرسلت لك رابط كورس بايثون المجاني 🐍📩 | تم إرسال الكوبون إلى الخاص بك بنجاح! بالتوفيق 🚀 | أهلاً {username}، تفقد صندوق الوارد للبدء فوراً! 🎓💡"
    },
    "c#": {
        triggerKeywords: "سي شارب, كورس سي شارب, c#, csharp, c# beginners, csharp course",
        dmTemplate: `أهلاً بك {username}! 👋\nتعلم لغة C# القوية لبناء تطبيقات سطح المكتب، الألعاب، والمواقع! 🎮💻\nإليك رابط التسجيل المجاني المباشر لدورة "C# For Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لـ 100 مقعد فقط ولفترة محدودة. احرص على التسجيل الآن!\nبالتوفيق وسأكون سعيداً بمتابعة تقدمك! 🚀✨`,
        publicReplies: "تم إرسال رابط كورس سي شارب على الخاص يا {username}! 💻📩 | تفقد رسائل الخاص {username} لتجد الكوبون المجاني 🚀 | تم الإرسال بنجاح! بالتوفيق في مسيرتك البرمجية 🎓🌟"
    }
};

function parseCSV(text) {
    const lines = [];
    let row = [""];
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i+1];
        if (c === '"') {
            if (inQuotes && next === '"') {
                row[row.length - 1] += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === ',' && !inQuotes) {
            row.push("");
        } else if ((c === '\r' || c === '\n') && !inQuotes) {
            if (c === '\r' && next === '\n') i++;
            lines.push(row);
            row = [""];
        } else {
            row[row.length - 1] += c;
        }
    }
    if (row.length > 1 || row[0] !== "") {
        lines.push(row);
    }
    return lines;
}

async function run() {
    const pool = new pg.Pool({ connectionString });
    try {
        console.log('Connecting to database...');
        const creatorRes = await pool.query('SELECT id FROM creators WHERE is_active = true LIMIT 1');
        if (creatorRes.rows.length === 0) {
            console.error('Error: No active creator found in the database. Please configure a creator first.');
            process.exit(1);
        }
        const creatorId = creatorRes.rows[0].id;
        console.log(`Found active creator: ${creatorId}`);

        console.log(`Reading CSV from: ${csvPath}`);
        const csvContent = fs.readFileSync(csvPath, 'utf8');
        const rows = parseCSV(csvContent);
        if (rows.length <= 1) {
            console.error('Error: Empty or invalid CSV file.');
            process.exit(1);
        }

        const courseMap = {};
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row.length < 10) continue;
            const courseId = row[0].trim();
            if (!courseId) continue;
            
            const name = row[1]?.trim() || '';
            const couponType = row[2]?.trim() || '';
            const redemptions = parseInt(row[3]) || 0;
            const code = row[4]?.trim() || '';
            const url = row[9]?.trim() || '';
            
            if (!courseMap[courseId] || redemptions > courseMap[courseId].redemptions) {
                courseMap[courseId] = {
                    id: courseId,
                    name,
                    couponType,
                    redemptions,
                    code,
                    url
                };
            }
        }

        const uniqueCourses = Object.values(courseMap);
        console.log(`Found ${uniqueCourses.length} unique courses.`);

        for (const course of uniqueCourses) {
            const nameLower = course.name.toLowerCase();
            let mapping = null;
            for (const key in COURSE_MAPPINGS) {
                if (nameLower.includes(key)) {
                    mapping = COURSE_MAPPINGS[key];
                    break;
                }
            }

            let triggerKeywords = "";
            let dmTemplate = "";
            let publicReplies = "";

            if (mapping) {
                triggerKeywords = mapping.triggerKeywords;
                dmTemplate = mapping.dmTemplate.replace(/{url}/g, course.url);
                publicReplies = mapping.publicReplies;
            } else {
                const cleanName = course.name.split('[')[0].split('|')[0].split('-')[0].trim();
                triggerKeywords = `${cleanName.split(' ')[0].toLowerCase()}, كورس, كوبون, رابط`;
                dmTemplate = `أهلاً بك {username}! 👋\nإليك رابط التسجيل المجاني لكورس "${cleanName}":\n🔗 ${course.url}\n\nسجل الآن قبل نفاد الكوبون! ✨`;
                publicReplies = `تم إرسال الرابط والتفاصيل على الخاص يا {username}! 📩 | تفقد الخاص {username} للحصول على كوبون الدورة! 🚀`;
            }

            console.log(`Inserting campaign for: "${course.name}" (Code: ${course.code})`);
            const query = `
                INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active)
                VALUES ($1, $2, $3, $4, NULL, TRUE)
                RETURNING id;
            `;
            const res = await pool.query(query, [creatorId, triggerKeywords, dmTemplate, publicReplies]);
            console.log(`Campaign created successfully! ID: ${res.rows[0].id}`);
        }

        console.log('All campaigns inserted successfully!');
    } catch (err) {
        console.error('Database seeding error:', err);
    } finally {
        await pool.end();
    }
}

run();
