/**
 * The headless family's HTTP adapter: routes axios through a native
 * @JavascriptInterface (AndroidHeadlessHttp) backed by OkHttp, since the
 * bare service WebView has no Capacitor runtime / CapacitorHttp.
 *
 * Asynchronous by design: a synchronous bridge would block the WebView's
 * JS thread for the whole network round-trip. Instead `request` returns
 * immediately, native runs OkHttp off-thread, and posts the result back
 * by calling globalThis.__gsResolveHeadlessHttp(id, resultJson) — where
 * resultJson is a JSON string { status, body, headers }.
 */

import { isPlainObject } from '../../core/plainObject';
import { finalizeAdapterResponse } from '../../core/api/api-client';

import type { AxiosAdapter } from 'axios';

/**
 * The native bridge globals of the Android headless-service WebView.
 */
interface HeadlessHttpGlobals {
    __gsResolveHeadlessHttp?: (id: number, resultJson: string) => void;
    AndroidHeadlessHttp: {
        request: (id: number, method: string, url: string, headersJson: string, body: string) => void;
    };
}

let headlessReqSeq = 0;
const headlessPending: Map<number, (resultJson: string) => void> = new Map();
const headlessGlobals = globalThis as typeof globalThis & HeadlessHttpGlobals;
const ensureHeadlessResolver = () => {
    if (headlessGlobals.__gsResolveHeadlessHttp) return;
    headlessGlobals.__gsResolveHeadlessHttp = (id, resultJson) => {
        const cb = headlessPending.get(id);
        if (cb) {
            headlessPending.delete(id);
            cb(resultJson);
        }
    };
};

type HeadlessResult = { error?: string; status: number; body: string; headers: Record<string, string> };

/**
 * The native bridge's result JSON as a HeadlessResult. It is parsed as `unknown` and checked: a result with no
 * numeric status (and no `error`), or a body that is not a string, is rejected as malformed.
 */
const parseHeadlessResult = (resultJson: string): HeadlessResult => {
    const parsed: unknown = JSON.parse(resultJson);
    if (!isPlainObject(parsed)) throw new Error('Malformed native HTTP result');
    if (parsed.error) {
        if (typeof parsed.error !== 'string') throw new Error('Malformed native HTTP result');
        return { error: parsed.error, status: 0, body: '', headers: {} };
    }
    if (typeof parsed.status !== 'number' || !Number.isFinite(parsed.status) || typeof parsed.body !== 'string') {
        throw new Error('Malformed native HTTP result');
    }
    const headers: Record<string, string> = {};
    if (isPlainObject(parsed.headers)) {
        for (const [name, value] of Object.entries(parsed.headers)) {
            if (typeof value === 'string') headers[name] = value;
        }
    }
    return { status: parsed.status, body: parsed.body, headers };
};

let headlessAdapter: AxiosAdapter | null = null;
const getHeadlessHttpAdapter = (): AxiosAdapter => {
    if (headlessAdapter) return headlessAdapter;
    ensureHeadlessResolver();
    headlessAdapter = (config) =>
        new Promise((resolve, reject) => {
            const id = ++headlessReqSeq;
            headlessPending.set(id, (resultJson) => {
                try {
                    // The AndroidHeadlessHttp result contract (see the adapter note above).
                    const parsed = parseHeadlessResult(resultJson);
                    // A transport/network failure on the native side — reject so
                    // the retry layer treats it as a (retryable) no-response error.
                    if (parsed.error) {
                        reject(new Error(parsed.error));
                        return;
                    }
                    // The API returns JSON; parse the body so callers get an
                    // object, matching CapacitorHttp/axios. Leave non-JSON as-is.
                    let data: unknown = parsed.body;
                    try {
                        data = JSON.parse(parsed.body);
                    } catch {
                        /* non-JSON body — return the raw string */
                    }
                    const response = {
                        data,
                        status: parsed.status,
                        statusText: '',
                        headers: parsed.headers,
                        config,
                    };
                    // finalizeAdapterResponse throws on non-2xx (with the
                    // response attached) — that throw is caught by the
                    // surrounding catch below and rejected, so the retry/backoff
                    // layer classifies it; otherwise we resolve the 2xx response.
                    const finalized = finalizeAdapterResponse(response);
                    resolve(finalized);
                } catch (err) {
                    reject(err);
                }
            });
            const body = typeof config.data === 'string' ? config.data : config.data ? JSON.stringify(config.data) : '';
            headlessGlobals.AndroidHeadlessHttp.request(
                id,
                (config.method || 'get').toUpperCase(),
                config.url as string,
                JSON.stringify(config.headers || {}),
                body,
            );
        });
    return headlessAdapter;
};

export { getHeadlessHttpAdapter };
