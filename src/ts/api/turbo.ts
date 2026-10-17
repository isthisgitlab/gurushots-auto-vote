/** Turbo mini-game (earn) and apply-turbo calls on the /rest/ web API: WEB header profile (x-env: WEB, x-api-version: 13). */

import { makePostRequest, postOnce } from './api-client';
import { ENDPOINTS, createWebHeaders, makeRequireValue } from './constants';
import { ID_PATTERN } from '../format/photoUrl';
import { isInteger } from '../numbers';
import { isPlainObject } from '../plainObject';

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

const TURBO_SELECTION_DELAY_MS = 1200;

const requireValue = makeRequireValue('turbo');

const isHexId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);

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
    const data = `challenge_id=${encodeURIComponent(String(challengeId))}`;
    const response = await makePostRequest<StartTurboSessionResponse>(ENDPOINTS.startTurboSession, headers, data);
    if (!response || response.success !== true) {
        return null;
    }
    if (response.session_type === '1.0') {
        return { kind: 'classic' };
    }
    if (
        response.session_type !== '2.0' ||
        typeof response.session_id !== 'string' ||
        response.session_id === '' ||
        !Array.isArray(response.images) ||
        typeof response.caption !== 'string'
    ) {
        return null;
    }
    // `position` indexes the server's list, so an image dropped here would shift it onto the wrong photo: one
    // malformed element makes the whole session unusable.
    const images: SnapImage[] = [];
    for (const image of response.images) {
        if (!isPlainObject(image) || !isHexId(image.image_id) || !isHexId(image.member_id)) return null;
        images.push({ imageId: image.image_id, memberId: image.member_id });
    }
    const { position } = response;
    if (images.length === 0 || !isInteger(position) || position < 0 || position >= images.length) return null;
    return { kind: 'snap', sessionId: response.session_id, position, caption: response.caption, images };
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
    TURBO_SELECTION_DELAY_MS,
};
