/**
 * The Snap turbo game: ten photos, each answered yes or no by the local vision model. Any answer counts and the
 * tenth wins the turbo; a build without the model answers yes to every photo when `snapYesWithoutModel` is on. This
 * never opens the classic game (get_challenge_turbo makes the server swap a classic game in on a Snap challenge), and
 * an answer is never sent twice: the next run resumes from the server's position.
 */

import * as settings from '../../settings';
import { startTurboSession, submitSnapScore, submitSnapVote } from '../../api/turbo';
import { clearSnapAutoCooldown, markSnapUnavailable, startSnapAutoCooldown } from '../../services/turboRunLock';
import {
    hasBundledModel,
    judgeSnapImage,
    judgeSnapVideoFrames,
    SNAP_CAPTION_MAX_CHARS,
    snapPrompts,
} from '../../services/visionVerifier';
import type { SnapJudgment } from '../../services/visionVerifier';
import { getRandomDelay, sleep } from '../../timing';
import * as logger from '../../logger';
import { platform } from '../../platform/port';

import type { Challenge, SnapGameResult, SnapImage, SnapStopReason, TurboSession } from '../../types/gurushots';
import type { SnapScoreResult, SnapScoreVideo } from '../../types/gurushots/voting';

// The time one photo takes, judging included: a person reads the question and looks.
const SNAP_PACE_MIN_MS = 3000;
const SNAP_PACE_MAX_MS = 6000;
// submit_snap_vote's answer for a session that no longer exists.
const SNAP_SESSION_DEAD = 1105;
// Consecutive runs of one challenge that end without landing an answer for a transient reason before it is left alone.
const SNAP_MAX_TRANSIENT_RUNS = 3;
const SNAP_SCORE_FRAME_POSITIONS = [0.2, 0.5, 0.8] as const;
const SNAP_SCORE_RETRY_COUNT = 2;
const SNAP_SCORE_RETRY_MIN_MS = 100;
const SNAP_SCORE_RETRY_MAX_MS = 30_000;

// Per challenge: how many consecutive runs ended without landing an answer for a transient reason.
const transientRuns = new Map<string, number>();

/** What a caller can tell a turbo game. */
export interface TurboGameOptions {
    /** Asked before each Snap photo; true stops the game. Absent: never cancelled (a manual run). */
    isCancelled?: () => boolean;
}

/** The cancellation, the clock, the pacing draw and the wait, replaceable so a test is deterministic. */
export interface SnapGameDeps extends TurboGameOptions {
    now?: () => number;
    /** ms one photo should take in all. */
    pace?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

type SnapRoundResult =
    | { kind: 'landed'; completed: boolean; agreement: number | null; message: string }
    | { kind: 'stop'; reason: SnapStopReason; transient: boolean; unavailable: boolean };

type PlayableSnapSession = Exclude<TurboSession, { kind: 'classic' }>;

interface SnapRoundDeps {
    isCancelled: () => boolean;
    now: () => number;
    pace: () => number;
    sleep: (ms: number) => Promise<void>;
}

const stoppedRound = (reason: SnapStopReason, transient = false, unavailable = false): SnapRoundResult => ({
    kind: 'stop',
    reason,
    transient,
    unavailable,
});

const waitForSnapAnswer = async (startedAt: number, clipDurationMs: number, deps: SnapRoundDeps): Promise<boolean> => {
    const remaining = deps.pace() + clipDurationMs - (deps.now() - startedAt);
    if (remaining > 0) await deps.sleep(remaining);
    return !deps.isCancelled();
};

const isExplicitTooEarlyRefusal = (vote: SnapScoreResult): boolean =>
    !vote.ok && vote.serverAnswered && !vote.unclear && vote.tooEarly && !vote.sessionEnded && !vote.restartRequired;

const scoreRetryDelayMs = (vote: SnapScoreResult): number =>
    Math.min(SNAP_SCORE_RETRY_MAX_MS, Math.max(SNAP_SCORE_RETRY_MIN_MS, vote.retryAfterMs ?? SNAP_SCORE_RETRY_MIN_MS));

const submitSnapScoreWithRetries = async (
    sessionId: string,
    imageId: string,
    score: number,
    token: string,
    deps: SnapRoundDeps,
): Promise<SnapScoreResult | null> => {
    let vote = await submitSnapScore(sessionId, imageId, score, token);
    for (let retry = 0; isExplicitTooEarlyRefusal(vote) && retry < SNAP_SCORE_RETRY_COUNT; retry++) {
        await deps.sleep(scoreRetryDelayMs(vote));
        if (deps.isCancelled()) return null;
        vote = await submitSnapScore(sessionId, imageId, score, token);
    }
    return vote;
};

const playSnapPhotoRound = async (
    sessionId: string,
    caption: string,
    image: SnapImage,
    token: string,
    modelAnswers: boolean,
    deps: SnapRoundDeps,
): Promise<SnapRoundResult> => {
    const startedAt = deps.now();
    let answer: SnapJudgment['answer'] = 'yes';
    let basis = 'no vision model';
    if (modelAnswers) {
        const judgment = await judgeSnapImage(caption, image);
        if (!judgment) return stoppedRound('judge-failed', true);
        answer = judgment.answer;
        basis = `yes=${judgment.yesLogit.toFixed(2)} no=${judgment.noLogit.toFixed(2)}`;
    }
    if (!(await waitForSnapAnswer(startedAt, 0, deps))) return stoppedRound('cancelled');
    const vote = await submitSnapVote(sessionId, image.imageId, answer, token);
    if (vote.unclear) return stoppedRound('vote-unclear');
    if (vote.errorCode === SNAP_SESSION_DEAD || !vote.serverAnswered) return stoppedRound('request-failed', true);
    if (!vote.ok) return stoppedRound('request-failed', false, true);
    return {
        kind: 'landed',
        completed: vote.completed,
        agreement: vote.communityPct,
        message: `${answer} (${basis}) community=${vote.communityPct ?? 'n/a'}%`,
    };
};

const playSnapScoreRound = async (
    sessionId: string,
    caption: string,
    maxScore: number,
    image: SnapScoreVideo,
    token: string,
    modelAnswers: boolean,
    deps: SnapRoundDeps,
): Promise<SnapRoundResult> => {
    const startedAt = deps.now();
    let score = maxScore;
    let basis = 'no vision model';
    if (modelAnswers) {
        try {
            const frames = await platform().assets.videoFrames(
                image.mediaUrl,
                image.durationMs,
                SNAP_SCORE_FRAME_POSITIONS,
            );
            const judged = await judgeSnapVideoFrames(caption, frames, maxScore);
            if (judged === null) return stoppedRound('judge-failed', true);
            score = judged;
            basis = `score=${score}`;
        } catch (error) {
            logger.withCategory('turbo').warning(`Snap video judgment unavailable: ${String(error)}`, null);
            return stoppedRound('judge-failed', true);
        }
    }
    if (!(await waitForSnapAnswer(startedAt, image.durationMs, deps))) return stoppedRound('cancelled');
    const vote = await submitSnapScoreWithRetries(sessionId, image.imageId, score, token, deps);
    if (vote === null) return stoppedRound('cancelled');
    if (vote.unclear) return stoppedRound('vote-unclear');
    if (!vote.ok) return stoppedRound('request-failed', true);
    const community = vote.communityAvg === null ? '' : ` community=${vote.communityAvg}`;
    return {
        kind: 'landed',
        completed: vote.completed,
        agreement: null,
        message: `${score}/${maxScore} (${basis})${community}`,
    };
};

const playSnapRounds = async (
    session: PlayableSnapSession,
    token: string,
    modelAnswers: boolean,
    deps: SnapRoundDeps,
    finishRound: (result: SnapRoundResult, index: number) => SnapGameResult | null,
    cancelled: () => SnapGameResult,
): Promise<SnapGameResult | null> => {
    if (session.kind === 'snap') {
        for (const [offset, image] of session.images.slice(session.position).entries()) {
            if (deps.isCancelled()) return cancelled();
            const outcome = await playSnapPhotoRound(
                session.sessionId,
                session.caption,
                image,
                token,
                modelAnswers,
                deps,
            );
            const result = finishRound(outcome, session.position + offset);
            if (result) return result;
        }
        return null;
    }
    for (const [offset, image] of session.images.slice(session.position).entries()) {
        if (deps.isCancelled()) return cancelled();
        const outcome = await playSnapScoreRound(
            session.sessionId,
            session.caption,
            session.maxScore,
            image,
            token,
            modelAnswers,
            deps,
        );
        const result = finishRound(outcome, session.position + offset);
        if (result) return result;
    }
    return null;
};

/**
 * Plays (or resumes) the Snap game of one challenge. A withdrawn game, an unreadable question, and a confirmed photo
 * refusal mark the challenge unavailable. A missing model with `snapYesWithoutModel` off stops the
 * run without a request and marks nothing, so turning the setting on takes effect on the next pass. A failed
 * judgment, a failed or unusable session open, an answer request that got no response from the server and a session
 * that runs out of photos are transient. Three zero-progress transient runs start a 15-minute automatic cooldown.
 */
const runSnapGame = async (
    challenge: Challenge,
    token: string,
    {
        isCancelled = () => false,
        now = Date.now,
        pace = () => getRandomDelay(SNAP_PACE_MIN_MS, SNAP_PACE_MAX_MS),
        sleep: wait = sleep,
    }: SnapGameDeps = {},
): Promise<SnapGameResult> => {
    const log = logger.withCategory('turbo');
    const tag = logger.challengeTag(challenge);
    let total = 0;
    let answered = 0;
    const agreements: number[] = [];
    const stop = (stopReason: SnapStopReason, won = false): SnapGameResult => ({
        answered,
        total,
        meanAgreement: agreements.length > 0 ? agreements.reduce((sum, pct) => sum + pct, 0) / agreements.length : null,
        won,
        stopReason,
    });

    // A run that lands an answer has made progress and starts the count again; only one that landed none (or that
    // ran out of photos) counts.
    const stopTransient = (stopReason: SnapStopReason, counts = answered === 0): SnapGameResult => {
        const key = String(challenge.id);
        if (!counts) {
            transientRuns.delete(key);
            clearSnapAutoCooldown(challenge.id);
            return stop(stopReason);
        }
        const runs = (transientRuns.get(key) ?? 0) + 1;
        if (runs >= SNAP_MAX_TRANSIENT_RUNS) {
            transientRuns.delete(key);
            startSnapAutoCooldown(challenge.id, now());
            log.warning(
                `${tag} Snap ended without an answer ${SNAP_MAX_TRANSIENT_RUNS} runs in a row; automatic play waits 15 minutes`,
                null,
            );
        } else {
            transientRuns.set(key, runs);
        }
        return stop(stopReason);
    };

    // The model answers every photo. Without it, the setting answers yes to all of them; with it off nothing is asked
    // of the server, so the session stays untouched.
    const modelAnswers = await hasBundledModel();
    if (!modelAnswers && settings.getEffectiveSetting('snapYesWithoutModel', null) !== true) {
        log.debug(`${tag} Snap needs the vision model, which this build does not include`, null);
        return stop('no-model');
    }

    const session = await startTurboSession(challenge.id, token);
    if (!session) {
        log.warning(`${tag} could not open a usable Snap session`, null);
        return stopTransient('request-failed');
    }
    if (session.kind === 'classic') {
        markSnapUnavailable(challenge.id);
        log.info(`${tag} Snap is no longer offered for this challenge`, null);
        return stop('withdrawn');
    }

    total = session.images.length;
    if (
        (session.kind === 'snap' && modelAnswers && !snapPrompts(session.caption)) ||
        (session.kind === 'score' && modelAnswers && session.caption.trim() === '')
    ) {
        markSnapUnavailable(challenge.id);
        log.warning(
            `${tag} Snap question not understood: ${JSON.stringify(session.caption.slice(0, SNAP_CAPTION_MAX_CHARS))}`,
            null,
        );
        return stop('unparsed-caption');
    }

    const roundDeps: SnapRoundDeps = { isCancelled, now, pace, sleep: wait };
    const finishRound = (result: SnapRoundResult, index: number): SnapGameResult | null => {
        if (result.kind === 'stop') {
            if (result.unavailable) markSnapUnavailable(challenge.id);
            if (result.reason === 'vote-unclear') {
                log.warning(
                    `${tag} Snap answer ${index + 1}/${total} may have landed; the next run resumes from the server`,
                    null,
                );
            }
            return result.transient ? stopTransient(result.reason) : stop(result.reason);
        }
        answered++;
        transientRuns.delete(String(challenge.id));
        clearSnapAutoCooldown(challenge.id);
        if (result.agreement !== null) agreements.push(result.agreement);
        log.info(`${tag} Snap ${index + 1}/${total}: ${result.message}`, null);
        return result.completed ? stop('completed', true) : null;
    };
    const roundResult = await playSnapRounds(session, token, modelAnswers, roundDeps, finishRound, () =>
        stop('cancelled'),
    );
    if (roundResult) return roundResult;

    // Every photo answered and no win reported: the server's count differs from the session's images.
    log.warning(`${tag} Snap session ran out of photos without completing`, null);
    return stopTransient('request-failed', true);
};

const __resetSnapTransientRunsForTests = (): void => {
    transientRuns.clear();
};

export { runSnapGame, __resetSnapTransientRunsForTests };
