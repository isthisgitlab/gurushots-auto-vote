/**
 * The webview family's HTTP adapter: routes axios requests through
 * CapacitorHttp's native OkHttp client (Android) so we can set headers that
 * browser fetch can't (host, user-agent, etc. — the iOS-spoof in
 * api/randomizer.ts depends on it). Lazy-loaded by the family's `http`
 * member, so Electron / CLI builds never resolve @capacitor/core.
 */

import { finalizeAdapterResponse } from '../../api/api-client';

import type { AxiosAdapter } from 'axios';

let capacitorAdapter: AxiosAdapter | null = null;
const getCapacitorHttpAdapter = (): AxiosAdapter => {
    if (capacitorAdapter) return capacitorAdapter;
    const { CapacitorHttp } = require('@capacitor/core') as typeof import('@capacitor/core');
    capacitorAdapter = async (config) => {
        const response = await CapacitorHttp.request({
            method: (config.method || 'get').toUpperCase(),
            url: config.url as string,
            headers: config.headers,
            data: config.data as unknown,
            connectTimeout: config.timeout,
            readTimeout: config.timeout,
            disableRedirects: true,
        });
        // Throwing here surfaces as a rejection from this async adapter, so a
        // 429/5xx on the foreground path reaches the retry layer instead
        // of being mistaken for a successful response.
        return finalizeAdapterResponse({
            data: response.data as unknown,
            status: response.status,
            statusText: '',
            headers: response.headers || {},
            config,
        });
    };
    return capacitorAdapter;
};

export { getCapacitorHttpAdapter };
