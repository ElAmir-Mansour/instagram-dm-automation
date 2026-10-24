/**
 * The one `Range: bytes=…` request header `GET /api/uploads/:id` answers (RFC 9110 §14).
 *
 * **Why this exists.** Video players and Meta's media fetchers ask for a reel in pieces: `bytes=0-1048575`, then the next
 * megabyte, and so on. The route used to ignore the header and stream the WHOLE file for every piece, and Vercel's CDN does not
 * answer a ranged request from its cache (a cached 6MB reel asked for `bytes=0-1023` came back `200`, `x-vercel-cache: MISS`,
 * all 6MB). So one 30MB reel fetched in 1MB pieces cost ~900MB of Fast Origin Transfer, and three such days took the free tier's
 * 10GB to 18.6GB in October 2026. Answering a range with only its bytes makes each piece cost what it asks for.
 *
 * Pure: no I/O. Only a single range is honoured. A list of ranges (`bytes=0-1,5-6`), another unit, or anything malformed is
 * `none`, which means "serve the whole file with 200", what RFC 9110 allows a server to do with a Range it will not process.
 */

export type ByteRange =
    /** No usable Range header: serve the whole file. */
    | { kind: 'none' }
    /** Bytes `start` to `end`, both inclusive, of a `total`-byte file. */
    | { kind: 'range'; start: number; end: number; total: number }
    /** A well-formed range that lies wholly past the end of the file: 416 with `Content-Range: bytes *\/total`. */
    | { kind: 'unsatisfiable'; total: number };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

export function parseByteRange(header: unknown, total: number | null): ByteRange {
    if (typeof header !== 'string' || total === null || !Number.isSafeInteger(total) || total < 0) return { kind: 'none' };
    const match = SINGLE_RANGE.exec(header.trim());
    if (!match) return { kind: 'none' };
    const [, first, last] = match;
    if (first === '' && last === '') return { kind: 'none' };

    if (first === '') {
        // `bytes=-N`: the last N bytes.
        const suffix = Number(last);
        if (!Number.isSafeInteger(suffix)) return { kind: 'none' };
        if (suffix === 0 || total === 0) return { kind: 'unsatisfiable', total };
        return { kind: 'range', start: Math.max(0, total - suffix), end: total - 1, total };
    }

    const start = Number(first);
    const end = last === '' ? Number.MAX_SAFE_INTEGER : Number(last);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return { kind: 'none' };
    if (start >= total) return { kind: 'unsatisfiable', total };
    return { kind: 'range', start, end: Math.min(end, total - 1), total };
}

/** The `Content-Range` value for a range the server is sending. */
export function contentRange(range: { start: number; end: number; total: number }): string {
    return `bytes ${range.start}-${range.end}/${range.total}`;
}
