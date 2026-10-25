/**
 * Tests only: what the picture tests share. A small emulation of the `image_allowance` table (by SQL, on the fake pool of
 * `monteur/testDb.ts`), a media store that keeps what it is given, a provider that answers from a script, and the first bytes of a PNG and a JPEG
 * (a header is all `imageSize.ts` reads).
 *
 * The emulation implements what each statement of `allowance.ts` is MEANT to do. It does not run them: the statements themselves are exercised on
 * a real Postgres when this feature is verified, and `allowance.test.ts` pins the text of the one the cap lives in. Imported by test files only.
 */
import { randomUUID } from 'node:crypto';
import type { MediaContent, MediaStore, PutMediaInput, StoredMedia } from '../../storage.js';
import type { FakeDb } from '../../monteur/testDb.js';
import { ImageProviderError, type DrawRequest, type DrawnPicture, type ImageProvider } from './types.js';

// ─── Pictures ────────────────────────────────────────────────────────────────────────────────

/** A real 1×1 PNG: what a fake provider "draws". */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** The signature and IHDR of a PNG of this size: enough to be read, not enough to be shown. */
export function pngHeader(width: number, height: number): Buffer {
    const out = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out, 0);
    out.writeUInt32BE(13, 8);
    out.write('IHDR', 12, 'ascii');
    out.writeUInt32BE(width, 16);
    out.writeUInt32BE(height, 20);
    out[24] = 8;
    out[25] = 6;
    return out;
}

/** SOI, a start-of-frame of this size, the start of the scan: a JPEG as far as its header. */
export function jpegHeader(width: number, height: number): Buffer {
    const frame = Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
    return Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, frame.length + 2]), frame,
        Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0xff, 0xd9]),
    ]);
}

// ─── The media store ─────────────────────────────────────────────────────────────────────────

export interface PutCall extends PutMediaInput { id: string }

/**
 * A media store in memory. `files` is what `get` answers from (a reference picture is put there by its upload id); `puts` is every file the code
 * under test stored. Ids come from a counter, so a test can name the picture it expects.
 */
export class FakeMediaStore implements MediaStore {
    readonly files = new Map<string, { mimeType: string; data: Buffer }>();
    readonly puts: PutCall[] = [];
    readonly gets: string[] = [];
    failPut: Error | null = null;
    failGet: Error | null = null;
    /** Called as a `put` begins: a place for a test to mark where in a sequence of statements the file was stored. */
    onPut: (() => void) | null = null;
    private counter = 0;

    /** The id the next `put` will answer with. */
    nextId(): string {
        return `aaaaaaaa-0000-4000-8000-${String(this.counter + 1).padStart(12, '0')}`;
    }

    async put(input: PutMediaInput): Promise<{ id: string }> {
        this.onPut?.();
        if (this.failPut) throw this.failPut;
        const id = this.nextId();
        this.counter++;
        this.puts.push({ ...input, id });
        this.files.set(id, { mimeType: input.mimeType, data: input.data });
        return { id };
    }

    async get(id: string): Promise<StoredMedia | null> {
        this.gets.push(id);
        if (this.failGet) throw this.failGet;
        const file = this.files.get(id);
        return file ? { id, mimeType: file.mimeType, data: file.data } : null;
    }

    async open(): Promise<MediaContent | null> {
        throw new Error('FakeMediaStore.open is not used by the picture code.');
    }

    async mimeTypes(ids: readonly string[]): Promise<Map<string, string>> {
        return new Map(ids.flatMap((id) => (this.files.has(id) ? [[id, this.files.get(id)!.mimeType] as [string, string]] : [])));
    }

    publicUrl(id: string, origin: string): string {
        return `${origin}/api/uploads/${id}`;
    }
}

// ─── A provider that answers from a script ───────────────────────────────────────────────────

export type ProviderAnswer = DrawnPicture | ImageProviderError | Error;

/** A provider that records every request and answers with the next scripted answer (a picture, or an error to throw), then the last one again. */
export class ScriptedProvider implements ImageProvider {
    readonly id = 'cloudflare';
    readonly model = '@cf/black-forest-labs/flux-2-klein-4b';
    readonly requests: DrawRequest[] = [];
    /** Called at the moment of each draw, before it answers: a place for a test to look at the world while the provider is "running". */
    onDraw: ((request: DrawRequest) => void | Promise<void>) | null = null;
    private script: ProviderAnswer[];
    private next = 0;

    constructor(
        answers: ProviderAnswer[] = [{ data: PNG_1X1, mime: 'image/png', provider: 'cloudflare', model: '@cf/black-forest-labs/flux-2-klein-4b' }],
        readonly dailyCap = 80,
        readonly unitsPerPicture = 110
    ) {
        this.script = answers;
    }

    get answers(): ProviderAnswer[] {
        return this.script;
    }

    /** Assigning a script starts it from its first answer. */
    set answers(next: ProviderAnswer[]) {
        this.script = next;
        this.next = 0;
    }

    async draw(request: DrawRequest): Promise<DrawnPicture> {
        this.requests.push(request);
        await this.onDraw?.(request);
        const answer = this.script[Math.min(this.next++, this.script.length - 1)]!;
        if (answer instanceof Error) throw answer;
        return answer;
    }
}

export const exhausted = (): ImageProviderError =>
    new ImageProviderError('ALLOWANCE_EXHAUSTED', 'Cloudflare says the free daily allowance is used up.', { status: 429, code: 4006 });
export const refused = (message = 'Cloudflare refused the picture: bad request'): ImageProviderError =>
    new ImageProviderError('PROVIDER_ERROR', message, { status: 400, code: 5000 });

// ─── The allowance table ─────────────────────────────────────────────────────────────────────

export interface AllowanceTableRow { provider: string; day: string; units: number; pictures: number; exhausted_at: Date | null }

const yesterdayOf = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * Teach a fake pool what `allowance.ts` asks of `image_allowance`. Returns the table, so a test can read it and set it up.
 */
export function installAllowanceTable(db: FakeDb): AllowanceTableRow[] {
    const table: AllowanceTableRow[] = [];
    const find = (provider: string, day: string) => table.find((r) => r.provider === provider && r.day === day);
    db.routes.push(
        [/^SELECT exhausted_at FROM image_allowance WHERE provider = \$1 AND exhausted_at IS NOT NULL/, (p) => {
            const found = table.filter((r) => r.provider === p[0] && r.exhausted_at && r.day >= yesterdayOf(p[1]) && r.day <= p[1])
                .sort((a, b) => b.exhausted_at!.getTime() - a.exhausted_at!.getTime())[0];
            return { rows: found ? [{ exhausted_at: found.exhausted_at }] : [] };
        }],
        [/^INSERT INTO image_allowance AS a \(provider, day, units, pictures\) SELECT/, (p) => {
            const [provider, day, perPicture, count, cap] = [p[0], p[1], Number(p[2]), Number(p[3]), Number(p[4])];
            let row = find(provider, day);
            if (!row) {
                if (count > cap) return { rows: [] };
                row = { provider, day, units: 0, pictures: 0, exhausted_at: null };
                table.push(row);
            } else if (row.exhausted_at || row.units + perPicture * count > cap * perPicture) {
                return { rows: [] };
            }
            row.units += perPicture * count;
            row.pictures += count;
            return { rows: [{ units: row.units, pictures: row.pictures }] };
        }],
        [/^UPDATE image_allowance SET units = GREATEST/, (p) => {
            const row = find(p[0], p[1]);
            if (row) {
                row.units = Math.max(row.units - Number(p[3]) * Number(p[2]), 0);
                row.pictures = Math.max(row.pictures - Number(p[2]), 0);
            }
            return { rows: [], rowCount: row ? 1 : 0 };
        }],
        [/^INSERT INTO image_allowance AS a \(provider, day, units, pictures, exhausted_at\)/, (p) => {
            const row = find(p[0], p[1]) ?? (table.push({ provider: p[0], day: p[1], units: 0, pictures: 0, exhausted_at: null }), find(p[0], p[1])!);
            row.exhausted_at = new Date(p[2]);
            return { rows: [{ exhausted_at: row.exhausted_at }] };
        }],
        [/^SELECT day::text AS day, units::float8 AS units, pictures, exhausted_at FROM image_allowance WHERE provider = \$1/, (p) => ({
            rows: table.filter((r) => r.provider === p[0] && r.day >= yesterdayOf(p[1]) && r.day <= p[1]).sort((a, b) => (a.day < b.day ? 1 : -1)),
        })],
        [/^DELETE FROM image_allowance WHERE day </, () => ({ rows: [], rowCount: 7 })],
    );
    return table;
}

/** `explainers.image_provider` as a platform admin would have saved it (a token that is never decrypted by what uses this). */
export const SAVED_PROVIDER = JSON.stringify({
    provider: 'cloudflare', account_id: '0123456789abcdef0123456789abcdef', token_enc: 'enc:v1:a:b:c',
    model: '@cf/black-forest-labs/flux-2-klein-4b', daily_cap: 80, units_per_picture: 110,
});

/** The settings rows a fake pool answers `getSetting` from. Returns the map. */
export function installSettings(db: FakeDb, initial: Record<string, string> = {}): Map<string, string> {
    const settings = new Map(Object.entries(initial));
    db.routes.push(
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: settings.has(p[0]) ? [{ value: settings.get(p[0]), is_secret: false }] : [] })],
        [/^INSERT INTO app_settings /, (p) => { settings.set(p[0], p[1]); return { rows: [], rowCount: 1 }; }],
        [/^DELETE FROM app_settings WHERE key = \$1$/, (p) => { settings.delete(p[0]); return { rows: [], rowCount: 1 }; }],
    );
    return settings;
}

export const newId = (): string => randomUUID();
