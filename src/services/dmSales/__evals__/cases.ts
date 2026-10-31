/**
 * The golden conversations (docs/DM_SALES_PLAN.md §11): read from `conversations/*.json`, one file per case, and checked as strictly
 * as a schema. They are data an owner edits, so a typo in one (an action that is not an action, a pattern that does not compile, a
 * fixture that is a tenant id) is a loud error at load time naming the file and the field, never a case that quietly checks nothing.
 *
 * Pure apart from reading that folder.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDOFF_REASONS, INTENTS, NEXT_ACTIONS, NO_OFFER, STAGES } from '../types.js';
import { assertFixture } from './refusal.js';
import { ROUTES, SENT_KINDS, SOFT_CRITERIA, VARIETIES, type EvalCase, type EvalTurn, type SoftCriterion, type TurnExpectation } from './types.js';

export const CONVERSATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'conversations');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const PREFILTER_SIGNALS = ['refund', 'complaint', 'opt_out', 'abuse'] as const;
const CLAIM_KINDS = ['discount', 'coupon', 'free'] as const;
const KEYS_OF_EXPECT = new Set([
    'route', 'prefilter', 'sent', 'next_action', 'intent', 'stage', 'handoff_reason', 'offer_id', 'reply_language', 'must', 'must_not', 'allow_claim_words', 'soft', 'note',
]);

/** Collects what is wrong, so one load reports all of it. */
export class Problems {
    readonly list: string[] = [];
    constructor(private readonly where: string) {}
    add(field: string, message: string): void {
        this.list.push(`${this.where} ${field}: ${message}`);
    }
}

function listOf<T extends string>(p: Problems, field: string, value: unknown, allowed: readonly T[] | null): T[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0) {
        p.add(field, 'must be a non-empty list');
        return undefined;
    }
    const bad = value.filter((v) => typeof v !== 'string' || (allowed !== null && !(allowed as readonly string[]).includes(v)));
    if (bad.length > 0) p.add(field, `${bad.map((b) => JSON.stringify(b)).join(', ')} not allowed${allowed ? ` (one of ${allowed.join(', ')})` : ''}`);
    return value as T[];
}

function patterns(p: Problems, field: string, value: unknown): string[] | undefined {
    const list = listOf<string>(p, field, value, null);
    for (const source of list ?? []) {
        try {
            new RegExp(source, 'iu');
        } catch (err) {
            p.add(field, `/${source}/ does not compile (${err instanceof Error ? err.message : String(err)})`);
        }
    }
    return list;
}

export function parseExpect(p: Problems, raw: unknown, offerIds: ReadonlySet<string> | null): TurnExpectation {
    if (!isObj(raw)) {
        p.add('expect', 'must be an object');
        return {};
    }
    for (const key of Object.keys(raw)) if (!KEYS_OF_EXPECT.has(key)) p.add(key, 'is not an expectation (a typo checks nothing)');
    const e: TurnExpectation = {};
    if (raw.route !== undefined) {
        if (typeof raw.route === 'string' && (ROUTES as readonly string[]).includes(raw.route)) e.route = raw.route as TurnExpectation['route'];
        else p.add('route', `must be one of ${ROUTES.join(', ')}`);
    }
    if (raw.prefilter !== undefined) {
        if (typeof raw.prefilter === 'string' && (PREFILTER_SIGNALS as readonly string[]).includes(raw.prefilter)) e.prefilter = raw.prefilter as TurnExpectation['prefilter'];
        else p.add('prefilter', `must be one of ${PREFILTER_SIGNALS.join(', ')}`);
        if ((e.route ?? 'model') !== 'prefilter') p.add('prefilter', 'only a turn with route "prefilter" has a pre-filter signal');
    }
    const sent = listOf(p, 'sent', raw.sent, SENT_KINDS);
    if (sent) e.sent = sent;
    const nextAction = listOf(p, 'next_action', raw.next_action, NEXT_ACTIONS);
    if (nextAction) e.next_action = nextAction;
    const intent = listOf(p, 'intent', raw.intent, INTENTS);
    if (intent) e.intent = intent;
    const stage = listOf(p, 'stage', raw.stage, STAGES);
    if (stage) e.stage = stage;
    const reason = listOf(p, 'handoff_reason', raw.handoff_reason, HANDOFF_REASONS);
    if (reason) e.handoff_reason = reason;
    const offers = listOf<string>(p, 'offer_id', raw.offer_id, null);
    if (offers) {
        e.offer_id = offers;
        const unknown = offerIds ? offers.filter((id) => id !== NO_OFFER && !offerIds.has(id)) : [];
        if (unknown.length > 0) p.add('offer_id', `${unknown.join(', ')} is not an offer of the fixture`);
    }
    if (raw.reply_language !== undefined) {
        const r = raw.reply_language;
        if (!isObj(r) || typeof r.variety !== 'string' || !(VARIETIES as readonly string[]).includes(r.variety)) p.add('reply_language', `needs {variety: ${VARIETIES.join(' | ')}}`);
        else {
            if (r.lean !== undefined && typeof r.lean !== 'boolean') p.add('reply_language', 'lean must be true or false');
            if (r.lean === true && r.variety !== 'gulf' && r.variety !== 'egyptian') p.add('reply_language', 'lean applies to gulf and egyptian only');
            e.reply_language = { variety: r.variety as NonNullable<TurnExpectation['reply_language']>['variety'], ...(r.lean === true ? { lean: true } : {}) };
        }
    }
    const must = patterns(p, 'must', raw.must);
    if (must) e.must = must;
    const mustNot = patterns(p, 'must_not', raw.must_not);
    if (mustNot) e.must_not = mustNot;
    const claims = listOf(p, 'allow_claim_words', raw.allow_claim_words, CLAIM_KINDS);
    if (claims) e.allow_claim_words = claims;
    const soft = listOf<SoftCriterion>(p, 'soft', raw.soft, SOFT_CRITERIA);
    if (soft) e.soft = soft;
    if (raw.note !== undefined) {
        if (typeof raw.note === 'string') e.note = raw.note;
        else p.add('note', 'must be text');
    }
    return e;
}

/** One case from its parsed JSON, or the list of everything wrong with it. */
export function parseCase(raw: unknown, file: string, offerIdsOf: (fixture: string) => ReadonlySet<string> | null = () => null): { case: EvalCase } | { problems: string[] } {
    const p = new Problems(file);
    if (!isObj(raw)) return { problems: [`${file}: must be an object`] };
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!/^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) p.add('id', 'must look like "01-price-gulf"');
    if (id && `${id}.json` !== path.basename(file)) p.add('id', `must match the file name (${path.basename(file)})`);
    if (typeof raw.title !== 'string' || !raw.title.trim()) p.add('title', 'must be text');

    let fixture: EvalCase['fixture'] | undefined;
    try {
        fixture = assertFixture(raw.fixture, `${file} fixture`);
    } catch (err) {
        p.list.push(err instanceof Error ? err.message : String(err));
    }
    if (typeof raw.writes !== 'string' || !(VARIETIES as readonly string[]).includes(raw.writes)) p.add('writes', `must be one of ${VARIETIES.join(', ')}`);

    const offerIds = fixture ? offerIdsOf(fixture) : null;
    const turns: EvalTurn[] = [];
    if (!Array.isArray(raw.turns) || raw.turns.length === 0) p.add('turns', 'must be a non-empty list');
    else {
        for (const [i, t] of raw.turns.entries()) {
            const tp = new Problems(`${file} turns[${i}]`);
            if (!isObj(t)) {
                tp.add('', 'must be an object');
            } else {
                if (typeof t.user !== 'string' || !t.user.trim()) tp.add('user', 'must be text');
                const expect = parseExpect(tp, t.expect, offerIds);
                if (typeof t.user === 'string') turns.push({ user: t.user, expect });
            }
            p.list.push(...tp.list);
        }
    }

    let history: EvalCase['history'];
    if (raw.history !== undefined) {
        const turnsOk = Array.isArray(raw.history) && raw.history.length > 0 && raw.history.every((h) => isObj(h) && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string' && h.text.trim() !== '');
        if (!turnsOk) p.add('history', 'must be a list of {role: user | model, text}');
        else {
            const list = raw.history as { role: 'user' | 'model'; text: string }[];
            if (list[0]!.role !== 'user') p.add('history', 'must start with a user turn (Anthropic needs one first)');
            if (list.some((h, i) => i > 0 && h.role === list[i - 1]!.role)) p.add('history', 'turns must alternate user and model');
            if (list[list.length - 1]!.role !== 'model') p.add('history', 'must end with a model turn: the first turn of the case is the next user message');
            history = list;
        }
    }

    let facts: EvalCase['facts'];
    if (raw.facts !== undefined) {
        if (!isObj(raw.facts)) p.add('facts', 'must be an object');
        else {
            const f = raw.facts;
            const stage = f.stage === undefined ? undefined : listOf(p, 'facts.stage', [f.stage], STAGES)?.[0];
            if (f.qualifierTurns !== undefined && !(Number.isInteger(f.qualifierTurns) && (f.qualifierTurns as number) >= 0)) p.add('facts.qualifierTurns', 'must be a whole number');
            const linkSentFor = f.linkSentFor === undefined ? undefined : listOf<string>(p, 'facts.linkSentFor', f.linkSentFor, null);
            if (linkSentFor && offerIds) {
                const unknown = linkSentFor.filter((x) => !offerIds.has(x));
                if (unknown.length > 0) p.add('facts.linkSentFor', `${unknown.join(', ')} is not an offer of the fixture`);
            }
            facts = {
                ...(stage ? { stage } : {}),
                ...(typeof f.qualifierTurns === 'number' ? { qualifierTurns: f.qualifierTurns } : {}),
                ...(linkSentFor ? { linkSentFor } : {}),
            };
        }
    }

    for (const key of Object.keys(raw)) if (!['id', 'title', 'fixture', 'writes', 'turns', 'history', 'facts'].includes(key)) p.add(key, 'is not a field of a case');
    if (p.list.length > 0 || !fixture) return { problems: p.list };
    return { case: { id, title: raw.title as string, fixture, writes: raw.writes as EvalCase['writes'], ...(facts ? { facts } : {}), ...(history ? { history } : {}), turns } };
}

/**
 * Every case in `conversations/`, in file order. `offerIdsOf` (the fixtures' offer ids) lets a case that names an offer the fixture does
 * not have fail here; the harness passes it, and a test that only wants the shape does not need to.
 */
export function loadCases(dir: string = CONVERSATIONS_DIR, offerIdsOf?: (fixture: string) => ReadonlySet<string> | null): EvalCase[] {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const cases: EvalCase[] = [];
    const problems: string[] = [];
    for (const file of files) {
        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
        } catch (err) {
            problems.push(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
            continue;
        }
        const parsed = parseCase(raw, file, offerIdsOf);
        if ('problems' in parsed) problems.push(...parsed.problems);
        else cases.push(parsed.case);
    }
    if (problems.length > 0) throw new Error(`The golden conversations are not valid:\n  ${problems.join('\n  ')}`);
    return cases;
}

/**
 * The cases a `--cases` list names: an id ("05-link-now-gulf"), its number ("5" or "05"), or the start of an id ("link"), comma-separated.
 * A name that matches nothing is an error and not an empty run (an empty run would pass).
 */
export function selectCases(all: readonly EvalCase[], spec: string | undefined): EvalCase[] {
    if (spec === undefined || spec.trim() === '' || spec.trim().toLowerCase() === 'all') return [...all];
    const chosen = new Set<EvalCase>();
    for (const token of spec.split(',').map((t) => t.trim()).filter(Boolean)) {
        const wanted = /^\d{1,2}$/.test(token) ? token.padStart(2, '0') : token.toLowerCase();
        const hits = all.filter((c) => c.id === wanted || c.id.startsWith(/^\d{2}$/.test(wanted) ? `${wanted}-` : wanted) || (!/^\d+$/.test(wanted) && c.id.split('-').slice(1).join('-').startsWith(wanted)));
        if (hits.length === 0) throw new Error(`no case matches "${token}" (use --list to see them)`);
        for (const h of hits) chosen.add(h);
    }
    return all.filter((c) => chosen.has(c));
}
