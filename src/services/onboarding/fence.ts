/**
 * Fencing: how text the platform does not control is put in front of a model (docs/onboarding/03 §3.5).
 * Pure.
 *
 * A bio, a caption or a web page is the creator's, or a stranger's if the address was mistyped. It can
 * say "ignore your instructions", and it can try to END the block it sits in so that what follows reads
 * as the prompt's own words. This module is the part that stops the second, and makes the first harmless
 * to the extent a prompt can:
 *
 *   - `sanitizeSourceText` takes out what a reader cannot see but a model can read (bidi controls,
 *     zero-width characters, the Unicode tag block), then turns EVERY angle bracket into a look-alike that
 *     is not one (`<` to `\u2039`, `>` to `\u203A`, and their full-width, small and angle-quote forms). Not "the tags
 *     we use": all of them. There is then no tag, closing or otherwise, in a source's body for any spelling
 *     of one to be, whatever the case, spacing, entity or split. The cost is that `<3` reads `\u20393`, which a
 *     bio can bear.
 *   - `fenceSource` wraps one source in `<source id="…" kind="…">…</source>`; `fenceSources` wraps them all in
 *     `<untrusted_sources nonce="…">`, the nonce being random per call.
 *   - `verifyFence` checks the finished block: exactly one open and one close of the outer tag, one open and
 *     one close per source, and no angle bracket in any body. `buildDraftPrompt` runs it and refuses to
 *     build a prompt that fails it, so the property does not depend on `sanitizeSourceText` alone.
 *
 * The same cleaned text is what `validateDraft` compares a model's evidence quotes against: "verbatim" means
 * verbatim in what the model was shown. Cleaning twice changes nothing (`sanitizeSourceText` is idempotent).
 */
import { randomBytes } from 'node:crypto';
import { stripInvisible, truncateChars } from './textClean.js';

export const SOURCE_KINDS = ['ig_bio', 'ig_caption', 'site_page', 'link_hub', 'yt_description', 'yt_title', 'typed'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** One piece of text the draft is made from. `id` and `kind` are made by code; `text` is not. */
export interface DraftSource {
    id: string;
    kind: SourceKind;
    text: string;
}

/** The most characters of each kind a model is shown. */
export const SOURCE_CAPS: Readonly<Record<SourceKind, number>> = {
    ig_bio: 600,
    ig_caption: 2200,
    site_page: 3000,
    link_hub: 3000,
    yt_description: 5000,
    yt_title: 200,
    typed: 4000,
};

/** All sources together: past this the later ones are left out, not cut. */
export const TOTAL_SOURCE_CHARS = 60_000;

const ID = /^[a-z0-9_.:-]{1,40}$/;

/** An angle bracket in any of the forms that could pass for one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const OPENERS = /[<\uFF1C\uFE64\u3008\u2329\u276E\u2039]/g;
const CLOSERS = /[>\uFF1E\uFE65\u3009\u232A\u276F\u203A]/g;

/**
 * Text as a model may be shown it: invisible characters out, no angle bracket of any kind, lone surrogates
 * repaired, long runs of blank lines folded, at most `max` characters. Idempotent.
 */
export function sanitizeSourceText(text: string, max: number): string {
    // A lone surrogate (half an emoji) becomes U+FFFD. Written as a pattern, not `toWellFormed`, which older runtimes lack.
    const wellFormed = (typeof text === 'string' ? text : '').replace(LONE_SURROGATE, '\uFFFD');
    const cleaned = stripInvisible(wellFormed)
        .replace(OPENERS, '\u2039')
        .replace(CLOSERS, '\u203A')
        .split('\n')
        .map((line) => line.replace(/[ \t\u00A0]+$/g, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return truncateChars(cleaned, max).trim();
}

/** The cleaned form of a source: what is stored with the draft, shown to the model and quoted against. */
export function cleanSource(source: DraftSource): DraftSource {
    return { id: source.id, kind: source.kind, text: sanitizeSourceText(source.text, SOURCE_CAPS[source.kind] ?? 2000) };
}

/**
 * Cleans a list of sources, drops the empty ones and the repeated ids, and keeps them in order until the
 * total budget is spent. A source that would pass the budget is left out whole.
 */
export function prepareSources(sources: readonly DraftSource[], totalChars = TOTAL_SOURCE_CHARS): DraftSource[] {
    const out: DraftSource[] = [];
    const seen = new Set<string>();
    let used = 0;
    for (const raw of sources) {
        if (!ID.test(raw.id) || seen.has(raw.id) || !SOURCE_KINDS.includes(raw.kind)) continue;
        const clean = cleanSource(raw);
        const size = Array.from(clean.text).length;
        if (size === 0 || used + size > totalChars) continue;
        seen.add(clean.id);
        used += size;
        out.push(clean);
    }
    return out;
}

/** A fresh nonce for one prompt: 96 random bits, hex. */
export const randomNonce = (): string => randomBytes(12).toString('hex');

/** One source in its wrapper. Throws for an `id` or `kind` that code did not make: those are not data. */
export function fenceSource(source: DraftSource): string {
    if (!ID.test(source.id)) throw new Error(`fenceSource: "${String(source.id).slice(0, 40)}" is not a source id`);
    if (!SOURCE_KINDS.includes(source.kind)) throw new Error(`fenceSource: "${String(source.kind).slice(0, 40)}" is not a source kind`);
    const body = sanitizeSourceText(source.text, SOURCE_CAPS[source.kind]);
    return `<source id="${source.id}" kind="${source.kind}">\n${body}\n</source>`;
}

/** The whole block the model reads as data. */
export function fenceSources(sources: readonly DraftSource[], nonce: string): string {
    if (!/^[a-f0-9]{16,64}$/.test(nonce)) throw new Error('fenceSources: the nonce must be random hex');
    return `<untrusted_sources nonce="${nonce}">\n${sources.map(fenceSource).join('\n')}\n</untrusted_sources>`;
}

/**
 * What is wrong with a fenced block, as sentences; empty when it is intact: one outer open (with the
 * nonce) and one outer close, one `<source>` per id in order and nothing between them but their bodies, and no
 * angle bracket in any body.
 */
export function verifyFence(block: string, nonce: string, ids: readonly string[]): string[] {
    const problems: string[] = [];
    const open = `<untrusted_sources nonce="${nonce}">\n`;
    const close = '\n</untrusted_sources>';
    if (!block.startsWith(open)) problems.push('the block does not start with the outer tag');
    if (!block.endsWith(close)) problems.push('the block does not end with the outer tag');
    if (problems.length) return problems;
    const inner = block.slice(open.length, block.length - close.length);
    let rest = inner;
    for (const id of ids) {
        const head = `<source id="${id}" kind="`;
        if (!rest.startsWith(head)) {
            problems.push(`source ${id} is not where it should be`);
            return problems;
        }
        const headEnd = rest.indexOf('">\n');
        const bodyEnd = rest.indexOf('\n</source>');
        if (headEnd < 0 || bodyEnd < 0 || bodyEnd < headEnd + 3) {
            problems.push(`source ${id} is not closed`);
            return problems;
        }
        const body = rest.slice(headEnd + 3, bodyEnd);
        if (/[<>]/.test(body)) problems.push(`source ${id} has an angle bracket in its text`);
        rest = rest.slice(bodyEnd + '\n</source>'.length);
        if (rest.startsWith('\n')) rest = rest.slice(1);
    }
    if (rest.length > 0) problems.push('there is something between or after the sources');
    return problems;
}
