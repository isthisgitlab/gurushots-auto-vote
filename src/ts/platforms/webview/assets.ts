/**
 * The webview family's assets member: the fetch readers of the WebView asset
 * branches (thirdPartyNotices.ts, services/semantic/assets.ts) and the vision
 * model's location and device there (services/visionVerifier.ts). The assets
 * are served from the webDir (dist/), so a read is a fetch whose relative URL
 * resolves against the WebView document. The fetch reader is the branch body
 * those loaders keep private; Phase 3 retires them for this member.
 */

import type { PlatformAssets } from '../../platform/port';

// The WebView fetch of one asset under the webDir root (the guarded form of
// the two loaders' loadViaFetch): a fetch without a response, or one that is
// not ok, throws.
const readViaFetch = async (relativePath: string): Promise<string> => {
    // Relative URL resolves against the WebView document served from the webDir.
    const res = await fetch(relativePath);
    if (!res || !res.ok) throw new Error(`fetch ${relativePath}: HTTP ${res ? res.status : 'no response'}`);
    return res.text();
};

const createWebviewAssets = (): PlatformAssets => ({
    readText: readViaFetch,
    readJson: async (relativePath: string): Promise<unknown> => {
        const parsed: unknown = JSON.parse(await readViaFetch(relativePath));
        return parsed;
    },
    visionModel: {
        // The WebView branch of visionVerifier getModelLocation: the model and
        // the wasm runtime sit in the webDir the document resolves against.
        location: () => './',
        device: 'wasm',
    },
});

export { createWebviewAssets };
