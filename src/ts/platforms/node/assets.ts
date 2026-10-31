/**
 * The node family's assets member: the runtime assets (notices, lexicon)
 * read the way thirdPartyNotices.ts and services/semantic/assets.ts read them
 * on Node — the CLI single binary answers from the embedded SEA asset,
 * everything else from the file under src/assets — plus the vision model's
 * answers on Node: the packaged-Electron / build-cache location, the cpu
 * device, the SEA-or-fs bundled check, and the transformers load, which a SEA
 * build runs from the runtime the build extracted (the extractor the CLI
 * shell injects; the family remembers the extracted root, whose reader the
 * shell's location override answers). The wrapped modules are reached at call
 * time (see index.ts for why).
 */

import type { PlatformAssets } from '../../platform/port';

type RuntimeModule = typeof import('../../runtime');
type AppPathsModule = typeof import('../../appPaths');
type NodePathsModule = typeof import('./paths');
type VisionCliAssetsModule = typeof import('../../services/visionCliAssets');

const runtime = (): RuntimeModule => require('../../runtime') as RuntimeModule;
const appPaths = (): AppPathsModule => require('../../appPaths') as AppPathsModule;
const nodePaths = (): NodePathsModule => require('./paths') as NodePathsModule;

/**
 * The parts a shell passes in: the CLI single binary's extractor of the
 * embedded vision runtime — a shell:cli module this family cannot import, so
 * the shell injects it at call time. Absent on the other node shells, which
 * are never SEA builds.
 */
type NodeAssetParts = {
    extractVisionCliAssets?: () => ReturnType<VisionCliAssetsModule['extractVisionCliAssets']>;
};

// The SEA build's extracted vision-runtime root, set once loadTransformers
// has extracted it — the CLI shell's location override answers it.
let extractedVisionRoot: string | undefined;

/** The extracted SEA vision-runtime root, once loadTransformers has set it. */
const extractedVisionRootOf = (): string | undefined => extractedVisionRoot;

// Test-only: clear the remembered root so a test can start from unextracted.
const __resetExtractedRootForTests = () => {
    extractedVisionRoot = undefined;
};

// node:sea as the loaders' tests fake it: a try away, since the module is
// absent where the builtin is not compiled in.
const seaIfAny = (): typeof import('node:sea') | null => {
    try {
        return require('node:sea') as typeof import('node:sea');
    } catch {
        return null;
    }
};

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

// The non-SEA branches of the model location: the extracted runtime root is
// the CLI shell's override (it reads extractedVisionRootOf).
const modelLocation = (): string => {
    const path = require('node:path') as typeof import('node:path');
    if (runtime().isElectron() && nodePaths().isPackaged()) return `${process.resourcesPath}${path.sep}`;
    return `${appPaths().appPath('.cache')}${path.sep}`;
};

const createNodeAssets = (parts: NodeAssetParts = {}): PlatformAssets => ({
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
        location: modelLocation,
        device: 'cpu',
        // A SEA build answers the embedded runtime's checksum asset; the
        // packaged Electron and source builds look for the model beside the
        // location the model loads from.
        bundled: async (): Promise<boolean> => {
            const sea = seaIfAny();
            if (sea?.isSea()) {
                try {
                    sea.getAsset('vision-runtime.sha256');
                    return true;
                } catch {
                    return false;
                }
            }
            const path = require('node:path') as typeof import('node:path');
            return (require('node:fs') as typeof import('node:fs')).existsSync(
                path.join(modelLocation(), 'vision-model', 'config.json'),
            );
        },
        // A SEA build with the injected extractor loads the library from the
        // extracted runtime through createRequire; everything else imports
        // the package.
        loadTransformers: async () => {
            const extractor = parts.extractVisionCliAssets;
            const sea = seaIfAny();
            if (extractor && sea?.isSea()) {
                const assets = extractor();
                extractedVisionRoot = assets.root;
                const { createRequire } = require('node:module') as typeof import('node:module');
                return createRequire(assets.modulePath)(
                    '@huggingface/transformers',
                ) as typeof import('@huggingface/transformers');
            }
            return import('@huggingface/transformers');
        },
    },
});

export { createNodeAssets, extractedVisionRootOf, __resetExtractedRootForTests };
