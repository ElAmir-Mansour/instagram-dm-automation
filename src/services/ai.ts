import axios from 'axios';
import { pool } from '../config/db.js';

interface MessageRow {
    direction: 'inbound' | 'outbound';
    text: string;
}

export interface AiResponse {
    message_type: 'text' | 'quick_reply' | 'carousel';
    text: string;
    quick_replies?: Array<{ title: string; payload: string }>;
    carousel_elements?: Array<{
        title: string;
        subtitle?: string;
        image_url?: string;
        buttons?: Array<{
            type: 'web_url' | 'postback';
            title: string;
            url?: string;
            payload?: string;
        }>;
    }>;
}

/**
 * Interface to match Google Gemini's REST API payload structures.
 */
const RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
        message_type: {
            type: "STRING",
            enum: ["text", "quick_reply", "carousel"]
        },
        text: {
            type: "STRING",
            description: "Conversational text response or prompt accompanying the buttons/carousel. Must be written in Arabic if appropriate."
        },
        quick_replies: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    title: { type: "STRING", description: "Label of the button. MAX 20 characters." },
                    payload: { type: "STRING", description: "Programmatic payload returned on click, e.g., GO_TO_COURSE_1." }
                },
                required: ["title", "payload"]
            },
            description: "A list of quick action buttons (maximum 13)."
        },
        carousel_elements: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    title: { type: "STRING", description: "Title of the carousel card. MAX 80 characters." },
                    subtitle: { type: "STRING", description: "Subtitle of the carousel card. MAX 80 characters." },
                    image_url: { type: "STRING", description: "Public URL of the image to display." },
                    buttons: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                type: { type: "STRING", enum: ["web_url", "postback"] },
                                title: { type: "STRING", description: "Button text. MAX 20 characters." },
                                url: { type: "STRING", description: "URL for web_url buttons." },
                                payload: { type: "STRING", description: "Payload for postback buttons." }
                            },
                            required: ["type", "title"]
                        }
                    }
                },
                required: ["title"]
            },
            description: "Swipeable cards. Specify between 2 and 10 cards."
        }
    },
    required: ["message_type", "text"]
};

/**
 * Truncates strings to respect Meta's strict character constraints.
 */
function enforceMetaConstraints(response: AiResponse): AiResponse {
    if (response.text) {
        response.text = response.text.substring(0, 1000);
    }
    if (response.quick_replies) {
        response.quick_replies = response.quick_replies.slice(0, 13).map(qr => ({
            title: qr.title.substring(0, 20),
            payload: qr.payload.substring(0, 1000)
        }));
    }
    if (response.carousel_elements) {
        response.carousel_elements = response.carousel_elements.slice(0, 10).map(elem => {
            const cleanElem = { ...elem };
            cleanElem.title = elem.title.substring(0, 80);
            if (elem.subtitle) {
                cleanElem.subtitle = elem.subtitle.substring(0, 80);
            }
            if (elem.buttons) {
                cleanElem.buttons = elem.buttons.slice(0, 3).map(btn => {
                    const cleanBtn = { ...btn };
                    cleanBtn.title = btn.title.substring(0, 20);
                    if (btn.payload) {
                        cleanBtn.payload = btn.payload.substring(0, 1000);
                    }
                    return cleanBtn;
                });
            }
            return cleanElem;
        });
    }
    return response;
}

/**
 * Queries Gemini API using the conversation history and configuration details.
 */
export async function generateAiResponse(
    conversationId: string,
    userMessage: string,
    creatorId: string
): Promise<AiResponse> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('Missing GEMINI_API_KEY environment variable.');
    }

    // 1. Fetch AI Agent Settings
    const agentRes = await pool.query(
        'SELECT * FROM ai_agents WHERE creator_id = $1 AND is_active = true',
        [creatorId]
    );

    const agent = agentRes.rows[0] || {
        system_prompt: 'أنت مساعد ذكي يجيب على استفسارات المتابعين باللغة العربية.',
        knowledge_base: '',
        model: 'gemini-2.5-flash',
        temperature: 0.7
    };

    // 2. Fetch Conversation History (last 15 messages)
    const historyRes = await pool.query(
        `SELECT direction, text 
         FROM messages 
         WHERE conversation_id = $1 
         ORDER BY created_at DESC 
         LIMIT 15`,
        [conversationId]
    );

    // Order chronological
    const history: MessageRow[] = historyRes.rows.reverse();

    // 3. Format Contents for Gemini REST API
    const contents: any[] = [];
    for (const msg of history) {
        contents.push({
            role: msg.direction === 'inbound' ? 'user' : 'model',
            parts: [{ text: msg.text }]
        });
    }

    // Append the current message if it is not already logged
    const lastMsg = history[history.length - 1];
    if (!lastMsg || lastMsg.text !== userMessage || lastMsg.direction !== 'inbound') {
        contents.push({
            role: 'user',
            parts: [{ text: userMessage }]
        });
    }

    // 4. Construct System Instruction
    const systemInstructionText = `${agent.system_prompt}\n\n=== قاعدة المعرفة المتاحة لديك (Knowledge Base) ===\n${agent.knowledge_base}\n\n=== تعليمات إضافية مهمة ===\n1. يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللغة العربية الفصحى أو بلهجة سهلة ومناسبة.\n2. إذا طلب المستخدم كورسات أو معلومات تواصل، استخدم خيار "quick_reply" أو "carousel" لتقديمها بشكل تفاعلي ومنظم بدلاً من مجرد سرد روابط نصية.\n3. التزم تماماً بحدود الحروف: عناوين الأزرار والـ quick replies لا تتجاوز 20 حرفاً. عناوين الكروت لا تتجاوز 80 حرفاً.`;

    const modelName = agent.model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    console.log(`🤖 Querying Gemini model (${modelName})...`);

    try {
        const payload = {
            contents,
            systemInstruction: {
                parts: [{ text: systemInstructionText }]
            },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: RESPONSE_SCHEMA,
                temperature: agent.temperature || 0.7
            }
        };

        const response = await axios.post(url, payload);
        const rawJsonText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawJsonText) {
            console.warn('⚠️ Empty response from Gemini API.');
            return {
                message_type: 'text',
                text: 'عذراً، لم أستطع معالجة الرد حالياً. يرجى المحاولة مرة أخرى لاحقاً.'
            };
        }

        const parsedResponse: AiResponse = JSON.parse(rawJsonText);
        return enforceMetaConstraints(parsedResponse);

    } catch (err: any) {
        console.error('❌ Gemini API Error:', err.response?.data || err.message);
        
        // Fallback response in case of API block or JSON syntax issues
        return {
            message_type: 'text',
            text: 'أهلاً بك! لم أستطع معالجة طلبك كاستجابة مهيكلة، ولكن تفضل بزيارة الكورسات على الملف الشخصي: udemy.com/user/elamir-mahmoud-mansour'
        };
    }
}
