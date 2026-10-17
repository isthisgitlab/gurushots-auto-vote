/**
 * The Snap turbo game: ten photos, each answered yes or no by the local vision model. Any answer counts and the
 * tenth wins the turbo. This never opens the classic game (get_challenge_turbo makes the server swap a classic game
 * in on a Snap challenge), and an answer is never sent twice: the next run resumes from the server's position.
 */

import { startTurboSession, submitSnapVote } from '../../api/turbo';
import { markSnapUnavailable } from '../../services/turboRunLock';
import { hasBundledModel, judgeSnapImage, SNAP_CAPTION_MAX_CHARS, snapPrompts } from '../../services/visionVerifier';
import { getRandomDelay, sleep } from '../../timing';
import * as logger from '../../logger';

import type { Challenge, SnapGameResult, SnapStopReason } from '../../types/gurushots';

// The time one photo takes, judging included: a person reads the question and looks.
const SNAP_PACE_MIN_MS = 3000;
const SNAP_PACE_MAX_MS = 6000;
// submit_snap_vote's answer for a session that no longer exists.
const SNAP_SESSION_DEAD = 1105;
// Consecutive runs of one challenge that end without landing an answer for a transient reason before it is left alone.
const SNAP_MAX_TRANSIENT_RUNS = 3;

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

/**
 * Plays (or resumes) the Snap game of one challenge. A missing model, a withdrawn game, an unreadable question, a
 * dead session and an answer the server refused mark the challenge unavailable. A failed judgment, a failed or
 * unusable session open, an answer request that got no response from the server and a session that runs out of
 * photos are transient and leave it open for the next pass; the third such run in a row marks it unavailable, and
 * a run that wins, or that lands answers before failing, starts that count again.
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
            return stop(stopReason);
        }
        const runs = (transientRuns.get(key) ?? 0) + 1;
        if (runs >= SNAP_MAX_TRANSIENT_RUNS) {
            transientRuns.delete(key);
            markSnapUnavailable(challenge.id);
            log.warning(
                `${tag} Snap ended without an answer ${SNAP_MAX_TRANSIENT_RUNS} runs in a row; left alone for the rest of the session`,
                null,
            );
        } else {
            transientRuns.set(key, runs);
        }
        return stop(stopReason);
    };

    // The model answers every photo; without it nothing is asked of the server, so the session stays untouched.
    if (!(await hasBundledModel())) {
        markSnapUnavailable(challenge.id);
        log.info(`${tag} Snap needs the vision model, which this build does not include`, null);
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
    if (!snapPrompts(session.caption)) {
        markSnapUnavailable(challenge.id);
        log.warning(
            `${tag} Snap question not understood: ${JSON.stringify(session.caption.slice(0, SNAP_CAPTION_MAX_CHARS))}`,
            null,
        );
        return stop('unparsed-caption');
    }

    for (let index = session.position; index < session.images.length; index++) {
        if (isCancelled()) return stop('cancelled');
        const image = session.images[index];
        const startedAt = now();
        const judgment = await judgeSnapImage(session.caption, image);
        if (!judgment) {
            log.warning(`${tag} Snap photo ${index + 1}/${total} could not be judged`, null);
            return stopTransient('judge-failed');
        }
        const remaining = pace() - (now() - startedAt);
        if (remaining > 0) await wait(remaining);

        const vote = await submitSnapVote(session.sessionId, image.imageId, judgment.answer, token);
        if (vote.unclear) {
            log.warning(
                `${tag} Snap answer ${index + 1}/${total} may have landed; the next run resumes from the server`,
                null,
            );
            return stop('vote-unclear');
        }
        if (vote.errorCode === SNAP_SESSION_DEAD) {
            markSnapUnavailable(challenge.id);
            log.warning(`${tag} Snap session ended (error_code=${SNAP_SESSION_DEAD})`, null);
            return stop('unavailable');
        }
        if (!vote.ok) {
            // A server that answered with a refusal keeps refusing it, so the challenge is left alone for the
            // session. A request that got no answer from the server (offline, rate limited, signed out) is transient.
            if (!vote.serverAnswered) {
                log.warning(`${tag} Snap answer ${index + 1}/${total} got no answer from the server`, null);
                return stopTransient('request-failed');
            }
            markSnapUnavailable(challenge.id);
            log.warning(`${tag} Snap answer ${index + 1}/${total} was refused`, null);
            return stop('request-failed');
        }

        answered++;
        if (vote.communityPct !== null) agreements.push(vote.communityPct);
        log.info(
            `${tag} Snap ${index + 1}/${total}: ${judgment.answer} (yes=${judgment.yesLogit.toFixed(2)} no=${judgment.noLogit.toFixed(2)}) community=${vote.communityPct ?? 'n/a'}%`,
            null,
        );
        if (vote.completed) {
            transientRuns.delete(String(challenge.id));
            return stop('completed', true);
        }
    }

    // Every photo answered and no win reported: the server's count differs from the session's images.
    log.warning(`${tag} Snap session ran out of photos without completing`, null);
    return stopTransient('request-failed', true);
};

const __resetSnapTransientRunsForTests = (): void => {
    transientRuns.clear();
};

export { runSnapGame, __resetSnapTransientRunsForTests };
