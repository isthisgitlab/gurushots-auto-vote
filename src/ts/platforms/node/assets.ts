/**
 * The node family's assets member: the runtime assets (notices, lexicon)
 * read the way thirdPartyNotices.ts and services/semantic/assets.ts read them
 * on Node — the CLI single binary answers from the embedded SEA asset,
 * everything else from the file under src/assets — plus the vision model's
 * location and device on Node. The wrapped modules are reached at call time
 * (see index.ts for why); the SEA-or-fs read itself answers the same
 * semantics the core loaders keep private, and Phase 3 moves the reads
 * behind the port and retires the copy.
 */

import type { PlatformAssets } from '../../platform/port';

type RuntimeModule = typeof import('../../runtime');
type AppPathsModule = typeof import('../../appPaths');

const runtime = (): RuntimeModule => require('../../runtime') as RuntimeModule;
const appPaths = (): AppPathsModule => require('../../appPaths') as AppPathsModule;

// The fs read of one asset under src/assets of the app root.
const readAssetFile = (relativePath: string): string =>
    (require('node:fs') as typeof import('node:fs')).readFileSync(
        appPaths().appPath('src', 'assets', relativePath),
        'utf8',
    );

// The SEA-or-fs read of one asset under src/assets.
const readAssetText = (relativePath: string): string => {
    try {
        const sea = require('node:sea') as typeof import('node:sea');
        if (sea.isSea()) return sea.getAsset(relativePath, 'utf8');
    } catch {
        // node:sea unavailable or not a SEA build — fall through to the fs read.
    }
    return readAssetFile(relativePath);
};

const createNodeAssets = (): PlatformAssets => ({
    // The port's reads are async on every family (the WebViews' fetch reads
    // are), so the node family's synchronous reads are wrapped.
    readText: async (relativePath: string): Promise<string> => readAssetText(relativePath),
    readJson: async (relativePath: string): Promise<unknown> => {
        // The SEA asset is parsed inside the try, the way the lexicon loader
        // parses it (services/semantic/assets.ts loadViaNode): a SEA asset
        // that fails to parse falls back to the fs read, the way an
        // unreadable one does.
        try {
            const sea = require('node:sea') as typeof import('node:sea');
            if (sea.isSea()) {
                const fromSea: unknown = JSON.parse(sea.getAsset(relativePath, 'utf8'));
                return fromSea;
            }
        } catch {
            // The asset read or its parse failed — fall through to the fs read.
        }
        const parsed: unknown = JSON.parse(readAssetFile(relativePath));
        return parsed;
    },
    visionModel: {
        // The non-SEA branches of visionVerifier getModelLocation. The SEA
        // build's extracted runtime root is the CLI shell's (visionCliAssets,
        // a shell:cli module this family cannot import); its injection is that
        // slice's to add.
        location: () => {
            const path = require('node:path') as typeof import('node:path');
            if (runtime().isElectron() && runtime().isPackaged()) return `${process.resourcesPath}${path.sep}`;
            return `${appPaths().appPath('.cache')}${path.sep}`;
        },
        device: 'cpu',
    },
});

export { createNodeAssets };
