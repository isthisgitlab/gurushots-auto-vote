/**
 * Local image/text check for the highest-ranked fill candidates of ANY
 * challenge. The prompts come from the challenge itself — its title subject
 * and the opening of its description — so no theme is hardcoded. The model is
 * downloaded and checksummed by the build, then shipped with the application.
 *
 * The check only reorders, and never empties a pick. Photos the model finds
 * clearly off-theme move behind the ones it accepts (the rejected ones in
 * order of fit). Among the accepted photos the tag ranking, the model's fit and
 * the photos' votes are weighed together (photoPicker/jointRank.ts) inside each
 * gate group: matched photos stay ahead of unmatched ones and a photo matching
 * more Should Include Tags stays ahead of one matching fewer. Votes come from
 * the caller's `loadVotes` and only for the accepted photos; a failed lookup
 * counts them all as unknown. A challenge with no visual subject ("Guru of The
 * Week", "It's all About Balance"), a failed image fetch, or a failed
 * inference leaves the tag order untouched, and no votes are looked up.
 */
import { platform } from '../platform/port';
import { entryPhotoUrl } from '../format/photoUrl';
import { oneLine } from '../format/logSafe';
import { OFF_THEME_MARGIN, jointOrder, stripTags, visualSubjectWords } from './photoPicker';
import * as lexicon from './semantic/lexicon';

import type { JointBreakdown, JointInput, VoteStat } from './photoPicker/jointRank';
import type { ChallengeText, IgnoreWords, PickerPhoto } from '../types/photoPicker';
import type { FillLogger } from '../types/autoFill';
import type { SnapImage } from '../types/gurushots';
import type { ZeroShotImageClassificationPipeline } from '@huggingface/transformers';
import { errorMessage } from '../errorMessage';
import * as logger from '../logger';

const MAX_IMAGES = 12;
// Thresholds are on SigLIP's logit scale, measured on live GuruShots
// challenges (2026-09-24). A prompt describes something visible when at least
// one shortlisted photo reaches ABSTAIN_LOGIT for it: concrete themes peaked
// between -5.7 (Metal & Wood) and -1.1 (Smoke-Filled Scenes), while
// "Exclusively for GuruShots" (-7.7) and "It's all About Balance" (-7.8) never
// did, so those keep the tag order instead of an arbitrary visual one.
const ABSTAIN_LOGIT = -6.5;
// SigLIP reads 64 text tokens; two sentences of a description fit well within.
const MAX_DESCRIPTION_CHARS = 200;
// GuruShots appends the same rewards/sign-off text to every description.
const BOILERPLATE_RE = /join our challenge|participation reward|elite level reward|allstar level reward|good luck/i;
const HTML_ENTITIES = Object.freeze({ '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' });

let classifierPromise: ReturnType<typeof loadClassifier> | undefined;
let bundledPromise: Promise<boolean> | undefined;

/**
 * Whether this build ships the model. Lite builds (`build:*:lite`) leave it
 * and its inference runtime out, so the visual check is skipped without a
 * warning and the update check stays on the lite downloads. The answer is
 * the platform's, memoized.
 */
const hasBundledModel = (): Promise<boolean> => {
    if (!bundledPromise) bundledPromise = platform().assets.visionModel.bundled();
    return bundledPromise;
};

/**
 * The transformers library and the pipeline come from the platform (the SEA
 * build's extracted runtime, else the package import); the model location,
 * the device and the wasm setup are its answers too.
 */
const loadClassifier = async (): Promise<ZeroShotImageClassificationPipeline> => {
    const visionModel = platform().assets.visionModel;
    const { env, pipeline } = await visionModel.loadTransformers();
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = visionModel.location();
    if (visionModel.device === 'wasm') {
        // The library types every build's onnx env as Partial; the wasm
        // device this branch runs on always has the wasm backend.
        env.backends.onnx.wasm!.wasmPaths = './';
        env.backends.onnx.wasm!.numThreads = 1;
    }
    return pipeline('zero-shot-image-classification', 'vision-model', {
        dtype: 'q8',
        device: visionModel.device,
    });
};

const getClassifier = () => {
    if (!classifierPromise) {
        classifierPromise = loadClassifier();
        // A failed load is not kept: the next call extracts and loads again.
        classifierPromise.catch(() => {
            classifierPromise = undefined;
        });
    }
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
    let text = stripTags(message)
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
 * What the joint ranking of the accepted photos reads: their tier values, a
 * votes lookup that must not reject (rankVisually wraps the caller's), and where
 * the per-photo terms go for the log.
 */
interface JointContext {
    inputs: ReadonlyMap<string, JointInput>;
    loadVotes: (ids: string[]) => Promise<Map<string, VoteStat>>;
    onBreakdown?: (breakdown: JointBreakdown) => void;
}

/**
 * Each photo's fit — the mean of its per-prompt logits; taking the best prompt
 * instead let fog, read by the title prompt as "smoke filled scenes", set a bar
 * that rejected the real smoke photo the description prompt preferred — and the
 * split at the floor, one OFF_THEME_MARGIN below the best fit.
 *
 * @param scored - in tag/popularity order; the accepted photos keep that order
 * @returns null to abstain: no photo reaches ABSTAIN_LOGIT, so the model could not judge the theme
 */
const splitByFit = (scored: Array<{ id: string; logits: number[] }>) => {
    if (scored.length === 0) return null;
    const peak = Math.max(...scored.flatMap((item) => item.logits));
    if (peak < ABSTAIN_LOGIT) return null;
    const fits = scored.map((item) => ({
        id: item.id,
        fit: item.logits.reduce((sum, logit) => sum + logit, 0) / item.logits.length,
    }));
    const floor = Math.max(...fits.map((item) => item.fit)) - OFF_THEME_MARGIN;
    return {
        accepted: fits.filter((item) => item.fit >= floor),
        rejected: fits.filter((item) => item.fit < floor).sort((a, b) => b.fit - a.fit),
        floor,
    };
};

/**
 * The accepted photos in joint order. Two or more are needed for there to be
 * anything to weigh; votes are looked up for them alone.
 */
const jointAccepted = async (
    accepted: Array<{ id: string; fit: number }>,
    floor: number,
    { inputs, loadVotes, onBreakdown }: JointContext,
): Promise<string[]> => {
    const votes = await loadVotes(accepted.map((item) => item.id));
    const { ids, breakdown } = jointOrder(
        accepted.map(({ id, fit }) => ({
            id,
            fit,
            // The ids are the shortlist's, which the caller built the inputs from.
            ...inputs.get(id)!,
            votes: votes.get(id)?.votes ?? 0,
            statsKnown: votes.get(id)?.statsKnown ?? false,
        })),
        { floor },
    );
    onBreakdown?.(breakdown);
    return ids;
};

/**
 * Order shortlisted photos by visual fit. Photos the model finds clearly
 * off-theme go behind the accepted ones, by fit. With `joint` the accepted
 * photos are ordered by theme, fit and votes together (see jointAccepted);
 * without it they keep the incoming order.
 *
 * @param scored - in tag/popularity order
 * @param onAccepted - told which photos fit; never called on an abstain, where
 *   the model could not judge the theme and so holds no evidence either way
 * @returns ids, accepted photos first; null to abstain
 */
const orderByVisualFit = async (
    scored: Array<{ id: string; logits: number[] }>,
    onAccepted?: (ids: Set<string>) => void,
    joint?: JointContext,
): Promise<string[] | null> => {
    const split = splitByFit(scored);
    if (!split) return null;
    const { accepted, rejected, floor } = split;
    onAccepted?.(new Set(accepted.map((item) => item.id)));
    const acceptedIds =
        joint && accepted.length >= 2 ? await jointAccepted(accepted, floor, joint) : accepted.map((item) => item.id);
    return [...acceptedIds, ...rejected.map((item) => item.id)];
};

/**
 * Re-rank the head of a tag-ranked shortlist by what the photos show.
 *
 * @param rankedIds - photo ids, best tag/popularity match first
 * @param eligible - photo records (id + member_id) for the ids
 * @param jointInputs - the tier values of the ranked photos, by id (jointInputsOf)
 * @param loadVotes - the votes of the photos the model accepted, asked only when it accepted two or more
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
        jointInputs,
        loadVotes,
    }: {
        logger: FillLogger;
        ignoreWords?: IgnoreWords;
        onVisualEvidence?: (acceptedIds: Set<string>) => void;
        jointInputs: ReadonlyMap<string, JointInput>;
        loadVotes: (ids: string[]) => Promise<Map<string, VoteStat>>;
    },
): Promise<string[]> => {
    const original = rankedIds.slice(0, wantCount);
    // The prompts tokenise the title in compound mode, which reads the
    // lexicon's table — load it before reading the title. Never rejects.
    await lexicon.isAvailable();
    const prompts = challengePrompts(challenge, ignoreWords);
    const log = logger.withCategory('autoSubmit');
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
        let breakdown: JointBreakdown = {};
        const order = await orderByVisualFit(scored, onVisualEvidence, {
            inputs: jointInputs,
            // A votes lookup that fails must not lose the vision split: the photos count as unknown.
            loadVotes: async (ids) => {
                try {
                    return await loadVotes(ids);
                } catch (error) {
                    log.debug(
                        `Visual check could not read the votes for ${logger.challengeTag(challenge)}: ${errorMessage(error) || error}`,
                        null,
                    );
                    return new Map();
                }
            },
            onBreakdown: (terms) => {
                breakdown = terms;
            },
        });
        const detail = { prompts, scores: scored };
        if (order === null) return keepOriginal('abstained', detail);
        const picked = [...order, ...rankedIds.slice(shortlist.length)].slice(0, wantCount);
        const changed = picked.some((id, index) => id !== original[index]);
        const outcome = changed
            ? `re-ranked picks for ${logger.challengeTag(challenge)}: ${original.map(oneLine).join(', ')} → ${picked.map(oneLine).join(', ')}`
            : `kept pick order for ${logger.challengeTag(challenge)}: no replacement ranked higher`;
        log.info(`Visual check ${outcome}`, { ...detail, joint: breakdown });
        return picked;
    } catch (error) {
        log.warning(
            `Visual check unavailable for ${logger.challengeTag(challenge)}: ${errorMessage(error) || error}`,
            null,
        );
        return original;
    }
};

// A Snap question is "Does the <subject> look <predicate>?"; the predicate's words decide which way it reads.
const SNAP_CAPTION_RE = /^(?:do|does|is|are)\s+(?:the\s+)?(.+?)\s+(?:look|looks|seem|seems|appear|appears)\s+(.+?)\?$/i;
const SNAP_NEGATIVE_RE =
    /\b(?:unnatural|unrealistic|fake|artificial|edited|over-edited|overdone|overprocessed|over-processed|exaggerated)\b/;
const SNAP_POSITIVE_RE = /\b(?:natural|realistic|believable|real|authentic|convincing|plausible)\b/;
// A negation flips what the words around it mean, so a predicate that has one is not read.
const SNAP_NEGATION_RE = /\b(?:not|never|no|hardly|less)\b/;
/** How much of a Snap caption is read (and logged). */
const SNAP_CAPTION_MAX_CHARS = 200;
const SNAP_SCORE_DESCRIPTIONS = [
    'unusable picture',
    'very poor picture quality',
    'poor picture quality',
    'fair picture quality',
    'good picture quality',
    'very good picture quality',
    'excellent picture quality',
] as const;

const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

const jpegBlobFromDataUrl = (frame: string): Blob | null => {
    if (!frame.startsWith(JPEG_DATA_URL_PREFIX)) return null;
    const encoded = frame.slice(JPEG_DATA_URL_PREFIX.length);
    if (encoded === '') return null;
    try {
        const bytes = Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0));
        return new Blob([bytes], { type: 'image/jpeg' });
    } catch {
        return null;
    }
};

const validSnapVideoScoreInput = (caption: string, frames: readonly string[], maxScore: number): boolean =>
    frames.length === 3 && Number.isInteger(maxScore) && maxScore >= 2 && caption.trim() !== '';

const snapVideoScorePrompts = (caption: string): string[] =>
    SNAP_SCORE_DESCRIPTIONS.map((description) => `${description}. Server caption: ${caption}`);

const snapVideoFrameRating = async (
    classifier: Awaited<ReturnType<typeof getClassifier>>,
    frame: string,
    prompts: readonly string[],
    maxScore: number,
): Promise<number | null> => {
    const image = jpegBlobFromDataUrl(frame);
    if (!image) return null;
    const results = await classifier(image, [...prompts]);
    let highestIndex = 0;
    let highestLogit = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < prompts.length; index++) {
        const prompt = prompts[index];
        const score = results?.find?.((result) => result.label === prompt)?.score;
        if (typeof score !== 'number' || !Number.isFinite(score)) return null;
        const logit = toLogit(score);
        // Strictly greater keeps the lower category when two logits tie.
        if (logit > highestLogit) {
            highestIndex = index;
            highestLogit = logit;
        }
    }
    return 1 + (highestIndex * (maxScore - 1)) / (SNAP_SCORE_DESCRIPTIONS.length - 1);
};

const roundedSnapVideoScore = (ratings: readonly number[], maxScore: number): number => {
    const mean = ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
    return Math.min(maxScore, Math.max(1, Math.round(mean)));
};

/**
 * The two text prompts a Snap caption ("Does the soft, even light look natural?") is judged against.
 *
 * @returns null when the caption is not a question of a known shape, or its predicate is negated or mixes a
 * negative word with a positive one
 */
const snapPrompts = (caption: string): { yes: string; no: string } | null => {
    const match = SNAP_CAPTION_RE.exec(caption.trim().slice(0, SNAP_CAPTION_MAX_CHARS));
    if (!match) return null;
    const [, subject, predicate] = match;
    const words = predicate.toLowerCase().replace(/\bun-/g, 'un');
    if (SNAP_NEGATION_RE.test(words)) return null;
    const negative = SNAP_NEGATIVE_RE.test(words);
    const positive = SNAP_POSITIVE_RE.test(words);
    if (negative === positive) return null;
    const yes = `a photo where the ${subject} look ${predicate}`;
    return negative
        ? { yes, no: `a photo where the ${subject} look natural and realistic` }
        : { yes, no: `a photo where the ${subject} look artificial, fake and over-edited` };
};

export interface SnapJudgment {
    answer: 'yes' | 'no';
    yesLogit: number;
    noLogit: number;
}

/**
 * Answers a Snap question about one photo: whichever of the two prompts the model scores higher.
 *
 * @returns null when the caption is not understood, the model is unavailable or it gives no valid score, or (without
 * a log) when `signal` is aborted before the classifier runs
 */
const judgeSnapImage = async (
    caption: string,
    image: SnapImage,
    signal?: AbortSignal,
): Promise<SnapJudgment | null> => {
    const prompts = snapPrompts(caption);
    if (!prompts) return null;
    const url = entryPhotoUrl({ id: image.imageId, member_id: image.memberId }, { size: 512, fit: true });
    if (!url) return null;
    const noJudgment = (reason: string): null => {
        logger.withCategory('turbo').warning(`Snap judgment ${reason}`, null);
        return null;
    };
    try {
        if (!(await hasBundledModel())) return null;
        const classifier = await getClassifier();
        if (signal?.aborted) return null;
        const results = await classifier(url, [prompts.yes, prompts.no]);
        const yesLogit = toLogit(results?.find?.((r) => r.label === prompts.yes)?.score);
        const noLogit = toLogit(results?.find?.((r) => r.label === prompts.no)?.score);
        if (!Number.isFinite(yesLogit) || !Number.isFinite(noLogit)) return noJudgment('found invalid model scores');
        return { answer: yesLogit >= noLogit ? 'yes' : 'no', yesLogit, noLogit };
    } catch (error) {
        return noJudgment(`unavailable: ${errorMessage(error) || error}`);
    }
};

/**
 * Scores three sampled video frames with the bundled local model. This is an uncalibrated sampled-frame heuristic.
 * It does not measure motion or establish whole-video picture quality. An aborted `signal` ends it with null, without
 * a log, before the next frame.
 */
const judgeSnapVideoFrames = async (
    caption: string,
    frames: readonly string[],
    maxScore: number,
    signal?: AbortSignal,
): Promise<number | null> => {
    if (!validSnapVideoScoreInput(caption, frames, maxScore)) return null;
    const prompts = snapVideoScorePrompts(caption);
    try {
        if (!(await hasBundledModel())) return null;
        const classifier = await getClassifier();
        const ratings: number[] = [];
        for (const frame of frames) {
            if (signal?.aborted) return null;
            const rating = await snapVideoFrameRating(classifier, frame, prompts, maxScore);
            if (rating === null) return null;
            ratings.push(rating);
        }
        return roundedSnapVideoScore(ratings, maxScore);
    } catch (error) {
        logger.withCategory('turbo').warning(`Snap video judgment unavailable: ${errorMessage(error) || error}`, null);
        return null;
    }
};

const __resetForTests = () => {
    classifierPromise = undefined;
    bundledPromise = undefined;
};

export {
    rankVisually,
    hasBundledModel,
    orderByVisualFit,
    challengePrompts,
    descriptionLead,
    snapPrompts,
    SNAP_CAPTION_MAX_CHARS,
    SNAP_SCORE_DESCRIPTIONS,
    judgeSnapImage,
    judgeSnapVideoFrames,
    __resetForTests,
};
