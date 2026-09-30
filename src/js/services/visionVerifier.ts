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
import * as runtime from '../runtime';
import { appPath } from '../appPaths';
import { entryPhotoUrl } from '../format/photoUrl';
import { oneLine } from '../format/logSafe';
import { visualSubjectWords } from './photoPicker';

import type { ChallengeText, IgnoreWords, PickerPhoto } from '../types/photoPicker';
import type { FillLogger } from '../types/autoFill';
import type * as Transformers from '@huggingface/transformers';
import type { ZeroShotImageClassificationPipeline } from '@huggingface/transformers';
import { errorMessage } from '../errorMessage';

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

let classifierPromise: ReturnType<typeof loadClassifier> | undefined;
let bundledPromise: Promise<boolean> | undefined;
let cliAssetRoot: string | undefined;

const getModelLocation = () => {
    if (runtime.isCapacitor() || runtime.isHeadlessService()) return './';
    const path = require('node:path') as typeof import('node:path');
    if (cliAssetRoot) return `${cliAssetRoot}${path.sep}`;
    if (runtime.isElectron() && runtime.isPackaged()) return `${process.resourcesPath}${path.sep}`;
    return appPath('.cache') + path.sep;
};

const isModelBundled = async () => {
    if (runtime.isCapacitor() || runtime.isHeadlessService()) {
        const response = await fetch('vision-model/config.json').catch(() => null);
        return Boolean(response?.ok);
    }
    if (runtime.isCli()) {
        const sea = require('node:sea') as typeof import('node:sea');
        if (sea.isSea()) {
            try {
                sea.getAsset('vision-runtime.sha256');
                return true;
            } catch {
                return false;
            }
        }
    }
    const path = require('node:path') as typeof import('node:path');
    return (require('node:fs') as typeof import('node:fs')).existsSync(
        path.join(getModelLocation(), 'vision-model', 'config.json'),
    );
};

/**
 * Whether this build ships the model. Lite builds (`build:*:lite`) leave it
 * and its inference runtime out, so the visual check is skipped without a
 * warning and the update check stays on the lite downloads.
 */
const hasBundledModel = (): Promise<boolean> => {
    if (!bundledPromise) bundledPromise = isModelBundled();
    return bundledPromise;
};

/**
 * The SEA path loads the package through createRequire, which returns `any`;
 * it is the same package, so it is typed as the module the import path loads.
 */
const loadClassifier = async (): Promise<ZeroShotImageClassificationPipeline> => {
    let transformers: typeof Transformers | undefined;
    if (runtime.isCli()) {
        const sea = require('node:sea') as typeof import('node:sea');
        if (sea.isSea()) {
            const assets = (
                require('./visionCliAssets') as typeof import('./visionCliAssets')
            ).extractVisionCliAssets();
            cliAssetRoot = assets.root;
            const { createRequire } = require('node:module') as typeof import('node:module');
            transformers = createRequire(assets.modulePath)('@huggingface/transformers') as typeof Transformers;
        }
    }
    transformers ||= await import('@huggingface/transformers');
    const { env, pipeline } = transformers;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = getModelLocation();
    if (runtime.isCapacitor() || runtime.isHeadlessService()) {
        // The library types every build's onnx env as Partial; the WebView build this
        // branch runs on always has the wasm backend.
        env.backends.onnx.wasm!.wasmPaths = './';
        env.backends.onnx.wasm!.numThreads = 1;
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
 * @param message - challenge.welcome_message
 */
const descriptionLead = (message: string | undefined): string => {
    if (typeof message !== 'string') return '';
    let text = message
        .replace(/<[^>]*>/g, ' ')
        .replace(
            /&(?:amp|quot|#39|apos|nbsp);/g,
            // The pattern only matches the table's own keys.
            (entity) => HTML_ENTITIES[entity as keyof typeof HTML_ENTITIES],
        )
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
 */
const challengePrompts = (challenge: ChallengeText | null | undefined, ignoreWords: IgnoreWords = null): string[] => {
    const subject = visualSubjectWords(challenge, ignoreWords);
    if (subject.length === 0) return [];
    const lead = descriptionLead(challenge?.welcome_message);
    return [`a photo of ${subject.join(' ')}`, ...(lead ? [lead] : [])];
};

/**
 * @param score - a missing score reads as NaN, which the caller rejects
 */
const toLogit = (score: number | undefined): number => {
    const p = Math.min(Math.max(score as number, 1e-12), 1 - 1e-12);
    return Math.log(p / (1 - p));
};

/**
 * Order shortlisted photos by visual fit. Each entry carries one logit per
 * prompt and a photo's fit is their mean: taking the best prompt instead let
 * fog, read by the title prompt as "smoke filled scenes", set a bar that
 * rejected the real smoke photo the description prompt preferred.
 *
 * @param scored - in tag/popularity order
 * @returns ids, accepted photos first; null to abstain
 */
const orderByVisualFit = (
    scored: Array<{ id: string; logits: number[] }>,
    onAccepted?: (ids: Set<string>) => void,
): string[] | null => {
    if (scored.length === 0) return null;
    const peak = Math.max(...scored.flatMap((item) => item.logits));
    if (peak < ABSTAIN_LOGIT) {
        onAccepted?.(new Set());
        return null;
    }
    const fits = scored.map((item) => ({
        id: item.id,
        fit: item.logits.reduce((sum, logit) => sum + logit, 0) / item.logits.length,
    }));
    const floor = Math.max(...fits.map((item) => item.fit)) - OFF_THEME_MARGIN;
    const accepted = fits.filter((item) => item.fit >= floor);
    const rejected = fits.filter((item) => item.fit < floor).sort((a, b) => b.fit - a.fit);
    onAccepted?.(new Set(accepted.map((item) => item.id)));
    return [...accepted, ...rejected].map((item) => item.id);
};

/**
 * Re-rank the head of a tag-ranked shortlist by what the photos show.
 *
 * @param rankedIds - photo ids, best tag/popularity match first
 * @param eligible - photo records (id + member_id) for the ids
 * @returns wantCount ids (fewer only if rankedIds is shorter)
 */
const rankVisually = async (
    challenge: ChallengeText | null | undefined,
    rankedIds: string[],
    eligible: PickerPhoto[],
    wantCount: number,
    {
        logger,
        ignoreWords = null,
        onVisualEvidence,
    }: { logger: FillLogger; ignoreWords?: IgnoreWords; onVisualEvidence?: (acceptedIds: Set<string>) => void },
): Promise<string[]> => {
    const original = rankedIds.slice(0, wantCount);
    const prompts = challengePrompts(challenge, ignoreWords);
    const log = logger.withCategory('autoFill');
    const keepOriginal = (reason: string, detail: unknown = null) => {
        log.info(`Visual check ${reason} for ${logger.challengeTag(challenge)}; kept tag order`, detail);
        return original;
    };
    if (prompts.length === 0 || rankedIds.length === 0) return keepOriginal('skipped: no visual subject or candidates');
    const byId = new Map(eligible.map((photo) => [String(photo.id), photo]));
    const shortlist = rankedIds.slice(0, Math.max(MAX_IMAGES, wantCount));
    const candidates = shortlist.map((id) => ({
        id,
        url: entryPhotoUrl(byId.get(String(id)), { size: 256, fit: true }),
    }));
    if (candidates.some((item) => !item.url)) return keepOriginal('skipped: candidate photo URL unavailable');
    try {
        if (!(await hasBundledModel())) return keepOriginal('skipped: model unavailable');
        const classifier = await getClassifier();
        const scored: Array<{ id: string; logits: number[] }> = [];
        for (const { id, url } of candidates) {
            // Every url was checked non-null above.
            const results = await classifier(url as string, prompts);
            const logits = prompts.map((prompt) => toLogit(results?.find?.((r) => r.label === prompt)?.score));
            if (!logits.every(Number.isFinite)) return keepOriginal('found invalid model scores');
            scored.push({ id, logits });
        }
        const order = orderByVisualFit(scored, onVisualEvidence);
        const detail = { prompts, scores: scored };
        if (order === null) return keepOriginal('abstained', detail);
        const picked = [...order, ...rankedIds.slice(shortlist.length)].slice(0, wantCount);
        const changed = picked.some((id, index) => id !== original[index]);
        const outcome = changed
            ? `reordered picks for ${logger.challengeTag(challenge)}: ${original.map(oneLine).join(', ')} → ${picked.map(oneLine).join(', ')}`
            : `kept tag order for ${logger.challengeTag(challenge)}: no higher-fit replacement`;
        log.info(`Visual check ${outcome}`, detail);
        return picked;
    } catch (error) {
        log.warning(
            `Visual check unavailable for ${logger.challengeTag(challenge)}: ${errorMessage(error) || error}`,
            null,
        );
        return original;
    }
};

const __resetForTests = () => {
    classifierPromise = undefined;
    bundledPromise = undefined;
    cliAssetRoot = undefined;
};

export { rankVisually, hasBundledModel, orderByVisualFit, challengePrompts, descriptionLead, __resetForTests };
