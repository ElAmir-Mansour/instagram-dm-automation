-- SQL Migration v2: Conversational Inbox & AI Sales Agent

-- 1. Create Conversations Table
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    instagram_user_id VARCHAR(255) NOT NULL,
    username VARCHAR(255),
    status VARCHAR(50) DEFAULT 'active', -- active, qualified, converted, paused
    is_bot_active BOOLEAN DEFAULT TRUE,  -- toggle AI auto-reply for this specific thread
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_creator_user UNIQUE (creator_id, instagram_user_id)
);

-- 2. Create Messages Table
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    message_type VARCHAR(50) DEFAULT 'text', -- text, quick_reply, carousel
    text TEXT NOT NULL,
    payload TEXT, -- quick reply payload or postback payload clicked
    raw_payload JSONB, -- store full Meta payload
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create AI Agents Table
CREATE TABLE IF NOT EXISTS ai_agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE UNIQUE,
    is_active BOOLEAN DEFAULT TRUE,
    system_prompt TEXT NOT NULL,
    knowledge_base TEXT NOT NULL,
    model VARCHAR(100) DEFAULT 'gemini-2.5-flash',
    temperature FLOAT DEFAULT 0.7,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(creator_id, instagram_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at ASC);

-- 4. Seed Default AI Agent Configuration for existing creators
INSERT INTO ai_agents (creator_id, system_prompt, knowledge_base, model, temperature)
SELECT 
    id as creator_id,
    'أنت مساعد ذكي ولطيف للاستاذ الأمير منصور (ElAmir Mansour)، مهندس البرمجيات وصانع المحتوى التعليمي. مهمتك هي الإجابة على استفسارات الطلاب والمتابعين باللغة العربية بأسلوب ودود وتشجيعهم على التعلم. استخدم المعلومات المتاحة في قاعدة المعرفة لتقديم تفاصيل عن الكورسات، أو توجيههم لقناته على اليوتيوب وحسابه على لينكد إن. عند الاقتضاء، قم بعرض الكورسات المناسبة في صورة كروت أو خيارات سريعة لمساعدتهم على الضغط والوصول مباشرة.' as system_prompt,
    'كورسات اليوديمي المتاحة:
1. كورس أساسيات البرمجة ولغة C# [باللغة العربية]: يغطي المفاهيم الأساسية، البرمجة كائنية التوجه (OOP)، وهياكل البيانات والبرمجة للمبتدئين. رابط الكورس على الملف الشخصي: udemy.com/user/elamir-mahmoud-mansour
2. كورس هياكل البيانات والخوارزميات [باللغة العربية]: يغطي المصفوفات، القوائم، المكدس، الطابور، الأشجار، خوارزميات البحث والترتيب، وتعقيد الوقت (Big O). الرابط: udemy.com/user/elamir-mahmoud-mansour
3. معسكر حل المشكلات البرمجية (Problem Solving) [باللغة العربية]: يحتوي على تدريبات مكثفة على حل التحديات البرمجية لإعداد الطلاب للمقابلات الفنية والمسابقات. الرابط: udemy.com/user/elamir-mahmoud-mansour

روابط التواصل المهني والاجتماعي:
- حساب لينكد إن: linkedin.com/in/elamir-mansour
- قناة اليوتيوب: youtube.com/@ElAmir (تحتوي على شروحات برمجية مجانية في تطوير تطبيقات iOS ولغة سويفت وأدوات الذكاء الاصطناعي)' as knowledge_base,
    'gemini-2.5-flash' as model,
    0.7 as temperature
FROM creators
ON CONFLICT (creator_id) DO NOTHING;
