/** Turbo mini-game (earn) and apply-turbo calls on the /rest/ web API: WEB header profile (x-env: WEB, x-api-version: 13). */

import { makePostRequest, postOnce } from './api-client';
import { ENDPOINTS, createWebHeaders, makeRequireValue } from './constants';
import { ID_PATTERN } from '../format/photoUrl';
import { isInteger } from '../numbers';
import { isPlainObject } from '../plainObject';
import { validateVideoMediaUrl } from '../platform/videoMedia';

import type {
    ActionResult,
    ChallengeTurboResponse,
    SnapImage,
    SnapVoteResponse,
    SnapVoteResult,
    StartTurboSessionResponse,
    SuccessResponse,
    TurboBattleSet,
    TurboSelectionResponse,
    TurboSelectionResult,
    TurboSession,
} from '../types/gurushots';
import type { SnapScoreResponse, SnapScoreResult, SnapScoreVideo } from '../types/gurushots/voting';

const TURBO_SELECTION_DELAY_MS = 1200;

const requireValue = makeRequireValue('turbo');

const isHexId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);

const isAllowedSnapVideoUrl = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    try {
        validateVideoMediaUrl(value);
        return true;
    } catch {
        return false;
    }
};

const hasValidPosition = (position: unknown, count: number): position is number =>
    isInteger(position) && position >= 0 && position < count;

// The server position indexes the original list. Reject the whole session when one member is malformed so that an
// omitted item cannot move the next answer onto a different image.
const parseSnapImages = (images: readonly unknown[]): SnapImage[] | null => {
    const parsed: SnapImage[] = [];
    for (const image of images) {
        if (!isPlainObject(image) || !isHexId(image.image_id) || !isHexId(image.member_id)) return null;
        parsed.push({ imageId: image.image_id, memberId: image.member_id });
    }
    return parsed.length > 0 ? parsed : null;
};

const parseSnapScoreVideos = (images: readonly unknown[]): SnapScoreVideo[] | null => {
    const parsed: SnapScoreVideo[] = [];
    for (const image of images) {
        if (
            !isPlainObject(image) ||
            !isHexId(image.image_id) ||
            !isHexId(image.member_id) ||
            image.media_type !== 'video' ||
            typeof image.duration_ms !== 'number' ||
            !Number.isFinite(image.duration_ms) ||
            image.duration_ms <= 0 ||
            !isAllowedSnapVideoUrl(image.media_url)
        ) {
            return null;
        }
        parsed.push({
            imageId: image.image_id,
            memberId: image.member_id,
            durationMs: Math.max(1, Math.round(image.duration_ms)),
            mediaUrl: image.media_url,
        });
    }
    return parsed.length > 0 ? parsed : null;
};

const parseSnapSession = (response: StartTurboSessionResponse): TurboSession | null => {
    if (
        response.session_type !== '2.0' ||
        typeof response.session_id !== 'string' ||
        response.session_id === '' ||
        !Array.isArray(response.images) ||
        typeof response.caption !== 'string'
    ) {
        return null;
    }
    if (response.kind === 'score') {
        if (!isInteger(response.max_score) || response.max_score < 2) return null;
        const images = parseSnapScoreVideos(response.images);
        if (!images || !hasValidPosition(response.position, images.length)) return null;
        return {
            kind: 'score',
            sessionId: response.session_id,
            position: response.position,
            caption: response.caption,
            maxScore: response.max_score,
            images,
        };
    }
    if (response.kind !== undefined) return null;
    const images = parseSnapImages(response.images);
    if (!images || !hasValidPosition(response.position, images.length)) return null;
    return {
        kind: 'snap',
        sessionId: response.session_id,
        position: response.position,
        caption: response.caption,
        images,
    };
};

const emptySnapScoreResult = (unclear: boolean): SnapScoreResult => ({
    ok: false,
    completed: false,
    communityAvg: null,
    tooEarly: false,
    retryAfterMs: null,
    sessionEnded: false,
    restartRequired: false,
    unclear,
    serverAnswered: false,
});

const snapScoreResult = (body: SnapScoreResponse, accepted: boolean): SnapScoreResult => ({
    // A response body on an HTTP refusal is metadata for a refusal, not proof that the answer landed.
    ok: accepted && body.success === true,
    completed: accepted && body.completed === true,
    communityAvg:
        typeof body.community_avg === 'number' && Number.isFinite(body.community_avg) ? body.community_avg : null,
    tooEarly: body.too_early === true,
    retryAfterMs:
        typeof body.retry_after_ms === 'number' && Number.isFinite(body.retry_after_ms) && body.retry_after_ms >= 0
            ? body.retry_after_ms
            : null,
    sessionEnded: body.session_ended === true,
    restartRequired: body.restart_required === true,
    unclear: false,
    serverAnswered: true,
});

/**
 * Fetches the current Turbo battle set for a challenge.
 */
const getChallengeTurbo = async (challengeId: string | number, token: string): Promise<TurboBattleSet | null> => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}`;
    const response = await makePostRequest<ChallengeTurboResponse>(ENDPOINTS.challengeTurbo, headers, data);
    if (!response || !Array.isArray(response.images)) {
        return null;
    }
    return {
        battles: response.images.map((img) => ({
            firstImageId: img.first_image?.id,
            secondImageId: img.second_image?.id,
            isSuccess: img.is_success,
        })),
        maxSelections: response.max_selections,
        requiredSelections: response.required_selections,
    };
};

/**
 * Submits a single Turbo battle pick.
 *
 * @param imageId - The chosen image's id from the battle pair.
 */
const submitTurboSelection = async (
    challengeId: string | number,
    imageId: string,
    token: string,
): Promise<TurboSelectionResult> => {
    requireValue(challengeId, 'challengeId');
    requireValue(imageId, 'imageId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}&image_id=${encodeURIComponent(imageId)}`;
    const response = await makePostRequest<TurboSelectionResponse>(ENDPOINTS.submitTurboSelection, headers, data);
    if (!response) {
        return { ok: false, success: false, state: null, scores: null, errorCode: null, raw: null };
    }
    return {
        ok: response.success === true && response.is_successful_selection === true,
        success: response.success === true,
        state: response.state || null,
        scores: response.scores || null,
        errorCode: response.error_code || null,
        raw: response,
    };
};

/**
 * Opens (or reopens) a turbo session. A half-played Snap session comes back with the same id and images and its
 * `position`. Repeating an open is harmless, so it keeps the default retry.
 *
 * @returns null when the request failed or the answer is not a playable session (no photos, or all answered)
 */
const startTurboSession = async (challengeId: string | number, token: string): Promise<TurboSession | null> => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}&supports_scores=true`;
    const response = await makePostRequest<StartTurboSessionResponse>(ENDPOINTS.startTurboSession, headers, data);
    if (!response || response.success !== true) {
        return null;
    }
    if (response.session_type === '1.0') {
        return { kind: 'classic' };
    }
    return parseSnapSession(response);
};

/**
 * Answers one Snap photo. Sent once and never retried: a repeat could land twice.
 */
const submitSnapVote = async (
    sessionId: string,
    imageId: string,
    vote: 'yes' | 'no',
    token: string,
): Promise<SnapVoteResult> => {
    requireValue(sessionId, 'sessionId');
    requireValue(imageId, 'imageId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `session_id=${encodeURIComponent(sessionId)}&image_id=${encodeURIComponent(imageId)}&vote=${vote}`;
    const outcome = await postOnce<SnapVoteResponse>(ENDPOINTS.submitSnapVote, headers, data);
    if (outcome.kind !== 'body') {
        return {
            ok: false,
            completed: false,
            communityPct: null,
            errorCode: null,
            unclear: outcome.kind === 'unclear',
            serverAnswered: false,
        };
    }
    const { body } = outcome;
    return {
        ok: body.success === true,
        completed: body.completed === true,
        communityPct: typeof body.community_pct === 'number' ? body.community_pct : null,
        errorCode: typeof body.error_code === 'number' ? body.error_code : null,
        unclear: false,
        serverAnswered: true,
    };
};

/** Answers one scored Snap video. Sent once except for the runner's explicit too-early retry. */
const submitSnapScore = async (
    sessionId: string,
    imageId: string,
    score: number,
    token: string,
): Promise<SnapScoreResult> => {
    requireValue(sessionId, 'sessionId');
    requireValue(imageId, 'imageId');
    requireValue(token, 'token');
    if (!isInteger(score)) throw new Error('turbo: score must be an integer');
    const headers = createWebHeaders(token);
    const data = `session_id=${encodeURIComponent(sessionId)}&image_id=${encodeURIComponent(imageId)}&score=${score}`;
    const outcome = await postOnce<SnapScoreResponse>(ENDPOINTS.submitSnapScore, headers, data, true);
    if (outcome.kind === 'unclear') {
        return emptySnapScoreResult(true);
    }
    if (outcome.kind === 'body') return snapScoreResult(outcome.body, true);
    return outcome.response ? snapScoreResult(outcome.response, false) : emptySnapScoreResult(false);
};

/**
 * Applies a won Turbo to one of the user's entry images.
 *
 * @param imageId - The user's entry photo id (from member.ranking.entries[].id).
 */
const applyTurbo = async (challengeId: string | number, imageId: string, token: string): Promise<ActionResult> => {
    requireValue(challengeId, 'challengeId');
    requireValue(imageId, 'imageId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}&image_id=${encodeURIComponent(imageId)}`;
    const response = await makePostRequest<SuccessResponse>(ENDPOINTS.setTurbo, headers, data);
    if (!response) {
        return { ok: false, raw: null };
    }
    return {
        ok: response.success === true,
        raw: response,
    };
};

export {
    getChallengeTurbo,
    submitTurboSelection,
    applyTurbo,
    startTurboSession,
    submitSnapVote,
    submitSnapScore,
    TURBO_SELECTION_DELAY_MS,
};
