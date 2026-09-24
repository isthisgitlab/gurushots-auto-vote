/**
 * Local image/text check for the highest-ranked fill candidates of ANY
 * challenge. The prompts come from the challenge itself — its title subject
 * and the opening of its description — so no theme is hardcoded. The model is
 * downloaded and checksummed by the build, then shipped with the application.
 *
 * The check only reorders: photos the model finds clearly off-theme move
 * behind the ones it accepts, and the tag/popularity order is kept inside each
 * group. It never empties a pick. A challenge with no visual subject ("Guru of
 * The Week", "It's all About Balance"), a failed image fetch, or a failed
 * inference leaves the tag order untouched.
 */
const runtime = require('../runtime');
const { entryPhotoUrl } = require('../format/photoUrl');
const { visualSubjectWords } = require('./photoPicker');

const MAX_IMAGES = 12;
// Thresholds are on SigLIP's logit scale, measured on live GuruShots
// challenges (2026-09-24). A prompt describes something visible when at least
// one shortlisted photo reaches ABSTAIN_LOGIT for it: concrete themes peaked
// between -5.7 (Metal & Wood) and -1.1 (Smoke-Filled Scenes), while
// "Exclusively for GuruShots" (-7.7) and "It's all About Balance" (-7.8) never
// did, so those keep the tag order instead of an arbitrary visual one.
const ABSTAIN_LOGIT = -6.5;
// A photo scoring 10x less likely than the best match is off-theme (the aerial
// island under "Green Leaves" sat ~7 logits below the leaf photos).
const OFF_THEME_MARGIN = Math.log(10);
// SigLIP reads 64 text tokens; two sentences of a description fit well within.
const MAX_DESCRIPTION_CHARS = 200;
// GuruShots appends the same rewards/sign-off text to every description.
const BOILERPLATE_RE = /join our challenge|participation reward|elite level reward|allstar level reward|good luck/i;
const HTML_ENTITIES = Object.freeze({ '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' });

let classifierPromise;
let bundledPromise;
let cliAssetRoot;

const getModelLocation = () => {
    if (runtime.isCapacitor() || runtime.isHeadlessService()) return './';
    const path = require('node:path');
    if (cliAssetRoot) return `${cliAssetRoot}${path.sep}`;
    if (runtime.isElectron() && runtime.isPackaged()) return `${process.resourcesPath}${path.sep}`;
    return path.join(__dirname, '..', '..', '..', '.cache') + path.sep;
};

const isModelBundled = async () => {
    if (runtime.isCapacitor() || runtime.isHeadlessService()) {
        const response = await fetch('vision-model/config.json').catch(() => null);
        return Boolean(response?.ok);
    }
    if (runtime.isCli()) {
        const sea = require('node:sea');
        if (sea.isSea()) {
            try {
                sea.getAsset('vision-runtime.sha256');
                return true;
            } catch {
                return false;
            }
        }
    }
    const path = require('node:path');
    return require('node:fs').existsSync(path.join(getModelLocation(), 'vision-model', 'config.json'));
};

/**
 * Whether this build ships the model. Lite builds (`build:*:lite`) leave it
 * and its inference runtime out, so the visual check is skipped without a
 * warning and the update check stays on the lite downloads.
 *
 * @returns {Promise<boolean>}
 */
const hasBundledModel = () => {
    if (!bundledPromise) bundledPromise = isModelBundled();
    return bundledPromise;
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

/**
 * The description's own statement of the subject: "Share your best photos of
 * balloons. Special occasion balloons, hot air balloons…". HTML and the shared
 * rewards text are removed; '' when nothing descriptive is left.
 *
 * @param {unknown} message - challenge.welcome_message
 * @returns {string}
 */
const descriptionLead = (message) => {
    if (typeof message !== 'string') return '';
    let text = message
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(?:amp|quot|#39|apos|nbsp);/g, (entity) => HTML_ENTITIES[entity])
        .replace(/\s+/g, ' ')
        .trim();
    const boilerplate = text.search(BOILERPLATE_RE);
    if (boilerplate >= 0) text = text.slice(0, boilerplate);
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [];
    return sentences.slice(0, 2).join('').trim().slice(0, MAX_DESCRIPTION_CHARS).trim();
};

/**
 * Text prompts for a challenge: its title subject, plus the description lead
 * when there is one. Empty when the title names nothing visual — the
 * description of a meta challenge ("Photo of the Day") is about the contest,
 * not the picture, so it is never used alone.
 *
 * @param {object} challenge
 * @param {Iterable<string>|null} [ignoreWords]
 * @returns {string[]}
 */
const challengePrompts = (challenge, ignoreWords = null) => {
    const subject = visualSubjectWords(challenge, ignoreWords);
    if (subject.length === 0) return [];
    const lead = descriptionLead(challenge?.welcome_message);
    return [`a photo of ${subject.join(' ')}`, ...(lead ? [lead] : [])];
};

const toLogit = (score) => {
    const p = Math.min(Math.max(score, 1e-12), 1 - 1e-12);
    return Math.log(p / (1 - p));
};

/**
 * Order shortlisted photos by visual fit. Each entry carries one logit per
 * prompt and a photo's fit is their mean: taking the best prompt instead let
 * fog, read by the title prompt as "smoke filled scenes", set a bar that
 * rejected the real smoke photo the description prompt preferred.
 *
 * @param {Array<{id: *, logits: number[]}>} scored - in tag/popularity order
 * @returns {Array<*>|null} ids, accepted photos first; null to abstain
 */
const orderByVisualFit = (scored) => {
    if (scored.length === 0) return null;
    const peak = Math.max(...scored.flatMap((item) => item.logits));
    if (peak < ABSTAIN_LOGIT) return null;
    const fits = scored.map((item) => ({
        id: item.id,
        fit: item.logits.reduce((sum, logit) => sum + logit, 0) / item.logits.length,
    }));
    const floor = Math.max(...fits.map((item) => item.fit)) - OFF_THEME_MARGIN;
    const accepted = fits.filter((item) => item.fit >= floor);
    const rejected = fits.filter((item) => item.fit < floor).sort((a, b) => b.fit - a.fit);
    return [...accepted, ...rejected].map((item) => item.id);
};

/**
 * Re-rank the head of a tag-ranked shortlist by what the photos show.
 *
 * @param {object} challenge
 * @param {Array<*>} rankedIds - photo ids, best tag/popularity match first
 * @param {Array<object>} eligible - photo records (id + member_id) for the ids
 * @param {number} wantCount
 * @param {{logger: object, ignoreWords?: Iterable<string>|null}} options
 * @returns {Promise<Array<*>>} wantCount ids (fewer only if rankedIds is shorter)
 */
const rankVisually = async (challenge, rankedIds, eligible, wantCount, { logger, ignoreWords = null }) => {
    const original = rankedIds.slice(0, wantCount);
    const prompts = challengePrompts(challenge, ignoreWords);
    if (prompts.length === 0 || rankedIds.length === 0) return original;
    const byId = new Map(eligible.map((photo) => [String(photo.id), photo]));
    const shortlist = rankedIds.slice(0, Math.max(MAX_IMAGES, wantCount));
    const candidates = shortlist.map((id) => ({
        id,
        url: entryPhotoUrl(byId.get(String(id)), { size: 256, fit: true }),
    }));
    if (candidates.some((item) => !item.url)) return original;
    const log = logger.withCategory('autoFill');
    try {
        if (!(await hasBundledModel())) return original;
        const classifier = await getClassifier();
        const scored = [];
        for (const { id, url } of candidates) {
            const results = await classifier(url, prompts);
            const logits = prompts.map((prompt) => toLogit(results?.find?.((r) => r.label === prompt)?.score));
            if (!logits.every(Number.isFinite)) return original;
            scored.push({ id, logits });
        }
        const order = orderByVisualFit(scored);
        if (order === null) return original;
        const picked = [...order, ...rankedIds.slice(shortlist.length)].slice(0, wantCount);
        if (picked.some((id, index) => id !== original[index])) {
            log.info(
                `Visual check reordered picks for ${logger.challengeTag(challenge)}: ${original.join(', ')} → ${picked.join(', ')}`,
                null,
            );
        }
        return picked;
    } catch (error) {
        log.warning(`Visual check unavailable for ${logger.challengeTag(challenge)}: ${error.message || error}`, null);
        return original;
    }
};

const __resetForTests = () => {
    classifierPromise = undefined;
    bundledPromise = undefined;
    cliAssetRoot = undefined;
};

module.exports = {
    rankVisually,
    hasBundledModel,
    orderByVisualFit,
    challengePrompts,
    descriptionLead,
    __resetForTests,
};
