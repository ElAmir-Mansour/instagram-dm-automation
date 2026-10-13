/**
 * A small creator (an Arabic perfume shop), the sources a draft would be made from, and honest model answers for
 * it: every quote is copied from a source. The tests change one thing at a time to make them dishonest. Not a
 * test file. The shop and its captions are invented.
 */
import { prepareSources, type DraftSource } from '../fence.js';
import { computeSignals, type SampleCandidate } from '../draftSignals.js';

const RAW_SOURCES: DraftSource[] = [
    { id: 'bio', kind: 'ig_bio', text: 'متجر نور للعطور 🌹\nعطور شرقية وغربية أصلية\nشحن لكل مدن المملكة\nwww.noor-perfumes.example\nواتساب: +966 50 123 4567' },
    { id: 'p1', kind: 'ig_caption', text: 'وش رايك بعود الليل؟ الحين عليه خصم ٢٠٪ وسعره ١٨٩ ريال فقط، والله زين.\nاكتب "عود" وابغى ارسل لك التفاصيل 📩' },
    { id: 'p2', kind: 'ig_caption', text: 'كذا تعرف العطر المناسب لك: جرب على جلدك وانتظر ساعة. ترى الريحة تتغير مع الوقت، وواجد ناس ما يدرون.' },
    { id: 'p3', kind: 'ig_caption', text: 'بخور الشام جاي مرّة طيب هالمرة! وايد ناس طلبوه هالأسبوع.\nعلّق "بخور" يوصلك الرابط 👇' },
    { id: 'p4', kind: 'ig_caption', text: 'ودك تعرف كيف تحفظ عطرك؟ بعيد عن الشمس والحرارة، زين؟ هذي أسهل طريقة.' },
    { id: 'p5', kind: 'ig_caption', text: 'تبي هدية؟ دحين عندنا علب هدايا جاهزة، والحين أحسن وقت تطلب قبل المناسبات.' },
    {
        id: 'site1',
        kind: 'site_page',
        text: 'متجر نور للعطور\nسياسة الاسترجاع: يمكنك استرجاع المنتج خلال ١٤ يوماً من الاستلام.\nالتوصيل خلال يومين داخل الرياض.\nhttps://noor-perfumes.example/pages/returns\nhttps://noor-perfumes.example/products/oud-alleil\nللتواصل: hello@noor-perfumes.example',
    },
];

/** The sources as a draft stores them: cleaned and in order. */
export const STORE_SOURCES: DraftSource[] = prepareSources(RAW_SOURCES);

export const STORE_CANDIDATES: SampleCandidate[] = [
    { id: 'p1', media_type: 'REELS', engagement_percentile: 90, chars: 120 },
    { id: 'p2', media_type: 'IMAGE', engagement_percentile: 40, chars: 100 },
    { id: 'p3', media_type: 'REELS', engagement_percentile: 75, chars: 110 },
    { id: 'p4', media_type: 'IMAGE', engagement_percentile: 20, chars: 90 },
    { id: 'p5', media_type: 'CAROUSEL_ALBUM', engagement_percentile: null, chars: 95 },
];

export const storeSignals = (over: Partial<Parameters<typeof computeSignals>[0]> = {}) =>
    computeSignals({ sources: STORE_SOURCES, candidates: STORE_CANDIDATES, keywordsInUse: ['كورس'], handle: 'noor.perfumes', siteHost: 'noor-perfumes.example', ...over });

const prov = (source: string, evidence: string, confidence: 'high' | 'medium' | 'low' = 'high') => ({ source, evidence, confidence });
const field = <T>(value: T, source = 'inferred', evidence = '', confidence: 'high' | 'medium' | 'low' = 'low') => ({ value, ...prov(source, evidence, confidence) });

/** An honest answer of the voice call. A fresh object each time: tests mutate it. */
export function okVoice(): Record<string, any> {
    return {
        identity: {
            display_name: field('متجر نور للعطور', 'bio', 'متجر نور للعطور'),
            kind: field('shop', 'bio', 'عطور شرقية وغربية أصلية', 'medium'),
            role: field('perfume shop', 'inferred', '', 'medium'),
            niche: field('عطور شرقية وغربية أصلية', 'bio', 'عطور شرقية وغربية أصلية', 'high'),
            country: field('SA', 'bio', 'شحن لكل مدن المملكة', 'medium'),
        },
        language: {
            primary: field('ar', 'p1', 'وش رايك بعود الليل؟'),
            second: field('none'),
            register: field('gulf', 'p2', 'ترى الريحة تتغير', 'medium'),
            register_note: 'خليجي مع فصحى في العناوين',
            digits: field('arabic-indic', 'p1', '٢٠٪'),
        },
        audience: {
            who: field('زبائن من السعودية يبحثون عن عطور أصلية وهدايا', 'bio', 'شحن لكل مدن المملكة', 'medium'),
            level: field('mixed'),
            pains: [field('لا يعرفون العطر المناسب لهم', 'p2', 'كذا تعرف العطر المناسب لك', 'medium'), field('لا يعرفون كيف يحفظون العطر', 'p4', 'كيف تحفظ عطرك')],
            goals: [field('هدية جاهزة قبل المناسبات', 'p5', 'علب هدايا جاهزة', 'medium')],
        },
        voice: {
            tone_words: [field('ودود', 'inferred', '', 'medium'), field('بسيط')],
            guide: field('جمل قصيرة ولهجة خليجية قريبة، يبدأ بسؤال ثم يعطي نصيحة عملية وينتهي بدعوة للتعليق.', 'inferred', '', 'medium'),
            emoji: field('light'),
            address: field('masc'),
            words_used: ['زين', 'الحين', 'ودك', 'مرّة', 'كلمة_ما_كتبها_أبداً'],
            samples: [
                { post_id: 'p1', why: 'سؤال ثم عرض' },
                { post_id: 'p3', why: 'حماس وطلب تعليق' },
                { post_id: 'p2', why: 'نصيحة عملية' },
            ],
        },
        pillars: [
            { name: 'عود وبخور', description: 'منتجات العود والبخور', post_ids: ['p1', 'p3'], ...prov('p1', 'بعود الليل') },
            { name: 'نصائح العطور', description: 'كيف تختار وتحفظ العطر', post_ids: ['p2', 'p4'], ...prov('p4', 'كيف تحفظ عطرك') },
            { name: 'هدايا', description: 'علب الهدايا', post_ids: ['p5'], ...prov('p5', 'علب هدايا جاهزة', 'medium') },
        ],
        domain: field('general', 'inferred', '', 'medium'),
    };
}

/** An honest answer of the business call. */
export function okBusiness(): Record<string, any> {
    return {
        offers: [
            {
                name: 'عود الليل', kind: 'product', url: 'https://noor-perfumes.example/products/oud-alleil', price: '189 ريال',
                bullets: ['خصم ٢٠٪ هذا الأسبوع'], facts: ['عطر عود'], keyword: 'عود', ...prov('p1', 'وسعره ١٨٩ ريال فقط'),
            },
            { name: 'بخور الشام', kind: 'product', url: '', price: '', bullets: [], facts: [], keyword: 'بخور', ...prov('p3', 'بخور الشام جاي') },
        ],
        dm_faq: [
            { question: 'كم مدة الاسترجاع؟', answer: 'يمكنك استرجاع المنتج خلال ١٤ يوماً من الاستلام.', needs_input: false, ...prov('site1', 'خلال ١٤ يوماً من الاستلام') },
            { question: 'كم مدة التوصيل؟', answer: 'التوصيل خلال يومين داخل الرياض.', needs_input: false, ...prov('site1', 'التوصيل خلال يومين داخل الرياض') },
            { question: 'هل تشحنون خارج السعودية؟', answer: '', needs_input: true, ...prov('inferred', '', 'low') },
        ],
        comment_keywords: [
            { keyword: 'عود', offer: 'عود الليل', already_used: false, ...prov('p1', 'اكتب "عود"') },
            { keyword: 'بخور', offer: 'بخور الشام', already_used: false, ...prov('p3', 'علّق "بخور"') },
        ],
        contact: {
            whatsapp: field('+966 50 123 4567', 'bio', 'واتساب: +966 50 123 4567'),
            email: field('hello@noor-perfumes.example', 'site1', 'hello@noor-perfumes.example'),
        },
        handoff_hint: field('عند طلب خصم خاص أو شكوى', 'inferred', '', 'low'),
    };
}

// ─── A checker for the schema subset the draft schemas use ───────────────────────────────────

type Node = Record<string, any>;

/** Problems with `value` against a JSON Schema in the subset `toJsonSchema` produces; empty when it fits. */
export function schemaProblems(value: unknown, schema: Node, path = '$'): string[] {
    const out: string[] = [];
    const type = schema.type;
    if (type === 'object') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} is not an object`];
        const obj = value as Node;
        for (const key of schema.required ?? []) if (!(key in obj)) out.push(`${path}.${key} is missing`);
        for (const key of Object.keys(obj)) {
            if (!(key in (schema.properties ?? {}))) {
                if (schema.additionalProperties === false) out.push(`${path}.${key} is not allowed`);
                continue;
            }
            out.push(...schemaProblems(obj[key], schema.properties[key], `${path}.${key}`));
        }
    } else if (type === 'array') {
        if (!Array.isArray(value)) return [`${path} is not an array`];
        value.forEach((v, i) => out.push(...schemaProblems(v, schema.items, `${path}[${i}]`)));
    } else if (type === 'string') {
        if (typeof value !== 'string') return [`${path} is not a string`];
        if (schema.enum && !schema.enum.includes(value)) out.push(`${path} is "${value}", not one of ${schema.enum.join('|')}`);
    } else if (type === 'boolean') {
        if (typeof value !== 'boolean') out.push(`${path} is not a boolean`);
    } else if (type === 'integer' || type === 'number') {
        if (typeof value !== 'number') out.push(`${path} is not a number`);
    }
    return out;
}
