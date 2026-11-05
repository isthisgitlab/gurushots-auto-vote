/**
 * Loader for the third-party license notices (src/assets/THIRD_PARTY_NOTICES.txt, generated at build time).
 * Loaded as a runtime asset on every platform — the read is the platform's (the webviews fetch it from the
 * webDir, the CLI single binary from the embedded SEA asset, everything else from the file under src/assets),
 * the way services/semantic/assets.ts loads the lexicon.
 */

import { platform } from './platform/port';

const NOTICES_ASSET_NAME = 'THIRD_PARTY_NOTICES.txt';

/**
 * The third-party notices text. Rejects when the asset cannot be read.
 */
const loadThirdPartyNotices = async (): Promise<string> => platform().assets.readText(NOTICES_ASSET_NAME);

export { loadThirdPartyNotices, NOTICES_ASSET_NAME };
