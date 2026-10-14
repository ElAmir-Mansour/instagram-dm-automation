/**
 * What the sales tests are fed: a fixed moment, and the words an owner would type into an offer's sales block, in Arabic and in English.
 *
 * Neutral on purpose (no tenant's name, product or link in it), so the same fixtures serve the owner's golden, the English control
 * and the tests of the guard and the prompt. The proof is marked in its own text as a test's: nothing here is a real count, rating or
 * quote, and the golden that holds it is a test of the prompt, not data the bot will ever say. Imported by tests only.
 */
import type { CreatorProfile, OfferSales } from '../profile/types.js';
import { primaryOffer } from '../profile/validate.js';

/** The moment every prompt in the tests is built at. Mid-October 2026, so `2026-12-31` is live and `2026-09-30` has passed. */
export const NOW = new Date('2026-10-14T09:00:00Z');

export const SALES_AR: OfferSales = {
    for_whom: 'للمبتدئين الذين يريدون بناء أول مشروع عملي بلا خبرة سابقة في البرمجة. لا يناسب من يبحث عن شهادة معتمدة.',
    level: 'beginner',
    outcomes: ['بناء مساعد ذكي يعمل على بياناتك', 'فهم الفرق بين النماذج والوكلاء', 'نشر مشروع جاهز للعرض'],
    faqs: [
        { q: 'هل أحتاج خبرة في البرمجة؟', a: 'لا، يبدأ من الصفر ويشرح كل خطوة بالتطبيق.' },
        { q: 'كم مدة المحتوى؟', a: 'حوالي 12 ساعة موزعة على 40 درساً.' },
    ],
    objections: [
        { objection: 'السعر غالي', answer: 'السعر الحالي موضح في صفحة العرض، ويتغير مع العروض.' },
        { objection: 'ما عندي وقت', answer: 'الدروس قصيرة، ويمكنك التعلم بالسرعة التي تناسبك.' },
    ],
    proof: [{ kind: 'stat', text: 'بيانات تجريبية: 1000 طالب', source: 'اختبار آلي، وليست بيانات حقيقية' }],
    price_note: 'السعر يتغير مع العروض، والسعر الحالي يظهر في الصفحة.',
    price_valid_until: '2026-12-31',
    currency: 'USD',
    image_url: '',
};

export const SALES_EN: OfferSales = {
    for_whom: 'Beginners who want to build a first working project with no coding background. Not for anyone after an accredited certificate.',
    level: 'beginner',
    outcomes: ['Build an assistant that works on your own data', 'Tell models and agents apart', 'Ship a project you can show'],
    faqs: [
        { q: 'Do I need to know how to code?', a: 'No. It starts from zero and shows every step in practice.' },
        { q: 'How long is it?', a: 'About 12 hours across 40 lessons.' },
    ],
    objections: [
        { objection: 'It is too expensive', answer: 'The current price is on the offer page, and it moves with promotions.' },
        { objection: 'I have no time', answer: 'The lessons are short, and you learn at your own pace.' },
    ],
    proof: [{ kind: 'stat', text: 'Test data: 1000 students', source: 'an automated test, not real data' }],
    price_note: 'The price moves with promotions; the page shows today\'s.',
    price_valid_until: '2026-12-31',
    currency: 'USD',
    image_url: '',
};

/** What a profile's `dm` section holds when its owner has typed every part of it. */
const DM_AR = {
    faq: [
        { q: 'ما لغة الشرح؟', a: 'الشرح بالعربية مع بقاء المصطلحات التقنية بالإنجليزية.' },
        { q: 'هل يوجد دعم؟', a: 'نعم، يمكنك طرح أسئلتك في قسم الأسئلة داخل المنصة.' },
    ],
    handoff: { when: 'عند طلب استرجاع المال أو وجود مشكلة في الدفع', message: 'سيتواصل معك صاحب الحساب قريباً.' },
    hours: { days: [0, 1, 2, 3, 4], from: '09:00', to: '17:00' },
};

const DM_EN = {
    faq: [
        { q: 'What language is it in?', a: 'Taught in English, with the technical terms left as they are.' },
        { q: 'Is there support?', a: 'Yes, you can ask in the questions section on the platform.' },
    ],
    handoff: { when: 'They ask for a refund or have a payment problem', message: 'The account owner will reply soon.' },
    hours: { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' },
};

/**
 * `profile` with everything the sales prompt can show typed in: a price with a date that has not passed on the primary offer, its sales
 * block, and the `dm` section's FAQ, hand-off rule and hours. A copy: the argument is not touched. The primary offer must have a link
 * to be shown as one (the owner's has; a test that wants none sets `url` itself).
 */
export function withSales(profile: CreatorProfile, lang: 'ar' | 'en', over: Partial<OfferSales> = {}): CreatorProfile {
    const next = structuredClone(profile);
    const offer = primaryOffer(next.offers);
    if (!offer) throw new Error('withSales needs a profile with an offer');
    offer.price = '49';
    offer.sales = { ...structuredClone(lang === 'ar' ? SALES_AR : SALES_EN), ...over };
    next.dm = structuredClone(lang === 'ar' ? DM_AR : DM_EN);
    return next;
}
