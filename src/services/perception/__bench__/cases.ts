/**
 * The benchmark's cases: read from `scripts/eval-muse/cases.json` and checked as strictly as a schema, the way the DM sales evaluation checks its conversations
 * (`dmSales/__evals__/cases.ts`, whose expectation parser is reused here). They are data the owner edits, so a typo (an action that is not one, a pattern that does
 * not compile, a file name with a slash in it, an offer the fixture does not have) is a loud error at load time naming the case and the field, never a case that
 * quietly checks nothing.
 *
 * What the file holds: the media cases, the memory questions (`memory`) and what the open-weights comparison reads one reel's analysis against (`open_weights`).
 * No media is in the repo: a case names a file, and the file is read from `--media-dir` at run time. A file that is not there is a case that is SKIPPED, by name and
 * with the reason, and never one that silently passes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseExpect, Problems } from '../../dmSales/__evals__/cases.js';
import { resolveFixture } from '../../dmSales/__evals__/fixtures.js';
import { assertFixture, EvalRefusal } from '../../dmSales/__evals__/refusal.js';
import { VARIETIES, type TurnExpectation } from '../../dmSales/__evals__/types.js';
import { NO_OFFER, type NextAction } from '../../dmSales/types.js';
import { MEDIA_LIMITS, type MediaKind } from '../media.js';
import { isSyntheticCard, syntheticMedia } from './synthetic.js';
import {
    CASE_KINDS, EXPECTABLE_ACTIONS, type CaseExpectation, type CaseKind, type CaseSource, type ExpectableAction, type MemoryQuestion, type MuseCase, type OpenWeightsSpec,
    type ParsedCases, type Understood,
} from './types.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The next actions each thing a case may expect stands for, in the sales turn's own words. The model's `next_action` is held to them. */
const NEXT_ACTIONS_OF: Readonly<Partial<Record<ExpectableAction, readonly NextAction[]>>> = Object.freeze({
    answer: ['reply', 'ask_qualifier'],
    recommend: ['recommend', 'send_link'],
    handoff: ['handoff'],
});

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** What a file's extension says it is. Only these are read; anything else is a typo in the case. */
const EXTENSIONS: Readonly<Record<string, { mime: string; media: MediaKind }>> = Object.freeze({
    '.png': { mime: 'image/png', media: 'image' },
    '.jpg': { mime: 'image/jpeg', media: 'image' },
    '.jpeg': { mime: 'image/jpeg', media: 'image' },
    '.webp': { mime: 'image/webp', media: 'image' },
    '.mp4': { mime: 'video/mp4', media: 'video' },
    '.mov': { mime: 'video/quicktime', media: 'video' },
    '.m4a': { mime: 'audio/mp4', media: 'audio' },
    '.wav': { mime: 'audio/wav', media: 'audio' },
});

/** The kind of media each case kind is made of. */
const MEDIA_OF_KIND: Readonly<Record<CaseKind, MediaKind>> = Object.freeze({ image: 'image', video: 'video', story_mention: 'image', reel: 'video', voice: 'audio' });

function parseSource(p: Problems, raw: unknown, kind: CaseKind | null, owner: 'own' | 'other' | null): CaseSource | null {
    if (!isObj(raw)) {
        p.add('source', 'must be an object: {file}, {synthetic} or {caption}');
        return null;
    }
    for (const key of Object.keys(raw)) if (!['file', 'synthetic', 'caption'].includes(key)) p.add('source', `${key} is not a source field (file, synthetic, caption)`);
    const has = ['file', 'synthetic'].filter((k) => raw[k] !== undefined);
    if (has.length > 1) {
        p.add('source', 'is either a file or a synthetic card, not both');
        return null;
    }
    const caption = raw.caption === undefined ? null : typeof raw.caption === 'string' && raw.caption.trim() ? raw.caption.trim() : null;
    if (raw.caption !== undefined && caption === null) p.add('source.caption', 'must be text');

    if (raw.synthetic !== undefined) {
        if (!isSyntheticCard(raw.synthetic)) {
            p.add('source.synthetic', 'must be id_card or story_card');
            return null;
        }
        if (kind !== null && kind !== 'image' && kind !== 'story_mention') p.add('source.synthetic', 'a synthetic card is a picture: kind image or story_mention');
        if (caption !== null) p.add('source.caption', 'a synthetic card has no caption');
        return { kind: 'synthetic', card: raw.synthetic };
    }
    if (raw.file !== undefined) {
        if (typeof raw.file !== 'string' || !FILE_NAME.test(raw.file) || raw.file.includes('..')) {
            p.add('source.file', 'must be a plain file name (letters, digits, dot, dash, underscore): it is read from --media-dir');
            return null;
        }
        const ext = EXTENSIONS[path.extname(raw.file).toLowerCase()];
        if (!ext) {
            p.add('source.file', `${raw.file} is not a picture, video or audio file this benchmark reads (${Object.keys(EXTENSIONS).join(', ')})`);
            return null;
        }
        if (kind !== null && ext.media !== MEDIA_OF_KIND[kind]) p.add('source.file', `${raw.file} is ${ext.media}, and a case of kind ${kind} is ${MEDIA_OF_KIND[kind]}`);
        if (caption !== null && kind !== 'reel') p.add('source.caption', 'only a reel carries a caption');
        if (owner === 'other') p.add('source', 'another creator\'s reel has no file: an Instagram DM carries only its caption');
        return { kind: 'file', file: raw.file, caption };
    }
    if (caption !== null) {
        if (kind !== null && kind !== 'reel') p.add('source', 'a caption alone is a reel by another creator');
        if (owner !== null && owner !== 'other') p.add('source', 'a caption alone is another creator\'s reel: owner must be "other"');
        return { kind: 'caption', caption };
    }
    p.add('source', 'needs a file, a synthetic card or a caption');
    return null;
}

function parseUnderstood(p: Problems, raw: unknown): Understood | null {
    if (raw === 'unreadable') return { mode: 'unreadable' };
    if (raw === 'personal') return { mode: 'personal' };
    if (isObj(raw) && Object.keys(raw).length === 1 && Array.isArray(raw.shows)) {
        const groups = raw.shows as unknown[];
        const ok = groups.length > 0 && groups.every((g) => Array.isArray(g) && g.length > 0 && g.every((w) => typeof w === 'string' && w.trim() !== ''));
        if (!ok) {
            p.add('understood.shows', 'must be a non-empty list of non-empty lists of words');
            return null;
        }
        return { mode: 'shows', groups: (groups as string[][]).map((g) => g.map((w) => w.trim())) };
    }
    p.add('understood', 'must be "unreadable", "personal" or {shows: [[word, ...], ...]}');
    return null;
}

function compile(p: Problems, field: string, list: unknown): string[] {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || s === '')) {
        p.add(field, 'must be a list of regular expressions');
        return [];
    }
    for (const source of list as string[]) {
        try {
            new RegExp(source, 'iu');
        } catch (err) {
            p.add(field, `/${source}/ does not compile (${err instanceof Error ? err.message : String(err)})`);
        }
    }
    return list as string[];
}

function parseExpectation(p: Problems, raw: unknown, offerIds: ReadonlySet<string> | null): CaseExpectation | null {
    if (!isObj(raw)) {
        p.add('expect', 'must be an object');
        return null;
    }
    const { action, forbid, ...rest } = raw;
    const actions: ExpectableAction[] = [];
    if (!Array.isArray(action) || action.length === 0) p.add('expect.action', `must be a non-empty list of ${EXPECTABLE_ACTIONS.join(', ')}`);
    else {
        for (const a of action) {
            if (typeof a === 'string' && (EXPECTABLE_ACTIONS as readonly string[]).includes(a)) actions.push(a as ExpectableAction);
            else p.add('expect.action', `${JSON.stringify(a)} is not something a case may expect (${EXPECTABLE_ACTIONS.join(', ')})`);
        }
    }
    const forbidden = compile(p, 'expect.forbid', forbid);
    const turn: TurnExpectation = parseExpect(p, rest, offerIds);
    // The sales turn's own `next_action` is what holds a model-decided turn to the action a case asks for. An explicit one in the file wins.
    if (!turn.next_action && actions.length > 0) {
        const wanted = actions.flatMap((a) => NEXT_ACTIONS_OF[a] ?? []);
        if (wanted.length > 0 && actions.every((a) => NEXT_ACTIONS_OF[a])) turn.next_action = [...new Set(wanted)];
    }
    return { action: actions, turn, forbid: forbidden };
}

/** One case from its parsed JSON, or everything wrong with it. */
export function parseMuseCase(raw: unknown, where: string): { case: MuseCase } | { problems: string[] } {
    const p = new Problems(where);
    if (!isObj(raw)) return { problems: [`${where}: must be an object`] };
    const known = new Set(['id', 'title', 'kind', 'owner', 'source', 'typed', 'fixture', 'writes', 'prior_ack', 'reference', 'understood', 'expect', 'note']);
    for (const key of Object.keys(raw)) if (!known.has(key)) p.add(key, 'is not a field of a case');

    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) p.add('id', 'must be lower-case words joined by dashes, like "reel-own-riyal"');
    if (typeof raw.title !== 'string' || !raw.title.trim()) p.add('title', 'must be text');

    const kind = typeof raw.kind === 'string' && (CASE_KINDS as readonly string[]).includes(raw.kind) ? (raw.kind as CaseKind) : null;
    if (!kind) p.add('kind', `must be one of ${CASE_KINDS.join(', ')}`);
    let owner: 'own' | 'other' | null = null;
    if (raw.owner !== undefined) {
        if (raw.owner === 'own' || raw.owner === 'other') owner = raw.owner;
        else p.add('owner', 'must be "own" or "other"');
        if (kind !== null && kind !== 'reel') p.add('owner', 'only a reel is the account\'s own or another creator\'s');
    } else if (kind === 'reel') {
        p.add('owner', 'a reel is "own" or "other"');
    }

    const source = parseSource(p, raw.source, kind, owner);
    if (kind === 'reel' && owner === 'own' && source && source.kind !== 'file') p.add('source', 'the account\'s own reel is a file: it is watched');

    let typed: string | null = null;
    if (raw.typed !== undefined && raw.typed !== null) {
        if (typeof raw.typed === 'string' && raw.typed.trim()) typed = raw.typed.trim();
        else p.add('typed', 'must be text, or null for nothing typed');
    }
    if (typed !== null && (kind === 'story_mention' || kind === 'voice')) p.add('typed', `a ${kind === 'voice' ? 'voice note' : 'story mention'} comes with no typed words`);

    let fixture: MuseCase['fixture'] | null = null;
    try {
        fixture = assertFixture(raw.fixture, `${where} fixture`);
    } catch (err) {
        p.list.push(err instanceof EvalRefusal ? err.message : String(err));
    }
    const writes = typeof raw.writes === 'string' && (VARIETIES as readonly string[]).includes(raw.writes) ? (raw.writes as MuseCase['writes']) : null;
    if (!writes) p.add('writes', `must be one of ${VARIETIES.join(', ')}`);

    if (raw.prior_ack !== undefined && typeof raw.prior_ack !== 'boolean') p.add('prior_ack', 'must be true or false');
    let reference: string | null = null;
    if (raw.reference !== undefined) {
        if (typeof raw.reference === 'string' && raw.reference.trim() && kind === 'voice') reference = raw.reference.trim();
        else p.add('reference', 'must be text, and only a voice note has one');
    }

    const understood = parseUnderstood(p, raw.understood);
    const offerIds = fixture ? new Set(resolveFixture(fixture).ctx.offers.map((o) => o.id)) : null;
    const expectation = parseExpectation(p, raw.expect, offerIds);

    // Rules that keep a case honest about what it can show.
    if (expectation) {
        const wants = new Set(expectation.action);
        if (wants.has('resend') && understood?.mode !== 'unreadable') p.add('expect.action', 'resend is for a picture that cannot be read: understood must be "unreadable"');
        if (understood?.mode === 'unreadable' && (wants.size !== 1 || !wants.has('resend'))) p.add('expect.action', 'an unreadable picture is answered by asking for it again: action must be just "resend"');
        if (wants.has('thank_named') && kind !== 'story_mention') p.add('expect.action', 'thank_named is for a story mention');
        if (kind === 'story_mention' && !(wants.size === 1 && wants.has('thank_named'))) p.add('expect.action', 'a story mention is thanked by name: action must be just "thank_named"');
        if (understood?.mode === 'personal' && !(wants.size === 1 && wants.has('handoff'))) p.add('expect.action', 'a personal document goes to a person: action must be just "handoff"');
        for (const id of expectation.turn.offer_id ?? []) if (id !== NO_OFFER && offerIds && !offerIds.has(id)) p.add('expect.offer_id', `${id} is not an offer of ${fixture}`);
    }

    if (p.list.length > 0 || !kind || !source || !fixture || !writes || !understood || !expectation) return { problems: p.list.length > 0 ? p.list : [`${where}: incomplete`] };
    return {
        case: {
            id, title: raw.title as string, kind, owner, source, typed, fixture, writes, priorAck: raw.prior_ack === true, reference, understood, expect: expectation,
            note: typeof raw.note === 'string' ? raw.note : null,
        },
    };
}

function parseMemory(raw: unknown): { questions: MemoryQuestion[]; problems: string[] } {
    const problems: string[] = [];
    const questions: MemoryQuestion[] = [];
    if (raw === undefined) return { questions, problems };
    if (!Array.isArray(raw)) return { questions, problems: ['memory: must be a list of questions'] };
    const seen = new Set<string>();
    raw.forEach((q, i) => {
        const p = new Problems(`memory[${i}]`);
        if (!isObj(q)) {
            problems.push(`memory[${i}]: must be an object`);
            return;
        }
        for (const key of Object.keys(q)) if (!['id', 'ask', 'visual_only', 'expect'].includes(key)) p.add(key, 'is not a field of a question');
        const id = typeof q.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(q.id) ? q.id : '';
        if (!id) p.add('id', 'must be lower-case words joined by dashes');
        else if (seen.has(id)) p.add('id', 'is used twice');
        seen.add(id);
        if (typeof q.ask !== 'string' || !q.ask.trim()) p.add('ask', 'must be text');
        if (typeof q.visual_only !== 'boolean') p.add('visual_only', 'must be true or false');
        let expect: MemoryQuestion['expect'] | null = null;
        if (isObj(q.expect) && q.expect.none === true && Object.keys(q.expect).length === 1) expect = { none: true };
        else if (isObj(q.expect) && Object.keys(q.expect).length === 1 && Array.isArray(q.expect.reel)) {
            const groups = q.expect.reel as unknown[];
            if (groups.length > 0 && groups.every((g) => Array.isArray(g) && g.length > 0 && g.every((w) => typeof w === 'string' && w.trim() !== ''))) {
                expect = { reel: (groups as string[][]).map((g) => g.map((w) => w.trim())) };
            }
        }
        if (!expect) p.add('expect', 'must be {none: true} or {reel: [[word, ...], ...]}: the right reel is the one whose analysis has a word of every group');
        problems.push(...p.list);
        if (p.list.length === 0 && expect) questions.push({ id, ask: (q.ask as string).trim(), visualOnly: q.visual_only as boolean, expect });
    });
    return { questions, problems };
}

function parseOpenWeights(raw: unknown): { spec: OpenWeightsSpec | null; problems: string[] } {
    if (raw === undefined) return { spec: null, problems: [] };
    const p = new Problems('open_weights');
    if (!isObj(raw)) return { spec: null, problems: ['open_weights: must be an object'] };
    for (const key of Object.keys(raw)) if (!['file', 'duration_s', 'facts'].includes(key)) p.add(key, 'is not a field');
    const file = typeof raw.file === 'string' && FILE_NAME.test(raw.file) && EXTENSIONS[path.extname(raw.file).toLowerCase()]?.media === 'video' ? raw.file : null;
    if (!file) p.add('file', 'must be a plain video file name, read from --media-dir');
    const duration = typeof raw.duration_s === 'number' && Number.isFinite(raw.duration_s) && raw.duration_s > 0 ? raw.duration_s : null;
    if (duration === null) p.add('duration_s', 'must be the reel\'s length in seconds');
    const facts: OpenWeightsSpec['facts'] = [];
    if (!Array.isArray(raw.facts) || raw.facts.length === 0) p.add('facts', 'must be a non-empty list of {name, any: [word, ...]}');
    else {
        for (const [i, f] of raw.facts.entries()) {
            if (isObj(f) && typeof f.name === 'string' && f.name.trim() && Array.isArray(f.any) && f.any.length > 0 && f.any.every((w) => typeof w === 'string' && w.trim() !== '')) {
                facts.push({ name: f.name.trim(), any: (f.any as string[]).map((w) => w.trim()) });
            } else p.add(`facts[${i}]`, 'must be {name, any: [word, ...]}');
        }
    }
    if (p.list.length > 0 || !file || duration === null) return { spec: null, problems: p.list };
    return { spec: { file, durationS: duration, facts }, problems: [] };
}

/** What `cases.json` holds, parsed. Every problem in the file is in the one error it throws. */
export function parseCasesFile(raw: unknown): ParsedCases {
    const problems: string[] = [];
    if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.cases)) throw new Error('The Muse benchmark cases are not valid:\n  the file must be {version: 1, cases: [...], memory?: [...], open_weights?: {...}}');
    for (const key of Object.keys(raw)) if (!['version', 'cases', 'memory', 'open_weights'].includes(key)) problems.push(`${key}: is not a section of the cases file`);

    const cases: MuseCase[] = [];
    const ids = new Set<string>();
    for (const [i, c] of raw.cases.entries()) {
        const label = isObj(c) && typeof c.id === 'string' ? `case ${c.id}` : `cases[${i}]`;
        const parsed = parseMuseCase(c, label);
        if ('problems' in parsed) problems.push(...parsed.problems);
        else {
            if (ids.has(parsed.case.id)) problems.push(`${label}: the id is used twice`);
            ids.add(parsed.case.id);
            cases.push(parsed.case);
        }
    }
    const memory = parseMemory(raw.memory);
    problems.push(...memory.problems);
    const open = parseOpenWeights(raw.open_weights);
    problems.push(...open.problems);
    if (problems.length > 0) throw new Error(`The Muse benchmark cases are not valid:\n  ${problems.join('\n  ')}`);
    return { cases, memory: memory.questions, openWeights: open.spec };
}

/** Reads and checks the cases file. */
export function loadCasesFile(file: string): ParsedCases {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`The Muse benchmark cases could not be read from ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parseCasesFile(raw);
}

/**
 * The cases a `--cases` list names: an id, or the start of one ("reel-own"), comma-separated. A name that matches nothing is an error, never an empty run (an empty run
 * would pass).
 */
export function selectMuseCases(all: readonly MuseCase[], spec: string | undefined): MuseCase[] {
    if (spec === undefined || spec.trim() === '' || spec.trim().toLowerCase() === 'all') return [...all];
    const chosen = new Set<MuseCase>();
    for (const token of spec.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)) {
        const hits = all.filter((c) => c.id === token || c.id.startsWith(token));
        if (hits.length === 0) throw new Error(`no case matches "${token.slice(0, 40)}" (use --list to see them)`);
        for (const h of hits) chosen.add(h);
    }
    return all.filter((c) => chosen.has(c));
}

// ─── The media ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LoadedMedia {
    bytes: Buffer;
    mime: string;
    mediaKind: MediaKind;
}

/** A file read, or why it could not be: a missing file is the case's skip, with the name of what was looked for. */
export type MediaLoad = { ok: true; media: LoadedMedia } | { ok: false; why: string };

export interface MediaIo {
    readFile(file: string): Promise<Buffer>;
}

/**
 * The media of a case: its file from `dir`, its synthetic card, or nothing for a caption alone. The size caps are the product's own (`MEDIA_LIMITS`): a file the
 * product would refuse is not benchmarked as though it were read.
 */
export async function loadMedia(c: MuseCase, dir: string, io: MediaIo): Promise<MediaLoad | null> {
    if (c.source.kind === 'caption') return null;
    if (c.source.kind === 'synthetic') {
        const m = syntheticMedia(c.source.card);
        return { ok: true, media: { bytes: m.bytes, mime: m.mime, mediaKind: 'image' } };
    }
    const ext = EXTENSIONS[path.extname(c.source.file).toLowerCase()]!;
    let bytes: Buffer;
    try {
        bytes = await io.readFile(path.join(dir, c.source.file));
    } catch {
        return { ok: false, why: `${c.source.file} is not in the media folder (${displayPath(dir)})` };
    }
    if (bytes.length === 0) return { ok: false, why: `${c.source.file} is empty` };
    if (bytes.length > MEDIA_LIMITS[ext.media]) {
        return { ok: false, why: `${c.source.file} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, over the ${(MEDIA_LIMITS[ext.media] / 1024 / 1024).toFixed(0)} MB the product reads` };
    }
    return { ok: true, media: { bytes, mime: ext.mime, mediaKind: ext.media } };
}

/** A folder as it may be printed in a public report: the home directory is `~`, so no user name is in it. */
export function displayPath(p: string, home?: string): string {
    const h = home ?? process.env.HOME ?? '';
    return h && p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}

/** The extension table, for the code that reads a memory or open-weights file the same way. */
export function mimeOfFile(file: string): { mime: string; media: MediaKind } | null {
    return EXTENSIONS[path.extname(file).toLowerCase()] ?? null;
}
