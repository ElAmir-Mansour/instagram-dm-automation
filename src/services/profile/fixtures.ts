/**
 * The second tenants (docs/onboarding/05 §3): two creators who are nothing like the owner, for every PR that takes an owner
 * value out of a prompt (P8-P15) to be tested against. A builder that still says something of his for either of them fails
 * `assertNoOwnerMarkers` (testSupport.ts), and the positive checks say the builder spoke *their* language about *their* offer.
 *
 *   FITNESS_EN   an English fitness coach: left to right, no register, a coaching call and a twelve-week program (so the kind of
 *                offer is "mixed"), a presenter who is neither he nor she, and a rule of their own ("No before-and-after photos").
 *   SHOP_EG      an Egyptian-Arabic shop of handmade candles: Egyptian register, two products, no presenter, no tech anywhere.
 *   FITNESS_EN_PROGRAM / SHOP_EG_SERVICE: the same two tenants selling one thing of one kind, for the tests that pin what an offer
 *                of that kind is called ("programs", «خدمات»).
 *
 * Imported by tests only; production code never reads it. They began in `context.test.ts` and moved here so P9-P15 reuse them.
 */
import { defaultProfile } from './defaults.js';
import type { CreatorProfile, Offer } from './types.js';

/** An offer with nothing set but what a test names: it orders by DM, so it needs no link. */
export const offer = (over: Partial<Offer>): Offer => ({
    id: 'o', kind: 'other', name: '', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: false, ...over,
});

/** An English fitness coach on a neutral profile: nothing of the owner's in it. */
export const FITNESS_EN: CreatorProfile = {
    ...defaultProfile({ lang: 'en', rules: [] }),
    identity: { display_name: { ar: '', en: 'Sami Fitness' }, brand_name: 'Sami Fit', kind: 'coach', role: 'fitness coach', niche: 'Home workouts for busy parents', country: 'GB', timezone: 'Europe/London' },
    offers: [
        offer({ id: 'call', kind: 'coaching', name: 'One-to-one call', order_via: 'dm', keyword: 'call' }),
        offer({ id: 'plan', kind: 'program', name: 'Twelve-week plan', order_via: 'url', url: 'https://samifit.example/plan', keyword: 'plan', primary: true }),
    ],
    audience: { description: 'Parents with under an hour a day', level: 'beginner', pains: ['No time'], goals: ['Sleep better'], countries: ['GB'], languages: ['en'] },
    voice: { guide: 'Warm and direct.', tone: [], samples: [], use_words: [], avoid_words: [], emoji: 'rich', address: 'neutral' },
    presenter: { name: 'Sami', pronouns: 'they', on_camera: 'face' },
    content: { domain: 'general', pillars: ['Workouts', 'Food'], never_mention: ['steroids'], rules: [], custom_rules: ['No before-and-after photos'] },
    socials: { handle: '@sami.fit', site: 'samifit.example', platforms: ['instagram'], links: { instagram: 'https://instagram.com/sami.fit' } },
    dm: { faq: [{ q: 'How much?', a: '$99' }], handoff: { when: 'A refund', message: 'A person will reply.' }, hours: { days: [1, 2, 3], from: '09:00', to: '17:00' } },
    goals: { followers: 5000, views: 250_000 },
};

/** An Egyptian-Arabic shop selling products: no presenter, no educator anywhere. */
export const SHOP_EG: CreatorProfile = {
    ...defaultProfile({ lang: 'ar', rules: ['no_women_imagery'] }),
    identity: { display_name: { ar: 'متجر نور', en: 'Nour Shop' }, brand_name: '', kind: 'shop', role: 'online shop', niche: 'Handmade candles', country: 'EG', timezone: 'Africa/Cairo' },
    language: { primary: 'ar', register: 'egyptian', digits: 'latin', surfaces: {} },
    offers: [
        offer({ id: 'candle', kind: 'product', name: 'شمعة لافندر', order_via: 'url', url: 'https://nour.example/candle', keyword: 'شمعة', primary: true }),
        offer({ id: 'box', kind: 'product', name: 'علبة هدية', order_via: 'dm', keyword: 'علبة' }),
    ],
    voice: { guide: '', tone: [], samples: [], use_words: [], avoid_words: [], emoji: 'light', address: 'fem' },
    content: { domain: 'general', pillars: ['منتجات'], never_mention: [], rules: ['no_women_imagery'], custom_rules: [] },
};

/** The fitness coach with the twelve-week program as its only offer: every offer is a `program`. */
export const FITNESS_EN_PROGRAM: CreatorProfile = {
    ...FITNESS_EN,
    offers: FITNESS_EN.offers.filter((o) => o.kind === 'program'),
};

/** The shop as a service: one booking, every offer a `service`. */
export const SHOP_EG_SERVICE: CreatorProfile = {
    ...SHOP_EG,
    offers: [offer({ id: 'wrap', kind: 'service', name: 'تغليف هدايا', order_via: 'dm', keyword: 'تغليف', primary: true })],
};
