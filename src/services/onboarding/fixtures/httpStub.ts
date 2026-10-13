/**
 * A fake network under an axios instance (`metaHttp`, `youtubeHttp`), for the tests of the Instagram and YouTube sources: no socket is
 * opened. The instance's adapter is replaced, so everything above it runs for real, the interceptors, the status check and the
 * `AxiosError` an axios call throws, which holds the whole request (its headers, its params, its URL): the thing a credential
 * leaks through when a caller logs or returns the raw error. Not a test file.
 */
import { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

export interface SeenRequest {
    method: string;
    url: string;
    /** Lower-cased header names. */
    headers: Record<string, string>;
    params: Record<string, unknown>;
    /** The body as sent (a string for a form). */
    data: string;
}

export type Reply = { status: number; data?: unknown; headers?: Record<string, string> } | Error;

/**
 * Answer every request with `reply(request)`. A status outside 2xx throws an `AxiosError` with the response, as axios does; an
 * `Error` is thrown as it is (a network failure has no response). Returns the requests seen, in order, and a restore function.
 */
export function stubAxios(instance: AxiosInstance, reply: (seen: SeenRequest, n: number) => Reply | Promise<Reply>): { seen: SeenRequest[]; restore: () => void } {
    const original = instance.defaults.adapter;
    const seen: SeenRequest[] = [];
    instance.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
        const headers = Object.fromEntries(
            Object.entries((config.headers as unknown as { toJSON?: () => Record<string, unknown> })?.toJSON?.() ?? config.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
        );
        const request: SeenRequest = {
            method: String(config.method).toUpperCase(),
            url: String(config.url),
            headers,
            params: { ...(config.params ?? {}) },
            data: typeof config.data === 'string' ? config.data : config.data === undefined ? '' : String(config.data),
        };
        seen.push(request);
        const r = await reply(request, seen.length - 1);
        if (r instanceof Error) throw r;
        const response = { data: r.data ?? '', status: r.status, statusText: String(r.status), headers: r.headers ?? {}, config, request: {} };
        const ok = config.validateStatus ? config.validateStatus(r.status) : r.status >= 200 && r.status < 300;
        if (!ok) throw new AxiosError(`Request failed with status code ${r.status}`, r.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config, {}, response);
        return response;
    };
    return { seen, restore: () => { instance.defaults.adapter = original; } };
}

/** A failure that never reached the platform: a reset connection, a timeout. It has no response. */
export const networkError = (code = 'ECONNRESET', message = 'socket hang up'): Error => Object.assign(new Error(message), { code });
