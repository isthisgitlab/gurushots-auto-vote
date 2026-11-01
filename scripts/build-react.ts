#!/usr/bin/env node

// Builds every renderer document and bundle: the CSPs live in
// build-react/csp.ts, the HTML documents in build-react/documents.ts, the
// esbuild inputs in build-react/entries.ts, and the dist/ staging and bundle
// loops in build-react/orchestrate.ts — all re-exported here.

import { buildReact } from './build-react/orchestrate';
import { runIfMain } from './lib/run-if-main';

export { PHOTO_HOST, baseCsp, androidCsp, remoteCsp } from './build-react/csp';
export {
    HEADLESS_FLAG_FILE,
    HEADLESS_FLAG_SOURCE,
    capacitorIndexHtml,
    headlessHtml,
    webHtml,
    remoteHtml,
    remoteLoaderHtml,
} from './build-react/documents';
export { entryPoints, commonOptions, perEntryOptions } from './build-react/entries';
export { NOTICES_ASSET_NAME, copyRemoteVersionDir, buildReact } from './build-react/orchestrate';

runIfMain(require.main, module, buildReact);
