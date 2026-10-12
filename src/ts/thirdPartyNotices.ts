/**
 * Cross-platform loader for the third-party license notices (src/assets/THIRD_PARTY_NOTICES.txt, generated at build
 * time). Loaded as a runtime asset on every platform, the way services/semantic/assets.ts loads the lexicon:
 *   - Android WebView: fetch() from the webDir (dist/).
 *   - CLI single binary (Node SEA): node:sea.getAsset().
 *   - CLI from source + Electron (dev and packaged .asar): fs read of src/assets.
 */

import * as runtime from './runtime';
import { appPath } from './appPaths';

const NOTICES_ASSET_NAME = 'THIRD_PARTY_NOTICES.txt';

const loadViaFetch = async (): Promise<string> => {
    // Relative URL resolves against the WebView document served from the webDir.
    const res = await fetch(NOTICES_ASSET_NAME);
    if (!res.ok) throw new Error(`fetch ${NOTICES_ASSET_NAME}: HTTP ${res.status}`);
    return res.text();
};

const loadViaNode = (): string => {
    try {
        const sea = require('node:sea') as typeof import('node:sea');
        if (sea.isSea()) return sea.getAsset(NOTICES_ASSET_NAME, 'utf8');
    } catch {
        // node:sea unavailable or not a SEA build — fall through to the fs read.
    }
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.readFileSync(appPath('src', 'assets', NOTICES_ASSET_NAME), 'utf8');
};

/**
 * The third-party notices text. Rejects when the asset cannot be read.
 */
const loadThirdPartyNotices = async (): Promise<string> =>
    runtime.isCapacitor() || runtime.isHeadlessService() ? loadViaFetch() : loadViaNode();

export { loadThirdPartyNotices, NOTICES_ASSET_NAME };
