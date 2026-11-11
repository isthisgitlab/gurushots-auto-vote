#!/usr/bin/env node

// Builds every renderer document and bundle: the CSPs live in
// build-react/csp.ts, the HTML documents in build-react/documents.ts, the
// esbuild inputs in build-react/entries.ts, and the dist/ staging and bundle
// loops in build-react/orchestrate.ts — all re-exported here.

import { assembleRenderer, buildReact, buildRendererBundles } from './build-react/orchestrate';
import { assemblyOutputDir } from './lib/build-paths';
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
export {
    NOTICES_ASSET_NAME,
    copyRemoteVersionDir,
    buildRendererBundles,
    assembleRenderer,
    buildReact,
} from './build-react/orchestrate';

const main = () => {
    if (process.argv.includes('--bundles')) return buildRendererBundles();
    if (process.argv.includes('--assemble=production'))
        return assembleRenderer(assemblyOutputDir(process.argv.includes('--lite')));
    if (process.argv.includes('--assemble')) return assembleRenderer();
    return buildReact();
};

runIfMain(require.main, module, main);

export { main };
