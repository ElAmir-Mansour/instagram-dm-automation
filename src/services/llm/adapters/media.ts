/**
 * Pictures and video in a conversation (`LlmTurn.media`): what every adapter asks first, and the one family member that answers it.
 *
 * Only Meta (Muse) takes media here. Its servers read a base64 `data:` URL; a remote one fails with `media_url_origin_error` when the host blocks
 * bots, which Instagram's CDN does. Every other adapter refuses a turn that carries any, with a `bad_request` and before a request is made, so a
 * customer's photo or video cannot reach a provider that was set up to be sent words alone, whatever route a caller chose.
 * A turn with no `media`, or an empty list, is a plain turn: no adapter looks any further, and the request it builds is the one it always built.
 */
import { AiError } from '../errors.js';
import { providerName } from '../registry.js';
import type { AdapterArgs, LlmMedia, LlmTurn } from '../types.js';

type MediaCall = Pick<AdapterArgs, 'provider' | 'model' | 'apiKey' | 'user'>;

/** Every picture and video of the conversation, in order. A plain string, a turn with no `media` and one with `[]` have none. */
export function mediaOf(user: string | readonly LlmTurn[]): LlmMedia[] {
    return typeof user === 'string' ? [] : user.flatMap((turn) => turn.media ?? []);
}

/** `bad_request`, final: asking again with the same media will not change what the provider takes. */
export function mediaRefusal(a: Pick<AdapterArgs, 'provider' | 'model' | 'apiKey'>, message: string): AiError {
    return new AiError({ kind: 'bad_request', provider: a.provider, model: a.model, key: a.apiKey, message });
}

/** For an adapter that takes none: throws if any turn carries a picture or a video. */
export function refuseMedia(a: MediaCall): void {
    if (mediaOf(a.user).length === 0) return;
    throw mediaRefusal(a, `${providerName(a.provider)} is not sent pictures or video through this layer: only Meta (Muse) takes them. Route this purpose to Meta, or send words alone.`);
}

/** `image/jpeg`, `video/mp4`: a type of the kind it is filed under, and one that can sit in a `data:` URL without breaking it. */
const MEDIA_TYPE = /^(image|video)\/[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/**
 * One piece of media, checked: a known kind, a type that agrees with it, and some bytes. A wrong one is the caller's fault and never gets better,
 * so it is `bad_request`, and the message names the turn and the piece without quoting any of the bytes.
 */
export function checkMedia(a: Pick<AdapterArgs, 'provider' | 'model' | 'apiKey'>, media: LlmMedia, turn: number, piece: number): void {
    const where = `Media ${piece + 1} of turn ${turn + 1}`;
    if (media?.kind !== 'image' && media?.kind !== 'video') throw mediaRefusal(a, `${where} is neither an image nor a video.`);
    const type = typeof media.mime === 'string' ? MEDIA_TYPE.exec(media.mime.trim()) : null;
    if (!type || type[1] !== media.kind) throw mediaRefusal(a, `${where} says it is ${media.kind === 'image' ? 'an image' : 'a video'} but its type is not ${media.kind}/….`);
    if (typeof media.base64 !== 'string' || media.base64.length === 0) throw mediaRefusal(a, `${where} has no bytes.`);
    // The URL is built here as `data:<type>;base64,<bytes>`, so bytes that already carry the prefix would make a URL no one can read.
    if (/^data:/i.test(media.base64)) throw mediaRefusal(a, `${where} must be the bare base64 bytes, without a data: prefix.`);
}
