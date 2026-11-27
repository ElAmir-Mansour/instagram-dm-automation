/**
 * Re-reading a logo the browser says it uploaded (Brand Kit, contract §2.2).
 *
 * `PATCH /api/profile` carries `brand.logos.main = { url, width, height, alpha, tone, colour }`, which is the browser's claim. The
 * server does not take it as it is: `checkLogoUpload` reads the upload's row and the file's bytes, and returns the asset the profile
 * will hold. What the file can prove it proves (its kind, its pixel size, whether it can hold transparency); `tone` and `colour` are
 * trusted, since they only decide the plate behind this tenant's own logo. Nothing is decoded (I7): the PNG header is all that is read.
 *
 * Runs on the pool, before the profile's transaction opens (a transaction holds one of the pool's connections, and this takes another).
 */
import { pool } from '../../config/db.js';
import { getPublicBaseUrl } from '../appSettings.js';
import { readPictureInfo } from '../explainers/pictures/imageSize.js';
import { ProfileError } from '../profile/store.js';
import type { LogoAsset } from '../profile/types.js';
import { LOGO_URL, logoAssetProblems, PROFILE_LIMITS } from '../profile/validate.js';
import { getMediaStore } from '../storage.js';
import { pngCanHoldAlpha } from './png.js';

/** The machine codes a refusal carries in `problems`. */
export const LOGO_PROBLEMS = ['logo.not_found', 'logo.not_yours', 'logo.private', 'logo.not_png', 'logo.too_big', 'logo.too_small', 'logo.too_large', 'logo.aspect', 'logo.unreadable'] as const;
export type LogoProblem = (typeof LOGO_PROBLEMS)[number];

/** What `media_uploads` says about one upload. */
export interface LogoRow {
    creator_id: string | null;
    mime_type: string;
    size_bytes: string | number | null;
    is_private: boolean;
}

export interface LogoCheckDeps {
    readRow: (id: string) => Promise<LogoRow | null>;
    readBytes: (id: string) => Promise<Uint8Array | null>;
    /** The saved public origin (`app.public_base_url`), or null: the claim's own origin is then used. */
    publicBase: () => Promise<string | null>;
    now: () => Date;
}

const defaultDeps: LogoCheckDeps = {
    async readRow(id) {
        const { rows } = await pool.query<LogoRow>('SELECT creator_id, mime_type, size_bytes, is_private FROM media_uploads WHERE id = $1', [id]);
        return rows[0] ?? null;
    },
    async readBytes(id) {
        const found = await (await getMediaStore()).get(id);
        return found ? found.data : null;
    },
    publicBase: () => getPublicBaseUrl(null),
    now: () => new Date(),
};

let override: Partial<LogoCheckDeps> | null = null;
/** Replace what the check reads with, for every caller (`patchProfile` takes none of its own) — tests only. Returns the previous override. */
export function setLogoCheckDeps(next: Partial<LogoCheckDeps> | null): Partial<LogoCheckDeps> | null {
    const previous = override;
    override = next;
    return previous;
}

const invalid = (code: LogoProblem, message: string): ProfileError => new ProfileError('BRAND_LOGO_INVALID', 400, message, { problems: [code] });

const MESSAGES: Record<Exclude<LogoProblem, 'logo.unreadable'>, string> = {
    'logo.not_found': 'That logo upload was not found. Upload it again.',
    'logo.not_yours': 'That upload belongs to another workspace.',
    'logo.private': 'That upload is private, so it cannot be a logo.',
    'logo.not_png': 'The logo must be a PNG file.',
    'logo.too_big': 'The logo file is too big: keep it under 3 MB.',
    'logo.too_small': `The logo is too small: its short side must be at least ${PROFILE_LIMITS.logoMinSide} px.`,
    'logo.too_large': `The logo is too large: its long side must be at most ${PROFILE_LIMITS.logoMaxSide} px.`,
    'logo.aspect': 'The logo is too long or too tall: its width to height must be from 1:4 to 8:1.',
};
const refuse = (code: Exclude<LogoProblem, 'logo.unreadable'>): ProfileError => invalid(code, MESSAGES[code]);

/** 503: the file or its row could not be read just now (storage down, an R2 allowance used up, a network error). Nothing is wrong with the logo. */
const unreadable = (): ProfileError =>
    new ProfileError('BRAND_LOGO_UNREADABLE', 503, 'We couldn\'t read your logo just now. Try again in a minute.', { problems: ['logo.unreadable'] });

/** `await fn()`, with any error it throws made into the 503. */
async function reading<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch {
        throw unreadable();
    }
}

export async function checkLogoUpload(creatorId: string, raw: unknown, deps: Partial<LogoCheckDeps> = {}): Promise<LogoAsset> {
    const d: LogoCheckDeps = { ...defaultDeps, ...override, ...deps };
    // 1. The claim's shape.
    const problems = logoAssetProblems(raw, 'brand.logos.main');
    if (problems.length > 0) throw new ProfileError('BRAND_LOGO_INVALID', 400, problems[0]!, { problems });
    const claim = raw as Record<string, unknown> & { url: string; alpha: boolean; tone: LogoAsset['tone']; colour: string };
    const match = /\/api\/uploads\/([0-9a-f-]{36})$/i.exec(claim.url);
    if (!LOGO_URL.test(claim.url) || !match) throw invalid('logo.not_found', MESSAGES['logo.not_found']);
    const id = match[1]!.toLowerCase();

    // 2. The row.
    const row = await reading(() => d.readRow(id));
    if (!row) throw refuse('logo.not_found');
    if (!row.creator_id || row.creator_id.toLowerCase() !== creatorId.toLowerCase()) throw refuse('logo.not_yours');
    if (row.is_private) throw refuse('logo.private');
    if (row.mime_type !== 'image/png') throw refuse('logo.not_png');

    // 3. The bytes: the width and the height come from the file, never from the claim.
    const bytes = await reading(() => d.readBytes(id));
    if (!bytes) throw refuse('logo.not_found');
    if (bytes.length > PROFILE_LIMITS.logoBytes) throw refuse('logo.too_big');
    const info = readPictureInfo(bytes);
    if (!info || info.mime !== 'image/png') throw refuse('logo.not_png');
    const { width, height } = info;
    if (Math.min(width, height) < PROFILE_LIMITS.logoMinSide) throw refuse('logo.too_small');
    if (Math.max(width, height) > PROFILE_LIMITS.logoMaxSide) throw refuse('logo.too_large');
    const aspect = width / height;
    if (aspect < PROFILE_LIMITS.logoMinAspect || aspect > PROFILE_LIMITS.logoMaxAspect) throw refuse('logo.aspect');

    // 4. Transparency the file cannot hold is not claimed.
    const alpha = claim.alpha === true && pngCanHoldAlpha(bytes);

    // 5. The address on the public origin: an upload's URL is built from the Host of the request, and a preview's is not one the Mac can open.
    const base = await reading(() => d.publicBase());
    const origin = base ?? new URL(claim.url).origin;
    return { url: `${origin}/api/uploads/${id}`, width, height, alpha, tone: claim.tone, colour: claim.colour.toUpperCase(), added_at: d.now().toISOString() };
}
