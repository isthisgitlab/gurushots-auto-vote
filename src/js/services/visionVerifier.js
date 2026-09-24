/**
 * Local image/text check for the highest-ranked auto-fill candidates.
 * The model is downloaded and checksummed by the build, then shipped with the
 * application. A failed image fetch or inference leaves tag ranking intact.
 */
const runtime = require('../runtime');
const { entryPhotoUrl } = require('../format/photoUrl');

const MAX_IMAGES = 12;
const MIN_STRONG_SCORE = 0.001;
const VETO_RATIO = 0.1;
// Only prompts checked against real GuruShots examples are enabled. SigLIP's
// raw score for a bare challenge title was misleading ("Banisters" scored a
// lakeside portrait above a real handrail), so other themes abstain.
const VERIFIED_PROMPTS = Object.freeze({
    banisters: 'a photo of a banister or handrail',
});
let classifierPromise;
let cliAssetRoot;

const getModelLocation = () => {
    if (runtime.isCapacitor() || runtime.isHeadlessService()) return './';
    const path = require('node:path');
    if (cliAssetRoot) return `${cliAssetRoot}${path.sep}`;
    if (runtime.isElectron() && runtime.isPackaged()) return `${process.resourcesPath}${path.sep}`;
    return path.join(__dirname, '..', '..', '..', '.cache') + path.sep;
};

const loadClassifier = async () => {
    let transformers;
    if (runtime.isCli()) {
        const sea = require('node:sea');
        if (sea.isSea()) {
            const assets = require('./visionCliAssets').extractVisionCliAssets();
            cliAssetRoot = assets.root;
            const { createRequire } = require('node:module');
            transformers = createRequire(assets.modulePath)('@huggingface/transformers');
        }
    }
    transformers ||= await import('@huggingface/transformers');
    const { env, pipeline } = transformers;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = getModelLocation();
    if (runtime.isCapacitor() || runtime.isHeadlessService()) {
        env.backends.onnx.wasm.wasmPaths = './';
        env.backends.onnx.wasm.numThreads = 1;
    }
    return pipeline('zero-shot-image-classification', 'vision-model', {
        dtype: 'q8',
        device: runtime.isCapacitor() || runtime.isHeadlessService() ? 'wasm' : 'cpu',
    });
};

const getClassifier = () => {
    if (!classifierPromise) classifierPromise = loadClassifier();
    return classifierPromise;
};

const themePrompt = (challenge) => {
    const title = String(challenge?.title || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    return VERIFIED_PROMPTS[title] || null;
};

const selectVisualMatches = (scored, wantCount) => {
    const strongest = Math.max(...scored.map((item) => item.score));
    if (strongest < MIN_STRONG_SCORE) return [];
    return scored
        .filter((item) => item.score >= strongest * VETO_RATIO)
        .slice(0, wantCount)
        .map((item) => item.id);
};

/**
 * Preserve the tag/popularity order, vetoing only visual outliers when the
 * model finds at least one strong match in the same shortlist. A successfully
 * scored but weak shortlist leaves the slot empty; unavailable inference
 * returns the original tag selection.
 */
const pickVisuallyVerified = async (challenge, rankedIds, eligible, wantCount, logger) => {
    const original = rankedIds.slice(0, wantCount);
    const prompt = themePrompt(challenge);
    if (!prompt || rankedIds.length === 0) return original;
    const byId = new Map(eligible.map((photo) => [String(photo.id), photo]));
    const candidates = rankedIds.slice(0, Math.min(MAX_IMAGES, Math.max(4, wantCount * 3))).map((id) => ({
        id,
        url: entryPhotoUrl(byId.get(String(id)), { size: 256, fit: true }),
    }));
    if (candidates.some((item) => !item.url)) return original;
    try {
        const classifier = await getClassifier();
        const scored = [];
        for (const { id, url } of candidates) {
            const result = await classifier(url, [prompt]);
            const score = result?.[0]?.score;
            if (!Number.isFinite(score)) return original;
            scored.push({ id, score });
        }
        const picked = selectVisualMatches(scored, wantCount);
        if (picked.length === 0) {
            logger
                ?.withCategory('autoFill')
                ?.info(`Visual check found no strong match for ${logger.challengeTag(challenge)}; standing down`, null);
            return picked;
        }
        if (picked.length > 0 && picked.some((id, index) => id !== original[index])) {
            logger
                ?.withCategory('autoFill')
                ?.info(`Visual check skipped weak matches for ${logger.challengeTag(challenge)}`, null);
        }
        return picked;
    } catch (error) {
        logger
            ?.withCategory('autoFill')
            ?.warning(
                `Visual check unavailable for ${logger.challengeTag(challenge)}: ${error.message || error}`,
                null,
            );
        return original;
    }
};

const __resetForTests = () => {
    classifierPromise = undefined;
    cliAssetRoot = undefined;
};

module.exports = { pickVisuallyVerified, selectVisualMatches, themePrompt, __resetForTests };
