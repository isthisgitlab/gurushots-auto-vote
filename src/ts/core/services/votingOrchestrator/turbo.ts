import * as logger from '../../logger';
import { platform } from '../../platform/port';
import * as settings from '../../settings';
import * as votingLogic from '../VotingLogic';
import * as autoFill from '../autoFill';
import { consumeMission } from '../missions';
import { isCancelled } from '../../voting/cancellation';
import { claimTurboRun, releaseTurboRun, wasManualTurboRunSince } from '../turboRunLock';
import { failureText, oneLine } from '../../format/logSafe';
import { hasBundledModel } from '../visionVerifier';

import type { Challenge, TurboGameResult } from '../../types/gurushots';
import type { ActionContext, PassContext } from './context';

/**
 * Resolve the entry a fill-new turbo lands on: the freshly submitted photo, or
 * — when none could be submitted (full / none / failed) — the configured Turbo
 * Entry, if any.
 *
 *   `skipped` when the challenge left the active list (already logged)
 */
const resolveFillNewTurboTarget = async (
    { challenge, token, fillDeps }: ActionContext,
    configuredImageId: string | null | undefined,
): Promise<{ skipped: true } | { skipped: false; imageId: string | null | undefined }> => {
    const filled = await autoFill.submitNewEntryForAction(challenge, token, fillDeps);
    if (filled.ok) {
        autoFill.reflectNewEntry(challenge, filled.imageId);
        return { skipped: false, imageId: filled.imageId };
    }
    if (filled.reason === 'challenge-gone') {
        // The live re-check confirmed the challenge left the active
        // list — applying turbo to an existing entry on it would just
        // be a second failing call and a confusing log.
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} turbo fill-new: challenge left the active list — turbo skipped`,
                null,
            );
        return { skipped: true };
    }
    if (configuredImageId) {
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} turbo fill-new unavailable (${filled.reason}); applying to existing entry`,
                null,
            );
    }
    return { skipped: false, imageId: configuredImageId };
};

/**
 * fill-new was requested but no fresh photo could be submitted, so the target
 * never resolved. The two ways to land here need different logs: in the
 * on-conflict (or always-blocked) path an entry DOES exist — it has Boost or is
 * pinned for Boost, so turbo cannot go on it and there is no valid fallback; only
 * in always mode on an empty challenge is there genuinely no entry at all.
 */
const logTurboWithoutTarget = (challenge: Challenge) => {
    const log = logger.withCategory('turbo');
    if ((challenge?.member?.ranking?.entries?.length ?? 0) > 0) {
        log.info(
            `${logger.challengeTag(challenge)} turbo fill-new: every entry has Boost or is pinned for Boost — turbo skipped`,
            null,
        );
        return;
    }
    log.info(
        `${logger.challengeTag(challenge)} turbo fill-new: could not submit a fresh photo and there is no existing entry — turbo skipped`,
        null,
    );
};

const applyTurboToEntry = async ({ challenge, token, api }: ActionContext, imageId: string): Promise<boolean> => {
    logger
        .withCategory('turbo')
        .startOperation(`turbo-apply-${challenge.id}`, `Applying turbo to entry ${imageId} on ${challenge.title}`);
    try {
        const result = await api.applyTurbo(challenge.id, imageId, token);
        if (result.ok) {
            // Mark the entry so a boost running later in this same pass avoids it.
            autoFill.reflectEntryFlag(challenge, imageId, 'turbo');
            logger
                .withCategory('turbo')
                .endOperation(`turbo-apply-${challenge.id}`, `Turbo applied to entry ${imageId}`);
            return true;
        }
        logger
            .withCategory('turbo')
            .endOperation(`turbo-apply-${challenge.id}`, null, 'Apply request returned ok=false');
    } catch (error) {
        logger.withCategory('turbo').endOperation(`turbo-apply-${challenge.id}`, null, failureText(error));
    }
    return false;
};

/**
 * @returns whether the turbo landed (what the pass's operation record keeps)
 */
export const runTurboApply = async (ctx: ActionContext): Promise<boolean> => {
    const { challenge, now } = ctx;
    // Auto-apply a won turbo when eligible. emergency:true lets
    // shouldApplyTurbo apply a won turbo near the deadline even if
    // Auto-Apply Turbo (useTurbo) is off for this challenge.
    const turboApply = votingLogic.shouldApplyTurbo(challenge, now, { emergency: true });
    if (!turboApply.apply) {
        // The pin is absolute: while the pinned photo is not in the challenge the turbo waits
        // for it, and while it carries Boost the turbo never fires — both skip here every pass.
        if (turboApply.pinFallback) {
            logger
                .withCategory('turbo')
                .infoT(
                    turboApply.pinFallback === 'gone' ? 'm9f25e7a3d681' : 'm2c58b0e94a76',
                    [logger.challengeTag(challenge)],
                    null,
                );
        }
        return false;
    }

    // Surface the override so an applied turbo on a challenge with
    // Auto-Apply Turbo off is explained rather than looking like a bug.
    if (!settings.getEffectiveSetting('useTurbo', challenge.id.toString())) {
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} Emergency Submit window — applying won turbo despite Auto-Apply Turbo being off`,
                null,
            );
    }

    // Fill-new: submit a fresh photo and turbo that entry instead of an
    // existing one.
    const target = turboApply.fillNew
        ? await resolveFillNewTurboTarget(ctx, turboApply.imageId)
        : { skipped: false, imageId: turboApply.imageId };
    if (target.skipped) return false;
    if (!target.imageId) {
        logTurboWithoutTarget(challenge);
        return false;
    }
    if (
        !turboApply.pinned &&
        !votingLogic.isWithinEmergencyWindow(challenge, now) &&
        settings.getEffectiveSetting('protectUncertainAutoSubmits', challenge.id.toString()) &&
        ctx.entryAges?.isUncertain(challenge.id, target.imageId)
    ) {
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} auto-Turbo skipped for uncertain auto-submitted photo ${oneLine(target.imageId)}`,
                null,
            );
        return false;
    }
    return applyTurboToEntry(ctx, target.imageId);
};

// Snap answers are paced at seconds each, so a pass plays one game and the rest wait for the next pass.
const MAX_SNAP_GAMES_PER_PASS = 1;

// The hint that a model-less build needs `snapYesWithoutModel` for Snap is logged once per process, at info level.
let snapModelHintLogged = false;

export const __resetSnapModelHintForTests = (): void => {
    snapModelHintLogged = false;
};

const turboGameSummary = (result: TurboGameResult): string =>
    result.kind === 'snap'
        ? `answered=${result.answered}/${result.total} meanAgreement=${result.meanAgreement === null ? 'n/a' : `${result.meanAgreement.toFixed(0)}%`} stopReason=${result.stopReason} won=${result.won}`
        : `played=${result.played} correct=${result.correct} flipped=${result.flipped} doubleFailed=${result.doubleFailed} won=${result.won}`;

/** What one try at the Turbo mini-game came to: not played (with why), played (and whether it won), or a game that failed. */
export type TurboEarnOutcome =
    | { kind: 'refused'; reason: string }
    | { kind: 'played'; won: boolean }
    | { kind: 'failed' };

const refused = (reason: string): TurboEarnOutcome => ({ kind: 'refused', reason });

/**
 * Auto-earn turbo by playing the mini-game when eligible. No game has a
 * close-time threshold (it plays whenever a turbo is winnable); a Snap game is
 * skipped in the Android headless service and after the pass's first Snap game.
 * A Snap game also waits, with one info hint per process, in a build without the vision model unless
 * `snapYesWithoutModel` is on.
 * It runs ahead of the timer-ordered deadline actions so a win can be applied in this pass.
 * With Save Turbos for Missions on, starting a game waits (isTurboEarnSaved)
 * unless a "Win Turbo" mission still needs wins; a game already in progress is
 * never held for a mission (the Snap gates above still apply). Every win counts
 * down that mission.
 *
 * With `direct` (a scenario's `earnTurbo`) the Auto-Play Turbo switch is not required; the mode, the Snap rules and cooldown,
 * the vision model, the mission hold and cancellation all still apply.
 *
 * It answers what came of the try (the `earnTurbo` scenario action reads it), and records a game it played in the pass's
 * operation record, so the same game is not tried twice for one challenge in a pass.
 */
export const playAutoTurbo = async (
    challenge: Challenge,
    now: number,
    { api, token, missions, refreshMissionNeeds, turboSnapshot, snapGames, operations }: PassContext,
    options: { direct?: boolean } = {},
): Promise<TurboEarnOutcome> => {
    if (!votingLogic.shouldPlayAutoTurbo(challenge, now, options)) return refused('the turbo cannot be played now');
    const isSnap = challenge.member?.turbo?.mode === 'snap';
    if (isSnap && snapGames.played >= MAX_SNAP_GAMES_PER_PASS) {
        logger
            .withCategory('turbo')
            .debug(`${logger.challengeTag(challenge)} Snap turbo left for a later pass (one Snap game per pass)`, null);
        return refused('a Snap turbo is played once a pass');
    }
    // The Android headless cycle is capped at 120 s; Snap plays from the app, the desktop and the CLI.
    if (isSnap && !platform().capabilities.snapAllowed) {
        logger
            .withCategory('turbo')
            .debug(
                `${logger.challengeTag(challenge)} Snap turbo skipped: the background service cycle is too short`,
                null,
            );
        return refused('a Snap turbo is not played in the background service');
    }
    // Without the vision model a Snap turbo is played only with `snapYesWithoutModel` on; otherwise it is left alone
    // here, with no claim and no operation line on every pass.
    if (isSnap && !(await hasBundledModel()) && settings.getEffectiveSetting('snapYesWithoutModel', null) !== true) {
        const log = logger.withCategory('turbo');
        log.debug(
            `${logger.challengeTag(challenge)} Snap turbo skipped: no vision model and snapYesWithoutModel is off`,
            null,
        );
        if (!snapModelHintLogged) {
            snapModelHintLogged = true;
            log.info(
                'Snap turbos need the vision model, which this build does not include; turn on "Play Snap without the vision model" (snapYesWithoutModel) to play them',
                null,
            );
        }
        return refused('a Snap turbo needs the vision model');
    }
    const savedForMission = votingLogic.isTurboEarnSaved(challenge, now);
    const inProgress = challenge.member?.turbo?.state === 'IN_PROGRESS';
    if ((savedForMission || inProgress) && missions && missions.turbo > 0 && refreshMissionNeeds) {
        const fresh = await refreshMissionNeeds();
        // A saved turbo waits on a fresh count; a game already in progress is finished with the count it has.
        if (!fresh && !inProgress) return refused('the mission need cannot be read');
        if (fresh) missions.turbo = Math.min(missions.turbo, fresh.turbo);
    }
    if (wasManualTurboRunSince(challenge.id, turboSnapshot)) return refused('the turbo was played by hand just now');
    const missionWants = (missions?.turbo ?? 0) > 0;
    if (!missionWants && savedForMission) {
        logger.withCategory('turbo').debug(`${logger.challengeTag(challenge)} Turbo saved for a mission`, null);
        return refused('the turbo is saved for a mission');
    }
    if (!claimTurboRun(challenge.id)) return refused('a turbo game is already running for this challenge');
    const purpose = missionWants ? ` for the turbo mission (${missions?.turbo} to go)` : '';
    logger
        .withCategory('turbo')
        .startOperation(`turbo-earn-${challenge.id}`, `Playing turbo mini-game on ${challenge.title}${purpose}`);
    try {
        const result = await api.runTurboGame(challenge, token, { isCancelled });
        // The game was played: this pass does not try it again for the challenge.
        operations?.mark('earn', String(challenge.id));
        // Only a game that landed an answer, or may have (an unclear one), takes the pass's Snap slot: one that fails
        // first leaves it to the rest.
        if (result.kind === 'snap' && (result.answered > 0 || result.stopReason === 'vote-unclear')) {
            snapGames.played++;
        }
        if (result.won) {
            consumeMission(missions, 'turbo');
            // The API confirmed the win; let this pass's apply decision see it.
            if (challenge.member?.turbo) challenge.member.turbo.state = 'WON';
        }
        logger.withCategory('turbo').endOperation(`turbo-earn-${challenge.id}`, turboGameSummary(result));
        return { kind: 'played', won: result.won === true };
    } catch (error) {
        logger.withCategory('turbo').endOperation(`turbo-earn-${challenge.id}`, null, failureText(error));
        return { kind: 'failed' };
    } finally {
        releaseTurboRun(challenge.id, 'automatic');
    }
};
