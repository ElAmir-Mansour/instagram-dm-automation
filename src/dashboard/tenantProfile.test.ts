/**
 * The admin's "fill on behalf" profile editor (P19): `dashboard/js/pages/tenant_profile.js`, and the section of
 * `tenant_detail.js` that opens it.
 *
 * Loaded the way escaping.test.ts and roles.test.ts load the dashboard: the REAL files in a `node:vm` context, with the real
 * dictionaries, so these test what ships. There is no browser here, so the DOM is two small things:
 *
 *   - `parse()` reads the editor's rendered markup the way a browser would read the controls in it (entities decoded, the first
 *     newline of a `<textarea>` dropped, a `<select>` holding its `selected` option), and hands back the snapshots
 *     `TenantProfile.snapshot()` takes from a live page. So "render a profile, read the form back" is tested end to end for every
 *     field, which is what makes "Save sends only what changed" true: an untouched form reads back as exactly what it was drawn from;
 *   - a fake host and form for the save flows, whose `snapshot` is the parsed markup with the admin's edits typed into it.
 *
 * Pinned:
 *   - the registry matches the server's closed lists and covers every field of the seven sections (what is not covered is listed);
 *   - an untouched form has no changed path, a change sends only its own path, nested as the server's merge wants it, and clearing an
 *     optional field is `null`, which the server's `mergePatch` turns into a removal;
 *   - **escaping**: a payload in every field is text and never markup, in a tag-and-attribute audit of the output; and the source
 *     has no `innerHTML` without `esc(`, no raw HTML from a variable, no inline handler;
 *   - a 409 version conflict keeps the admin's edits on screen, blocks Save until a reload, and a reload can put the edits back on
 *     top of the latest; the owner's rule asks before it sends `confirm_remove_owner_rule`;
 *   - every control is labelled, every `aria-describedby` points at something, every action the markup names is registered, and
 *     every string it says is in both dictionaries.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { mergePatch } from '../services/profile/patch.js';
import { defaultProfile } from '../services/profile/defaults.js';
import { leafPaths, richProfile } from '../services/profile/testSupport.js';
import {
    ADDRESS, CONTENT_RULE_PRESETS, DIGITS, DOMAINS, EMOJI_LEVELS, KINDS, LANGS, LEVELS, OFFER_KINDS, ORDER_VIA, REGISTERS, SOCIALS, SURFACES,
    type CreatorProfile,
} from '../services/profile/types.js';
import { validateProfile } from '../services/profile/validate.js';

type Json = Record<string, any>;
type Snap = { fields: { path: string; value: string; checked?: boolean }[]; offers: Json[] | null };

const plain = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;

// ─── Loading ─────────────────────────────────────────────────────────────────────────────────

interface Loaded {
    ctx: Json;
    TP: Json;
    Detail: Json;
    UI: Json;
    Admin: Json;
    API: Json;
    t: (key: string, params?: Json) => string;
    toasts: { message: string; type: string | undefined }[];
    confirms: Json[];
    scripts: Json[];
}

/** `App.ASSET_VERSION`, as the shell ships it. */
function assetVersion(): string {
    const found = /ASSET_VERSION:\s*'([\d.]+)'/.exec(readFileSync('dashboard/js/app.js', 'utf8'));
    assert.ok(found, 'app.js has an ASSET_VERSION');
    return found[1]!;
}

function load(lang: 'ar' | 'en' = 'en'): Loaded {
    const noop = (): void => {};
    const scripts: Json[] = [];
    const stub = {
        addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null, contains: () => false, children: [], innerHTML: '',
    };
    const ctx: Json = {
        document: {
            ...stub,
            createElement: () => ({ ...stub }),
            body: { ...stub },
            head: { ...stub, appendChild: (el: Json) => { scripts.push(el); } },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: () => null, activeElement: null, visibilityState: 'visible',
        },
        window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        location: { hash: '' },
        Intl, console, setTimeout, clearTimeout, requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang }, CSS: { escape: (v: string) => String(v) },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        // The shell's own cache version, read from app.js, so this test never pins a number a later dashboard change bumps.
        API: {}, Motion: { announce: noop }, App: { ASSET_VERSION: assetVersion(), session: null, hashParam: () => '' },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const file of [
        'dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js',
        'dashboard/js/pages/admin_common.js', 'dashboard/js/pages/tenant_profile.js', 'dashboard/js/pages/tenant_detail.js',
    ]) {
        vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
    }
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const got = vm.runInContext('({ TP: TenantProfile, Detail: TenantDetailPage, UI, Admin, t })', ctx) as Json;
    const toasts: Loaded['toasts'] = [];
    const confirms: Json[] = [];
    got.UI.toast = (message: string, type?: string) => { toasts.push({ message, type }); };
    got.UI.icons = noop;
    got.Admin.confirm = (options: Json) => { confirms.push(options); };
    return { ctx, TP: got.TP, Detail: got.Detail, UI: got.UI, Admin: got.Admin, API: ctx.API, t: got.t, toasts, confirms, scripts };
}

// ─── Reading the markup the way a browser reads its controls ────────────────────────────────

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`' };
const decode = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, (m) => ENTITIES[m]!);

function attrsOf(tag: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/\s([\w:-]+)(?:="([^"]*)")?/g)) attrs[m[1]!] = m[2] === undefined ? '' : decode(m[2]);
    return attrs;
}

/** The control snapshots `TenantProfile.snapshot()` would take from a page showing `markup`. */
function parse(markup: string): Snap {
    const fields: Snap['fields'] = [];
    const cards: Json[] = [];
    let card: Json | null = null;
    const pattern = /<fieldset class="tp-offer" data-offer-id="([^"]*)">|<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g;
    for (const m of markup.matchAll(pattern)) {
        if (m[1] !== undefined) {
            card = { id: decode(m[1]) };
            cards.push(card);
            continue;
        }
        let attrs: Record<string, string>;
        let value: string;
        let checked: boolean | undefined;
        if (m[2] !== undefined) {
            attrs = attrsOf(`<input${m[2]}>`);
            value = attrs.value ?? '';
            checked = attrs.type === 'checkbox' || attrs.type === 'radio' ? 'checked' in attrs : undefined;
        } else if (m[3] !== undefined) {
            attrs = attrsOf(`<select${m[3]}>`);
            const options = [...m[4]!.matchAll(/<option value="([^"]*)"( selected)?>/g)];
            value = decode((options.find((o) => o[2]) ?? options[0])?.[1] ?? '');
        } else {
            attrs = attrsOf(`<textarea${m[5]}>`);
            const body = m[6]!;
            value = decode(body.startsWith('\n') ? body.slice(1) : body); // the HTML parser drops the first newline
        }
        if (attrs['data-tp-path'] !== undefined) fields.push({ path: attrs['data-tp-path'], value, checked });
        else if (attrs['data-tp-offer'] !== undefined && card) {
            if (attrs['data-tp-offer'] === 'primary') card.primary = checked === true;
            else card[attrs['data-tp-offer']] = value;
        }
    }
    return { fields, offers: cards.length || /data-tp-offers/.test(markup) ? cards : null };
}

/** The admin typing: `value` into the control(s) of `path`; for a choice list, `value` is the list of what is ticked. */
function type(snap: Snap, path: string, value: string | string[]): void {
    if (Array.isArray(value)) {
        for (const f of snap.fields.filter((x) => x.path === path)) f.checked = value.includes(f.value);
        return;
    }
    const f = snap.fields.find((x) => x.path === path);
    assert.ok(f, `there is a control for ${path}`);
    f.value = value;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────

/** A profile whose every Studio-owned section is filled in, plus the things the form must carry untouched (a campaign). */
const rich = (): CreatorProfile => richProfile();

const STATE = (profile: CreatorProfile, over: Json = {}): Json => ({
    profile, version: 3, stored: true, activationMissing: [], isPlatformOwner: false, onboarding: { status: 'invited', filledBy: null }, ...over,
});

/** The editor mounted on `profile` with a fake host, and a way to ask for the form the admin sees. */
function mounted(profile: CreatorProfile = rich(), over: Json = {}) {
    const l = load();
    const { TP } = l;
    TP.tenantId = 'tenant-1';
    TP.tenantName = 'Sami';
    TP.adopt(STATE(profile, over));
    const markup = (): string => String(TP.render(TP.base));
    return { ...l, markup, form: (): Snap => parse(markup()) };
}

// ─── The registry ────────────────────────────────────────────────────────────────────────────

describe('the editor knows what a profile holds', () => {
    it('draws its closed lists from the server\'s, value for value', () => {
        const { TP } = load();
        const expected: Record<string, readonly string[]> = {
            kind: KINDS, register: REGISTERS, digits: DIGITS, lang: LANGS, level: LEVELS, emoji: EMOJI_LEVELS, address: ADDRESS, domain: DOMAINS,
            offerKind: OFFER_KINDS, orderVia: ORDER_VIA, rule: CONTENT_RULE_PRESETS, social: SOCIALS, surface: SURFACES,
        };
        assert.deepEqual(plain(TP.ENUMS), expected);
        assert.equal(TP.OWNER_RULE, 'no_women_imagery');
    });

    it('has a field for every leaf of the seven sections it edits, and the sections it leaves out are named', () => {
        const { TP } = load();
        const profile = rich();
        const covered = new Set<string>(TP.allFields().map((f: Json) => f.path));
        const form = ['identity', 'language', 'voice', 'audience', 'content', 'socials'] as const;
        const missing = form.flatMap((section) => leafPaths({ [section]: (profile as unknown as Json)[section] })).filter((p) => !covered.has(p));
        assert.deepEqual(missing, [], 'a field the profile holds that the admin cannot fill in');
        // offers are one list of cards: not a path. These are the profile sections that have no form yet: a new section must be a decision.
        const uncovered = Object.keys(profile).filter((k) => !form.includes(k as never) && k !== 'offers');
        assert.deepEqual(uncovered.sort(), ['brand', 'dm', 'goals', 'presenter', 'schema']);
        assert.deepEqual(plain(TP.SECTIONS), ['identity', 'language', 'voice', 'audience', 'offers', 'content', 'socials']);
    });

    it('every field is a place the server\'s validator knows (a typo in a path would be refused by it)', () => {
        const { TP } = load();
        const profile = rich();
        const base = plain<Json>(TP.valuesOf(profile));
        for (const f of TP.allFields() as Json[]) {
            // An optional field that is empty has nothing to send: a null for an entry that is not there would be the server's to refuse.
            if (f.empty === 'null' && base[f.path] === '') continue;
            const patch = TP.buildPatch(TP.valuesOf(profile), [f.path]);
            const merged = mergePatch(profile, patch) as CreatorProfile;
            const checked = validateProfile(merged);
            assert.ok('profile' in checked, `${f.path}: ${JSON.stringify((checked as Json).problems)}`);
        }
    });

    it('has every label, hint, option and message in both dictionaries', () => {
        for (const lang of ['ar', 'en'] as const) {
            const { TP, ctx } = load(lang);
            const dict = vm.runInContext('I18N.strings', ctx)[lang] as Record<string, string>;
            const need = new Set<string>();
            for (const f of TP.allFields() as Json[]) {
                if (f.group === undefined) need.add(`tenantProfile.f.${f.path}`);
                if (f.hint) need.add(`tenantProfile.h.${f.path}`);
                if (f.enum) for (const v of TP.ENUMS[f.enum]) need.add(`tenantProfile.o.${f.enum}.${v}`);
            }
            for (const list of Object.keys(TP.ENUMS)) for (const v of TP.ENUMS[list]) need.add(`tenantProfile.o.${list}.${v}`);
            for (const s of TP.SECTIONS) need.add(`tenantProfile.section.${s}`);
            for (const k of ['kind', 'name', 'order_via', 'url', 'price', 'keyword', 'facts', 'bullets', 'primary']) need.add(`tenantProfile.f.offer.${k}`);
            for (const s of ['invited', 'in_progress', 'completed']) need.add(`tenantProfile.onboarding.${s}`);
            need.add('tenantProfile.o.none');
            need.add('tenantProfile.o.inherit');
            // Everything else the file says, found where it says it.
            const source = readFileSync('dashboard/js/pages/tenant_profile.js', 'utf8') + readFileSync('dashboard/js/pages/tenant_detail.js', 'utf8');
            for (const m of source.matchAll(/\bt\('(tenantProfile\.[A-Za-z0-9_.]+)'/g)) need.add(m[1]!);
            const absent = [...need].filter((k) => dict[k] === undefined);
            assert.deepEqual(absent, [], `${lang}: keys the editor uses and the dictionary lacks`);
            assert.ok(need.size > 100, `${need.size} keys checked`);
        }
    });
});

// ─── What changed, and what is sent ──────────────────────────────────────────────────────────

describe('what a save sends', () => {
    it('an untouched form has no changed path, for a rich profile and a new tenant\'s default', () => {
        for (const profile of [rich(), defaultProfile({ lang: 'en', rules: [] }), defaultProfile({ lang: 'ar' })]) {
            const { TP, form } = mounted(profile);
            const read = TP.fromSnapshots(form(), TP.base);
            assert.deepEqual(plain(TP.changedPaths(TP.base, read)), []);
        }
    });

    it('reading the form back gives every value it was drawn from (so an untouched field is never "changed")', () => {
        for (const profile of [rich(), defaultProfile({ lang: 'en', rules: [] })]) {
            const { TP, form } = mounted(profile);
            const values = plain<Json>(TP.base);
            const snap = form();
            const keep = Object.fromEntries(Object.entries(values).filter(([k]) => k === 'offers' || TP.fieldFor(k)?.type === 'checks'));
            keep.offers = values.offers.map((o: Json) => ({ id: o.id, campaign: o.campaign }));
            const read = plain<Json>(TP.fromSnapshots(snap, keep));
            for (const key of Object.keys(values)) assert.deepEqual(read[key], values[key], key);
            // The choice lists and the offers really were read from controls: nothing fell back to `base`.
            for (const f of TP.allFields().filter((x: Json) => x.type === 'checks')) {
                assert.equal(snap.fields.filter((c) => c.path === f.path).length, TP.ENUMS[f.enum].length, f.path);
            }
            assert.equal(snap.offers!.length, values.offers.length);
        }
    });

    it('a change sends its own path and nothing else, nested the way the server merges it', () => {
        const { TP, form } = mounted();
        const snap = form();
        type(snap, 'identity.niche', '  Strength for beginners ');
        type(snap, 'voice.emoji', 'light');
        type(snap, 'content.pillars', 'Mobility\n\n  Food  \n');
        const current = TP.fromSnapshots(snap, TP.base);
        const paths = plain<string[]>(TP.changedPaths(TP.base, current));
        assert.deepEqual(paths.sort(), ['content.pillars', 'identity.niche', 'voice.emoji']);
        assert.deepEqual(plain(TP.buildPatch(current, paths)), {
            identity: { niche: 'Strength for beginners' }, voice: { emoji: 'light' }, content: { pillars: ['Mobility', 'Food'] },
        });
        assert.deepEqual(plain(TP.changedPaths(TP.base, current, 'voice')), ['voice.emoji'], 'a section\'s own paths only');
    });

    it('a patch the editor builds is one the server merges into exactly the edited profile, and accepts', () => {
        const { TP, form } = mounted();
        const snap = form();
        type(snap, 'identity.display_name.en', 'Sami F.');
        type(snap, 'identity.country', 'sa');
        type(snap, 'language.register', 'gulf');
        type(snap, 'audience.countries', 'sa\neg\n');
        type(snap, 'socials.platforms', ['youtube', 'x', 'instagram']);
        type(snap, 'voice.samples', 'One.\nStill one.\n---\nTwo.');
        const current = TP.fromSnapshots(snap, TP.base);
        const merged = mergePatch(rich(), TP.buildPatch(current, TP.changedPaths(TP.base, current))) as CreatorProfile;
        const checked = validateProfile(merged);
        assert.ok('profile' in checked, JSON.stringify((checked as Json).problems));
        assert.equal(merged.identity.display_name.en, 'Sami F.');
        assert.equal(merged.identity.display_name.ar, 'سامي للياقة', 'what the patch does not name is kept');
        assert.equal(merged.identity.country, 'SA', 'a country is upper-cased');
        assert.equal(merged.language.register, 'gulf');
        assert.deepEqual(merged.audience.countries, ['SA', 'EG']);
        assert.deepEqual(merged.voice.samples, ['One.\nStill one.', 'Two.'], 'a sample may hold line breaks; --- separates them');
        // The stored order of what stays ticked is kept, and the new one goes last: ticking a platform reorders nothing.
        assert.deepEqual(merged.socials.platforms, ['youtube', 'x'].length ? ['instagram', 'youtube', 'x'] : []);
    });

    it('keeps the stored order of a choice list, and appends only what is newly ticked', () => {
        const profile = rich();
        profile.socials.platforms = ['youtube', 'instagram'];
        const { TP, form } = mounted(profile);
        const untouched = TP.fromSnapshots(form(), TP.base);
        assert.deepEqual(plain(untouched['socials.platforms']), ['youtube', 'instagram'], 'untouched: as stored, not the checkboxes\' order');
        assert.deepEqual(plain(TP.changedPaths(TP.base, untouched)), []);
        const snap = form();
        type(snap, 'socials.platforms', ['youtube', 'instagram', 'tiktok']);
        assert.deepEqual(plain(TP.fromSnapshots(snap, TP.base)['socials.platforms']), ['youtube', 'instagram', 'tiktok']);
    });

    it('clearing an optional field sends null, and the server\'s merge turns it into a removal', () => {
        const { TP, form } = mounted();
        const snap = form();
        type(snap, 'socials.links.instagram', '');
        type(snap, 'audience.timezone', '');
        type(snap, 'language.surfaces.carousel.language', '');
        type(snap, 'language.surfaces.infographic.register', '');
        type(snap, 'identity.kind', '');
        const current = TP.fromSnapshots(snap, TP.base);
        const patch = plain<Json>(TP.buildPatch(current, TP.changedPaths(TP.base, current)));
        assert.deepEqual(patch, {
            socials: { links: { instagram: null } },
            audience: { timezone: null },
            language: { surfaces: { carousel: { language: null }, infographic: { register: null } } },
            identity: { kind: null },
        });
        const merged = mergePatch(rich(), patch) as CreatorProfile;
        assert.deepEqual(merged.socials.links, {}, 'the link is gone');
        assert.ok(!('timezone' in merged.audience), 'the heatmap override is gone');
        assert.deepEqual(merged.language.surfaces, { carousel: {}, infographic: { language: 'ar' }, dm: { register: 'levantine' } });
        assert.equal(merged.identity.kind, null);
    });

    it('an empty field that was never there is no change (a surface left on "same as the profile", a link nobody set)', () => {
        const { TP, form } = mounted(defaultProfile({ lang: 'en', rules: [] }));
        const snap = form();
        type(snap, 'socials.links.youtube', '');
        type(snap, 'language.surfaces.dm.language', '');
        type(snap, 'audience.timezone', '   ');
        assert.deepEqual(plain(TP.changedPaths(TP.base, TP.fromSnapshots(snap, TP.base))), []);
    });

    it('a required text field cleared stays an empty string: the server judges it, not a null', () => {
        const { TP, form } = mounted();
        const snap = form();
        type(snap, 'identity.niche', '');
        const current = TP.fromSnapshots(snap, TP.base);
        assert.deepEqual(plain(TP.buildPatch(current, TP.changedPaths(TP.base, current))), { identity: { niche: '' } });
    });

    describe('offers', () => {
        it('are sent whole when anything in them changed, with the comment campaign carried over untouched', () => {
            const { TP, form } = mounted();
            const snap = form();
            const main = snap.offers!.find((o) => o.id === 'main')!;
            main.name = 'Sixteen-week program';
            main.facts = '16 weeks\nVideo lessons';
            const current = TP.fromSnapshots(snap, TP.base);
            assert.deepEqual(plain(TP.changedPaths(TP.base, current)), ['offers']);
            const patch = plain<Json>(TP.buildPatch(current, ['offers']));
            assert.deepEqual(Object.keys(patch), ['offers']);
            assert.equal(patch.offers.length, 2);
            const sent = patch.offers.find((o: Json) => o.id === 'main');
            assert.equal(sent.name, 'Sixteen-week program');
            assert.deepEqual(sent.facts, ['16 weeks', 'Video lessons']);
            assert.deepEqual(sent.campaign, rich().offers[1]!.campaign, 'the campaign is not editable here, and survives');
            assert.ok(!('campaign' in patch.offers.find((o: Json) => o.id === 'side')));
            const merged = mergePatch(rich(), patch) as CreatorProfile;
            assert.ok('profile' in validateProfile(merged));
        });

        it('switching the primary offer is a change, and exactly one stays primary', () => {
            const { TP, form } = mounted();
            const snap = form();
            snap.offers!.forEach((o) => { o.primary = o.id === 'side'; });
            const current = TP.fromSnapshots(snap, TP.base);
            assert.deepEqual(plain(TP.changedPaths(TP.base, current)), ['offers']);
            assert.deepEqual(plain<Json[]>(current.offers).map((o) => [o.id, o.primary]), [['side', true], ['main', false]]);
        });

        it('adding one makes a new id that no other offer holds, primary only when it is the first, and removing the primary promotes another', () => {
            const { TP } = mounted();
            const blank = plain<Json>(TP.blankOffer(plain(TP.base.offers)));
            assert.ok(!TP.base.offers.some((o: Json) => o.id === blank.id));
            assert.equal(blank.primary, false);
            assert.equal(plain<Json>(TP.blankOffer([])).primary, true);
            assert.match(blank.id, /^offer-[a-z0-9]{1,8}$/);
            assert.ok(blank.id.length <= 40, 'within the server\'s id limit');

            // Removing the primary through the real handler: the card is found by its id, the section is drawn again from what the form holds.
            const fixture = mounted();
            const seen: Json[] = [];
            fixture.TP.snapshot = () => fixture.form();
            fixture.TP.paintSection = (section: string, values: Json) => { seen.push({ section, offers: plain(values.offers) }); return null; };
            fixture.TP.host = { querySelector: () => null };
            const button = { closest: (sel: string) => (sel === 'form' ? {} : { getAttribute: () => 'main' }) };
            fixture.TP.removeOffer(button);
            assert.equal(seen.length, 1);
            assert.deepEqual(seen[0]!.offers.map((o: Json) => [o.id, o.primary]), [['side', true]]);
        });

        it('the add button is disabled at the server\'s limit of ten', () => {
            const { TP } = load();
            const offers = Array.from({ length: 10 }, (_, i) => ({ ...plain<Json>(TP.blankOffer([])), id: `o${i}`, primary: i === 0 }));
            const markup = String(TP.offersMarkup({ offers }));
            assert.match(markup, /data-action="tenantProfile:addOffer"[^>]*disabled/);
            assert.doesNotMatch(String(TP.offersMarkup({ offers: offers.slice(0, 9) })), /data-action="tenantProfile:addOffer"[^>]*disabled/);
        });
    });
});

// ─── Escaping ────────────────────────────────────────────────────────────────────────────────

const PAYLOAD = (tag: string): string => `"><img src=x onerror=alert('${tag}')>' onfocus='alert("${tag}")&amp;<script>x</script>\`${tag}`;

/** A profile with a payload in every string it holds, and the fields that take only a closed list holding one too. */
function hostile(): { profile: CreatorProfile; tags: Map<string, string> } {
    const tags = new Map<string, string>();
    let n = 0;
    const p = (where: string): string => {
        const tag = `P${++n}-${where}`;
        tags.set(tag, PAYLOAD(tag));
        return PAYLOAD(tag);
    };
    const profile = rich() as unknown as Json;
    const fill = (node: Json, path: string): void => {
        for (const key of Object.keys(node)) {
            const here = `${path}.${key}`;
            const v = node[key];
            if (typeof v === 'string') node[key] = p(here);
            else if (Array.isArray(v)) node[key] = v.map((x, i) => (typeof x === 'string' ? p(`${here}[${i}]`) : (fill(x, `${here}[${i}]`), x)));
            else if (v !== null && typeof v === 'object') fill(v, here);
        }
    };
    for (const section of ['identity', 'language', 'voice', 'audience', 'content', 'socials']) fill(profile[section], section);
    profile.offers = profile.offers.map((o: Json, i: number) => { fill(o, `offers[${i}]`); return o; });
    return { profile: profile as CreatorProfile, tags };
}

const ALLOWED_TAGS = new Set(['div', 'section', 'form', 'h3', 'p', 'label', 'input', 'select', 'option', 'optgroup', 'textarea', 'fieldset', 'legend', 'button', 'i', 'span', 'datalist', 'code', 'ul', 'li']);
const ALLOWED_ATTRS = /^(class|id|type|value|for|name|dir|rows|maxlength|list|autocomplete|spellcheck|checked|selected|disabled|tabindex|role|novalidate|aria-[a-z]+|data-[a-z-]+)$/;
const TAG = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g;

describe('escaping: a payload in every field is text, never markup', () => {
    it('renders every field\'s payload as text: no tag, attribute or handler the page did not write', () => {
        const { profile, tags } = hostile();
        const { TP } = load();
        TP.tenantName = PAYLOAD('name');
        TP.state = STATE(profile, {
            version: 7, activationMissing: [PAYLOAD('missing')], onboarding: { status: PAYLOAD('status'), filledBy: PAYLOAD('filled') }, isPlatformOwner: true,
        });
        TP.conflict = { currentVersion: PAYLOAD('conflict') };
        TP.base = TP.valuesOf(profile);
        const out = String(TP.render(TP.base));

        // 1. Every tag is one the page writes, with attributes it writes: a payload that broke out would add a tag or an attribute.
        const tagNames = new Set<string>();
        for (const m of out.matchAll(TAG)) {
            tagNames.add(m[1]!.toLowerCase());
            for (const a of m[2]!.matchAll(/\s([\w:-]+)(?:="[^"]*")?/g)) assert.match(a[1]!, ALLOWED_ATTRS, `an attribute the page does not write: ${a[1]} in ${m[0].slice(0, 120)}`);
        }
        assert.deepEqual([...tagNames].filter((x) => !ALLOWED_TAGS.has(x)), [], 'a tag the page does not write');
        assert.ok(!/<(img|script|svg|iframe|a|style|object|embed|link|meta)\b/i.test(out), 'no live injected element');
        // 2. Take every well-formed tag away: nothing that remains is markup.
        const text = out.replace(TAG, '');
        assert.ok(!text.includes('<') && !text.includes('>'), `a stray angle bracket outside a tag: ${text.match(/.{0,30}[<>].{0,30}/)?.[0]}`);

        // 3. Each payload that is shown is shown escaped, and none is shown raw.
        const shown: string[] = [];
        for (const [tag, payload] of tags) {
            assert.ok(!out.includes(payload), `${tag} is in the page unescaped`);
            // A country or a language code is made upper or lower case before it is shown: that is its canonical form, still escaped.
            if ([payload, payload.toUpperCase(), payload.toLowerCase()].some((v) => out.includes(plainEscape(v)))) shown.push(tag);
        }
        assert.ok(shown.length > 30, `${shown.length} payloads were rendered: the text, line and offer fields all reflect their value`);
        for (const tag of tags.keys()) {
            if (/identity\.(display_name|brand_name|role|niche|country|timezone)|voice\.(guide|tone|samples|use_words|avoid_words)|audience\.(description|pains|goals|countries|languages|timezone)|content\.(pillars|never_mention|custom_rules)|socials\.(handle|site|links)|offers\[\d\]\.(name|url|price|keyword|facts|bullets|id)/.test(tag)) {
                assert.ok(shown.includes(tag), `${tag} is reflected in the form, escaped`);
            }
        }
        // The name, the missing paths and the status come from the server too.
        for (const tag of ['name', 'missing']) assert.ok(out.includes(plainEscape(PAYLOAD(tag))), tag);
    });

    it('a payload in an offer id cannot leave its attribute, and reads back as the same id', () => {
        const { TP } = load();
        const profile = rich();
        profile.offers[0]!.id = PAYLOAD('id');
        TP.state = STATE(profile);
        TP.base = TP.valuesOf(profile);
        const markup = String(TP.render(TP.base));
        assert.ok(!markup.includes(PAYLOAD('id')));
        const snap = parse(markup);
        assert.equal(snap.offers![0]!.id, PAYLOAD('id'), 'the id round-trips through its attribute, so the campaign finds its offer');
    });

    it('the source never renders a value with innerHTML, builds markup from one, or wires an inline handler', () => {
        const detail = readFileSync('dashboard/js/pages/tenant_detail.js', 'utf8');
        // The tenant screen's own older code writes spinners; the lint is of what P19 added there.
        const added = detail.slice(detail.indexOf('renderProfile(row) {'), detail.indexOf('// ─── Actions'));
        assert.ok(added.length > 500, 'found the P19 part of the tenant screen');
        for (const [file, text] of [['dashboard/js/pages/tenant_profile.js', readFileSync('dashboard/js/pages/tenant_profile.js', 'utf8')], ['dashboard/js/pages/tenant_detail.js (P19)', added]] as const) {
            const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            const assigned = [...src.matchAll(/\.innerHTML\s*=\s*([^;]*)/g)].map((m) => m[1]!.trim());
            for (const rhs of assigned) assert.match(rhs, /^(esc\(|''$|""$)/, `${file}: innerHTML = ${rhs.slice(0, 60)}`);
            assert.ok(!/insertAdjacentHTML|outerHTML|document\.write|\beval\(|new Function/.test(src), `${file}: another way to make markup from a string`);
            assert.ok(!/\bon[a-z]+\s*=\s*["'`]/i.test(src.replace(/script\.on(load|error)\s*=/g, '')), `${file}: an inline handler`);
            for (const m of src.matchAll(/html\.raw\(([^)]*)\)/g)) assert.match(m[1]!.trim(), /^'[^']*'$/, `${file}: html.raw of something that is not a literal: ${m[1]}`);
        }
    });
});

/** The literal parts of every html`…` template in `src`, with each `${…}` expression (nested braces and templates included) taken out. */
function templates(src: string): string[] {
    const skipTemplate = (from: number): number => {
        let i = from + 1;
        while (i < src.length && src[i] !== '`') {
            if (src[i] === '\\') i += 2;
            else if (src[i] === '$' && src[i + 1] === '{') i = skipExpression(i + 2);
            else i += 1;
        }
        return i + 1;
    };
    const skipExpression = (from: number): number => {
        let depth = 1;
        let i = from;
        while (i < src.length && depth > 0) {
            if (src[i] === '`') i = skipTemplate(i);
            else {
                if (src[i] === '{') depth += 1;
                else if (src[i] === '}') depth -= 1;
                i += 1;
            }
        }
        return i;
    };
    const out: string[] = [];
    for (let at = src.indexOf('html`'); at >= 0; at = src.indexOf('html`', at + 1)) {
        let i = at + 5;
        let literal = '';
        while (i < src.length && src[i] !== '`') {
            if (src[i] === '\\') { literal += src[i + 1]; i += 2; }
            else if (src[i] === '$' && src[i + 1] === '{') { literal += ' '; i = skipExpression(i + 2); }
            else { literal += src[i]; i += 1; }
        }
        out.push(literal);
    }
    return out;
}

/** What `esc()` makes of a string: what the page shows for it. */
function plainEscape(s: string): string {
    return s.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]!));
}

// ─── The markup is accessible and wired ─────────────────────────────────────────────────────

describe('the markup', () => {
    it('labels every control, points every aria-describedby at something, and gives no two elements one id', () => {
        const { markup } = mounted(rich(), { isPlatformOwner: true });
        const out = markup();
        const ids = [...out.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]!);
        assert.equal(new Set(ids).size, ids.length, `a duplicate id: ${ids.find((x, i) => ids.indexOf(x) !== i)}`);
        const labelled = new Set([...out.matchAll(/<label[^>]*\sfor="([^"]*)"/g)].map((m) => m[1]!));
        const controls = [...out.matchAll(/<(input|select|textarea)\b([^>]*)>/g)];
        assert.ok(controls.length > 60, `${controls.length} controls`);
        for (const [, tag, rest] of controls) {
            const a = attrsOf(`<${tag}${rest}>`);
            assert.ok(a.id, `a control with no id: ${rest}`);
            assert.ok(labelled.has(a.id!) || a['aria-label'], `the ${tag} ${a.id} has no label`);
        }
        for (const m of out.matchAll(/aria-describedby="([^"]*)"/g)) {
            for (const id of m[1]!.split(/\s+/)) assert.ok(ids.includes(id), `aria-describedby names ${id}, which is not on the page`);
        }
        // Every section is a form with its own heading and Save, and the alert regions are there before anything is put in them.
        assert.equal([...out.matchAll(/<form class="tp-form"/g)].length, 7);
        for (const s of ['identity', 'language', 'voice', 'audience', 'offers', 'content', 'socials']) {
            assert.match(out, new RegExp(`<form class="tp-form" data-tp-section="${s}" data-submit="tenantProfile:save" aria-labelledby="tp-${s}-title"`));
            assert.match(out, new RegExp(`<h3 class="tp-section-title" id="tp-${s}-title" tabindex="-1">`));
        }
        assert.equal([...out.matchAll(/data-tp-problems role="alert"/g)].length, 7);
        assert.match(out, /<div id="tp-status" role="alert">/);
    });

    it('names no action that is not registered, so a click is never "no handler"', () => {
        const { markup, UI, TP } = mounted(rich());
        TP.conflict = { currentVersion: 4 };
        const out = markup();
        const registered = UI._actions as Json;
        const wanted = new Set<string>();
        for (const m of out.matchAll(/data-(?:action|submit)="([^":]+):([^"]+)"/g)) wanted.add(`${m[1]}:${m[2]}`);
        assert.ok(wanted.size >= 6, [...wanted].join(', '));
        for (const key of wanted) {
            const [ns, method] = key.split(':');
            assert.equal(typeof registered[ns!]?.[method!], 'function', `${key} has no handler`);
        }
        // and the tenant screen's own door to it
        const detail = String(load().Detail.renderProfile({ name: 'Sami' }));
        assert.match(detail, /data-action="tenantDetail:openProfile"/);
        assert.equal(typeof registered.tenantDetail?.openProfile, 'function');
    });

    it('is a mirror in Arabic: free text is dir=auto, addresses and codes are ltr, the Arabic name is rtl, and no physical property is used', () => {
        const { markup } = mounted(rich());
        const out = markup();
        const control = (id: string): Record<string, string> => {
            const tag = new RegExp(`<(?:input|textarea|select)\\b[^>]*\\sid="${id}"[^>]*>`).exec(out);
            assert.ok(tag, `a control with id ${id}`);
            return attrsOf(tag[0]);
        };
        assert.equal(control('tp-identity-display-name-ar').dir, 'rtl');
        for (const id of ['tp-identity-timezone', 'tp-identity-role', 'tp-socials-handle', 'tp-socials-links-instagram', 'tp-identity-country']) {
            assert.equal(control(id).dir, 'ltr', id);
        }
        for (const id of ['tp-identity-niche', 'tp-identity-brand-name', 'tp-voice-guide', 'tp-audience-pains']) assert.equal(control(id).dir, 'auto', id);
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        const block = css.slice(css.indexOf('/* Tenant profile (P19)'));
        assert.ok(block.length > 200, 'the P19 stylesheet block is there');
        assert.ok(!/(^|[\s;{])(margin|padding|border)-(left|right)\s*:|(^|[\s;{])(left|right|float)\s*:|text-align\s*:\s*(left|right)/m.test(block), 'a physical property in the P19 block');
    });

    it('says everything it says in the page\'s language: nothing is spelled in English inside a template', () => {
        const src = readFileSync('dashboard/js/pages/tenant_profile.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const found = templates(src);
        assert.ok(found.length > 20, `${found.length} templates read`);
        for (const literal of found) {
            // What is left once the tags and the `${…}` expressions are taken out is the text the page says itself.
            const text = literal.replace(/<[^>]*>/g, ' ').replace(/\s[\w:-]+="[^"]*"/g, ' ').replace(/\s+/g, ' ').trim();
            assert.ok(!/[A-Za-z]{3,}/.test(text), `English text inside a template: ${text.slice(0, 80)}`);
        }
    });
});

// ─── The screen's door to it ─────────────────────────────────────────────────────────────────

describe('the Profile section of the tenant screen', () => {
    it('is a heading, a sentence naming the tenant (as text) and one button: nothing of the profile is fetched or drawn until it is pressed', () => {
        const { Detail } = load();
        const out = String(Detail.renderProfile({ name: PAYLOAD('tenant') }));
        assert.ok(!out.includes(PAYLOAD('tenant')));
        assert.ok(out.includes(plainEscape(PAYLOAD('tenant'))));
        assert.match(out, /<section class="section" id="tenant-profile">/);
        assert.match(out, /id="tenant-profile-host"/);
        assert.equal([...out.matchAll(/<button/g)].length, 1);
        assert.ok(!/<form|<input|<textarea|<select/.test(out));
    });

    it('is painted by the tenant screen, after the connection', () => {
        const src = readFileSync('dashboard/js/pages/tenant_detail.js', 'utf8');
        const order = ['this.renderHealth(row)', 'this.renderMembers(row)', 'this.renderConnection(row)', 'this.renderProfile(row)'].map((s) => src.indexOf(s));
        assert.ok(order.every((i) => i > 0) && order.every((x, i) => i === 0 || x > order[i - 1]!), 'in the page, in this order');
    });

    it('loads tenant_profile.js on demand, at the cache version, and a failed load is not remembered', async () => {
        const { Detail, scripts, ctx } = load();
        const version = /ASSET_VERSION:\s*'([\d.]+)'/.exec(readFileSync('dashboard/js/app.js', 'utf8'))![1];
        assert.equal(ctx.App.ASSET_VERSION, version, 'the harness is at the same version as the shell');
        // Where the module is already loaded (this context has it) nothing is fetched.
        assert.equal(await Detail.ensureProfileModule(), true, 'already loaded: no script is added');
        assert.deepEqual(scripts, []);

        // A context without it: the script is added at the versioned URL, failing is not cached, succeeding resolves true.
        const src = readFileSync('dashboard/js/pages/tenant_detail.js', 'utf8');
        const added: Json[] = [];
        const clean = vm.createContext({
            document: { createElement: () => ({}), head: { appendChild: (el: Json) => { added.push(el); } } },
            App: { ASSET_VERSION: version },
            UI: { registerActions: () => {} }, html: () => '', t: () => '', Admin: {}, Motion: {},
        });
        vm.runInContext(src, clean);
        const page = vm.runInContext('TenantDetailPage', clean) as Json;
        const one = page.ensureProfileModule();
        assert.equal(added.length, 1);
        assert.equal(added[0]!.src, `/dashboard/js/pages/tenant_profile.js?v=${version}`);
        added[0]!.onerror();
        assert.equal(await one, false);
        const two = page.ensureProfileModule();
        assert.equal(added.length, 2, 'a failure is not cached: the retry fetches again');
        vm.runInContext('var TenantProfile = {};', clean);
        added[1]!.onload();
        assert.equal(await two, true);
        assert.equal(await page.ensureProfileModule(), true);
        assert.equal(added.length, 2, 'and once it is there it is not fetched again');
    });
});

// ─── Saving, conflicts and the owner's rule ─────────────────────────────────────────────────

/** A fake host and form around the real editor, with the admin's typing applied to the parsed markup. */
function session(profile: CreatorProfile = rich(), over: Json = {}) {
    const m = mounted(profile, over);
    const { TP, API } = m;
    const calls: { id: string; body: Json }[] = [];
    const paints = { all: [] as Json[], section: [] as { section: string; values: Json }[], meta: 0, problems: [] as string[][], conflict: [] as unknown[] };
    let snap = m.form();
    const button = { disabled: false, innerHTML: 'Save', querySelector: () => null };
    const form = {
        getAttribute: (name: string) => (name === 'data-tp-section' ? currentSection : null),
        querySelector: (sel: string) => (sel === 'button[type="submit"]' ? button : null),
    };
    let currentSection = 'identity';
    const host = { isConnected: true, querySelector: () => null, querySelectorAll: () => [] };
    TP.host = host;
    TP.snapshot = () => snap;
    TP.paintAll = (values: Json) => { paints.all.push(plain(values)); };
    TP.paintSection = (section: string, values: Json) => { paints.section.push({ section, values: plain(values) }); return null; };
    TP.paintMeta = () => { paints.meta += 1; };
    TP.showProblems = (_form: unknown, problems: string[]) => { paints.problems.push(plain(problems)); };
    TP.showConflict = (v: unknown) => { paints.conflict.push(v); TP.conflict = { currentVersion: v }; };
    TP.clearProblems = () => {};
    API.updateAdminTenantProfile = async (id: string, body: Json) => {
        calls.push({ id, body: plain(body) });
        return answer(body);
    };
    let answer: (body: Json) => Promise<Json> | Json = (body) => STATE(mergePatch(TP.state.profile, body.patch) as CreatorProfile, { version: (TP.state.version ?? 0) + 1 });
    return {
        ...m, calls, paints, form, host,
        edit: (path: string, value: string | string[]) => type(snap, path, value),
        offers: () => snap.offers!,
        use: (section: string) => { currentSection = section; },
        respond: (fn: typeof answer) => { answer = fn; },
        redraw: () => { snap = m.form(); },
        button,
    };
}

const fail = (status: number, body: Json) => Object.assign(new Error(body.error || 'failed'), { status, body });

describe('saving a section', () => {
    it('sends only the section\'s changed paths with the version it read, then adopts the answer and draws that section again', async () => {
        const s = session();
        s.edit('identity.niche', 'Strength');
        s.edit('voice.emoji', 'none'); // another section's edit: not this save's business
        await s.TP.save(s.form, null);
        assert.deepEqual(s.calls, [{ id: 'tenant-1', body: { version: 3, patch: { identity: { niche: 'Strength' } } } }]);
        assert.equal(plain<Json>(s.TP.state).version, 4);
        assert.equal(s.TP.base['identity.niche'], 'Strength', 'the next save is measured against what was saved');
        assert.deepEqual(s.paints.section.map((p) => p.section), ['identity']);
        assert.equal(s.paints.section[0]!.values['identity.niche'], 'Strength');
        assert.equal(s.paints.meta, 1);
        assert.equal(s.toasts.at(-1)!.type, undefined, 'a success toast');
        // The next save sends the NEW version, and the other section's edit is still its own to save.
        s.use('voice');
        await s.TP.save(s.form, null);
        assert.deepEqual(s.calls[1]!.body, { version: 4, patch: { voice: { emoji: 'none' } } });
    });

    it('sends nothing when nothing changed, and says so', async () => {
        const s = session();
        await s.TP.save(s.form, null);
        assert.deepEqual(s.calls, []);
        assert.equal(s.toasts.at(-1)!.message, s.t('tenantProfile.noChanges'));
    });

    it('a profile that is not stored yet sends version null (the virtual profile), as the server expects', async () => {
        const s = session(rich(), { version: null, stored: false });
        s.edit('identity.niche', 'x');
        await s.TP.save(s.form, null);
        assert.equal(s.calls[0]!.body.version, null);
    });

    it('shows the server\'s problems, one by one, and keeps what was typed', async () => {
        const s = session();
        s.edit('identity.role', 'x'.repeat(41));
        s.respond(() => { throw fail(400, { error: '2 problems', code: 'PROFILE_INVALID', problems: ['identity.role is 41 characters; the limit is 40', 'voice.emoji must be one of none, light, rich'] }); });
        await s.TP.save(s.form, null);
        assert.deepEqual(s.paints.problems, [['identity.role is 41 characters; the limit is 40', 'voice.emoji must be one of none, light, rich']]);
        assert.deepEqual(s.paints.section, [], 'the form is not redrawn: nothing typed is lost');
        assert.equal(plain<Json>(s.TP.state).version, 3);
        assert.equal(s.button.disabled, false, 'and Save works again');
    });

    it('a failure with no detail is shown as the error it is', async () => {
        const s = session();
        s.edit('identity.niche', 'x');
        s.respond(() => { throw fail(500, { error: 'Failed to save the profile.' }); });
        await s.TP.save(s.form, null);
        assert.deepEqual(s.paints.problems, [['Failed to save the profile.']]);
        assert.equal(s.toasts.at(-1)!.type, 'error');
    });

    it('does nothing for a tenant that was left while the request was out', async () => {
        const s = session();
        s.edit('identity.niche', 'x');
        s.respond(() => { s.TP.unmount(); return STATE(rich(), { version: 4 }); });
        await s.TP.save(s.form, null);
        assert.deepEqual(s.paints.section, []);
        assert.equal(s.paints.meta, 0);
    });
});

describe('a version conflict', () => {
    it('keeps the admin\'s edits on screen, says the profile changed elsewhere, and blocks Save until a reload', async () => {
        const s = session();
        s.edit('identity.niche', 'My niche');
        s.respond(() => { throw fail(409, { error: 'The profile changed since you opened it.', code: 'PROFILE_VERSION_CONFLICT', currentVersion: 5 }); });
        await s.TP.save(s.form, null);
        assert.deepEqual(s.paints.conflict, [5]);
        assert.deepEqual(plain(s.TP.conflict), { currentVersion: 5 });
        assert.deepEqual(s.paints.section, [], 'no section is redrawn');
        assert.deepEqual(s.paints.all, [], 'and neither is the editor: the forms (and what is typed in them) are untouched');
        assert.equal(s.TP.state.version, 3, 'what it read stays what it read');
        // Saving again would only lose again: nothing is sent.
        await s.TP.save(s.form, null);
        assert.equal(s.calls.length, 1);
        // The banner says what happened, and offers both ways out.
        const banner = String(s.TP.conflictMarkup(s.TP.conflict));
        assert.ok(banner.includes(s.t('tenantProfile.conflictTitle')));
        assert.ok(banner.includes(s.t('tenantProfile.conflictBody', { version: 5 })));
        assert.match(banner, /data-action="tenantProfile:reloadKeep"/);
        assert.match(banner, /data-action="tenantProfile:reloadDiscard"/);
        assert.equal(s.t('tenantProfile.conflictTitle'), 'Changed elsewhere');
        assert.match(s.t('tenantProfile.conflictBody', { version: 5 }), /edits are still in the forms below/);
    });

    it('also when the server cannot say which version: a null', async () => {
        const s = session(rich(), { version: null, stored: false });
        s.edit('identity.niche', 'x');
        s.respond(() => { throw fail(409, { error: 'x', code: 'PROFILE_VERSION_CONFLICT', currentVersion: null }); });
        await s.TP.save(s.form, null);
        assert.deepEqual(plain(s.TP.conflict), { currentVersion: null });
        assert.ok(String(s.TP.conflictMarkup(s.TP.conflict)).includes(s.t('tenantProfile.conflictBodyNone')));
    });

    it('Reload and keep my edits: the latest is shown, and only what the admin changed goes back on top of it', async () => {
        const s = session();
        s.edit('identity.niche', 'My niche');
        s.edit('voice.emoji', 'none');
        s.respond(() => { throw fail(409, { error: 'x', code: 'PROFILE_VERSION_CONFLICT', currentVersion: 5 }); });
        await s.TP.save(s.form, null);
        const latest = rich();
        latest.identity.role = 'strength coach'; // someone else's change, in a field the admin did not touch
        latest.identity.niche = 'Their niche'; // and one in a field the admin did
        s.API.getAdminTenantProfile = async () => STATE(latest, { version: 5 });
        await s.TP.reload(true);
        assert.equal(s.paints.all.length, 1);
        const shown = s.paints.all[0]!;
        assert.equal(shown['identity.role'], 'strength coach', 'what someone else saved is shown');
        assert.equal(shown['identity.niche'], 'My niche', 'what the admin typed is kept over it');
        assert.equal(shown['voice.emoji'], 'none');
        assert.equal(shown['content.domain'], 'general', 'an untouched field is the latest\'s');
        assert.equal(s.TP.state.version, 5);
        assert.equal(s.TP.conflict, null, 'Save works again');
        assert.equal(s.TP.base['identity.niche'], 'Their niche', 'and "changed" is measured against the latest');
        assert.equal(s.toasts.at(-1)!.message, s.t('tenantProfile.reloadedKept'));
        // The next save is the admin's two changes at the new version.
        s.redraw();
        s.edit('identity.niche', 'My niche');
        s.edit('voice.emoji', 'none');
        await s.TP.save(s.form, null);
        assert.deepEqual(s.calls.at(-1)!.body, { version: 5, patch: { identity: { niche: 'My niche' } } });
    });

    it('Reload and drop my edits: the forms start over from the latest', async () => {
        const s = session();
        s.edit('identity.niche', 'My niche');
        s.respond(() => { throw fail(409, { error: 'x', code: 'PROFILE_VERSION_CONFLICT', currentVersion: 5 }); });
        await s.TP.save(s.form, null);
        const latest = rich();
        latest.identity.niche = 'Their niche';
        s.API.getAdminTenantProfile = async () => STATE(latest, { version: 5 });
        await s.TP.reload(false);
        assert.equal(s.paints.all[0]!['identity.niche'], 'Their niche');
        assert.equal(s.toasts.at(-1)!.message, s.t('tenantProfile.reloaded'));
    });

    it('a reload that fails says so and leaves the forms and the conflict as they were', async () => {
        const s = session();
        s.edit('identity.niche', 'x');
        s.respond(() => { throw fail(409, { error: 'x', code: 'PROFILE_VERSION_CONFLICT', currentVersion: 5 }); });
        await s.TP.save(s.form, null);
        s.API.getAdminTenantProfile = async () => { throw new Error('offline'); };
        await s.TP.reload(true);
        assert.equal(s.paints.all.length, 0);
        assert.deepEqual(plain(s.TP.conflict), { currentVersion: 5 });
        assert.equal(s.toasts.at(-1)!.type, 'error');
    });
});

describe('the platform owner\'s rule', () => {
    it('asks before it sends, and only a yes sends confirm_remove_owner_rule: the same patch, at the same version', async () => {
        const s = session(rich(), { isPlatformOwner: true });
        s.use('content');
        s.edit('content.rules', []);
        s.respond(() => { throw fail(409, { error: 'This is the platform owner\'s profile…', code: 'OWNER_RULE_LOCKED' }); });
        await s.TP.save(s.form, null);
        assert.equal(s.calls.length, 1);
        assert.deepEqual(s.calls[0]!.body, { version: 3, patch: { content: { rules: [] } } }, 'the first send carries no confirmation');
        assert.equal(s.confirms.length, 1, 'the dialog is asked');
        const dialog = s.confirms[0]!;
        assert.equal(dialog.title, s.t('tenantProfile.ownerLockedTitle'));
        assert.equal(dialog.confirmLabel, s.t('tenantProfile.ownerLockedConfirm'));
        assert.equal(dialog.confirmIcon, 'alert-triangle');
        assert.equal(s.paints.conflict.length, 0, 'it is not a version conflict');
        assert.deepEqual(s.paints.problems, [], 'and not a validation problem');
        // Saying yes sends it again, with the confirmation and nothing else different.
        s.respond((body) => STATE(mergePatch(s.TP.state.profile, body.patch) as CreatorProfile, { version: 4, isPlatformOwner: true }));
        await dialog.onConfirm();
        assert.equal(s.calls.length, 2);
        assert.deepEqual(s.calls[1]!.body, { version: 3, patch: { content: { rules: [] } }, confirm_remove_owner_rule: true });
        assert.equal(s.TP.state.version, 4);
    });

    it('a plain save never carries the confirmation, whatever it changes', async () => {
        const s = session(rich(), { isPlatformOwner: true });
        s.edit('identity.niche', 'x');
        await s.TP.save(s.form, null);
        assert.ok(!('confirm_remove_owner_rule' in s.calls[0]!.body));
    });

    it('is said on the rule\'s own checkbox when it is the owner\'s profile, and nowhere else', () => {
        const owner = String(mounted(rich(), { isPlatformOwner: true }).markup());
        const other = String(mounted(rich(), { isPlatformOwner: false }).markup());
        const { t } = load();
        assert.ok(owner.includes(plainEscape(t('tenantProfile.ownerRuleHint'))));
        assert.ok(!other.includes(plainEscape(t('tenantProfile.ownerRuleHint'))));
        assert.match(owner, /id="tp-content-rules-owner"/);
        assert.match(owner, /<fieldset[^>]*aria-describedby="[^"]*tp-content-rules-owner[^"]*"/);
    });
});

describe('opening and leaving the editor', () => {
    it('mounting reads the profile once and draws it; a second tenant\'s late answer never draws over the first', async () => {
        const l = load();
        const { TP, API } = l;
        const first = Promise.withResolvers<Json>();
        API.getAdminTenantProfile = (id: string) => (id === 'a' ? first.promise : Promise.resolve(STATE(rich(), { version: 9 })));
        const painted: Json[] = [];
        TP.paintAll = (values: Json) => { painted.push(plain(values)); };
        const hostA = { innerHTML: '', isConnected: true };
        const hostB = { innerHTML: '', isConnected: true };
        const a = TP.mount(hostA, { id: 'a', name: 'A' });
        await TP.mount(hostB, { id: 'b', name: 'B' });
        first.resolve(STATE(rich(), { version: 1 }));
        await a;
        assert.equal(painted.length, 1, 'only the editor on screen was drawn');
        assert.equal(TP.state.version, 9);
        assert.equal(TP.tenantId, 'b');
    });

    it('a profile that cannot be read says why, with a retry, and draws no form', async () => {
        const l = load();
        l.API.getAdminTenantProfile = async () => { throw Object.assign(new Error('The profile tables are missing'), { status: 503 }); };
        const host = { innerHTML: '', isConnected: true };
        await l.TP.mount(host, { id: 'a', name: 'A' });
        assert.ok(host.innerHTML.includes('The profile tables are missing'));
        assert.match(host.innerHTML, /data-action="tenantProfile:retry"/);
        assert.ok(!/<form/.test(host.innerHTML));
    });

    it('unmounting forgets the tenant, so an answer still on its way draws nothing', async () => {
        const l = load();
        const gate = Promise.withResolvers<Json>();
        l.API.getAdminTenantProfile = () => gate.promise;
        let painted = 0;
        l.TP.paintAll = () => { painted += 1; };
        const pending = l.TP.mount({ innerHTML: '', isConnected: true }, { id: 'a', name: 'A' });
        l.TP.unmount();
        gate.resolve(STATE(rich()));
        await pending;
        assert.equal(painted, 0);
        assert.equal(l.TP.state, null);
    });
});
