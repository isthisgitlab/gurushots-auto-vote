/**
 * The CLI `status` banner: the overview header, the automation lines, the
 * settings and pinned-entries sections, and the boost-window / standing
 * sections fed by one best-effort fetch of the active challenges. The cycle
 * runners and continuous mode live in voting.ts.
 */

import * as logger from '../../logger';
import { formatSettingForLog } from './settings/shared';
import * as settings from '../../settings';
import { effectiveTimezone } from '../../settings/uiDefaults';
import { getMiddleware } from '../../apiFactory';
import { formatDuration } from '../../format/duration';
import { benchmarkGap, benchmarkTarget, parseBenchmarkScores } from '../../format/benchmark';
import { stripTerminalControl } from '../../format/logSafe';
import { isInteger } from '../../numbers';
import { printableChallengeId } from './pin';
import { openBoostWindows } from '../../voting/boostWindow';
import { isMarkedChallenge } from '../../challengeMarks';
import { errorMessage } from '../../errorMessage';

import type { Challenge, RankingTotal } from '../../types/gurushots';
import type { NullEventHandlers } from '../../types/cli';
import type * as actions_handlersModule from '../../ipc/actions.handlers';

// The shared handlers behind the status header's automation lines, built
// lazily on first use (like every command module) so loading this module for
// other commands does not construct the handler set.
type ActionsHandlers = NullEventHandlers<ReturnType<typeof actions_handlersModule.buildHandlers>>;
let _actionsHandlers: ActionsHandlers | undefined;
const actionsHandlers = (): ActionsHandlers =>
    (_actionsHandlers ??= (
        require('../../ipc/actions.handlers') as typeof import('../../ipc/actions.handlers')
    ).buildHandlers());

/**
 * The photos pinned for Boost / Turbo, not a challenge's settings: labelled on their own. Only ids that hold a
 * valid pin are listed, and an id is printed as text: a raw settings write or a hand edit can put anything in a key.
 */
const logPinnedEntries = (userSettings: ReturnType<typeof settings.loadSettings>) => {
    const pinned = Object.keys(userSettings.challenges).flatMap((challengeId) => {
        const { boost, turbo } = settings.getEntryPins(challengeId);
        return boost === null && turbo === null ? [] : [{ challengeId, boost, turbo }];
    });
    if (pinned.length === 0) return;
    logger.withCategory('settings').info('\nPinned entries:');
    for (const { challengeId, boost, turbo } of pinned) {
        logger
            .withCategory('settings')
            .info(
                `  Challenge ${printableChallengeId(challengeId)}: Boost ${boost ?? 'none'}, Turbo ${turbo ?? 'none'}`,
            );
    }
};

/**
 * One challenge's tail in the Standing section: `rank <n>`, plus — when they can be read — the
 * benchmark its rank sits under (the group the format helper names) and the votes still missing
 * to PASS it (`top <n> needs <gap> votes`). Benchmark scores arrive as strings and count only
 * when they parse to whole numbers; a zero vote count is as readable as any other. No gap at
 * rank 1, none once the votes are already past the benchmark; with the votes unreadable, the
 * benchmark's own score is all that can be said.
 */
const rankingTail = (total: RankingTotal): string | null => {
    const rank = total.rank;
    if (!isInteger(rank) || rank <= 0) return null;
    const scores = parseBenchmarkScores(total.benchmark);
    const target = benchmarkTarget(rank);
    if (target === null) return `rank ${rank}`;
    const score = scores[target];
    if (!isInteger(score)) return `rank ${rank}`;
    const votes = total.votes;
    if (!isInteger(votes)) {
        return `rank ${rank} — top ${target} at ${score} votes`;
    }
    const gap = benchmarkGap(rank, votes, scores);
    return gap !== null ? `rank ${rank} — top ${gap.target} needs ${gap.n} votes` : `rank ${rank}`;
};

/**
 * One challenge's team-match line in the Standing section: the two sides' vote totals, then the
 * member's own standing among the match participants — or "not running" once the match is over.
 * A standing that could not be read from the rosters prints the totals alone.
 */
const teamMatchLine = (challenge: Challenge): string | null => {
    const match = challenge?.teamMatch;
    if (!match) return null;
    const base = `  • ${stripTerminalControl(challenge.title)} — us ${match.us.votes}, them ${match.them.votes}`;
    // Absent means running; an explicit false says the match is over.
    if (match.running === false) return `${base} — not running`;
    if (!match.me) return base;
    return match.me.kind === 'active'
        ? `${base} — #${match.me.position} of ${match.me.activeSlots} active${
              match.me.cushion === null ? '' : ` (+${match.me.cushion} over standby)`
          }`
        : `${base} — standby, ${match.me.votesToActive} votes to active`;
};

/**
 * The banner's opening lines: the header, the mode, and the sign-in state — with the token
 * line only when signed in.
 */
const logOverview = (userSettings: ReturnType<typeof settings.loadSettings>, isAuthenticated: boolean) => {
    logger.withCategory('ui').info('=== GuruShots Auto Voter - Status ===');
    logger
        .withCategory('ui')
        .info(`Mode: ${userSettings.app.mock ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}`);
    logger
        .withCategory('authentication')
        .info(`Authentication: ${isAuthenticated ? '✅ Authenticated' : '❌ Not authenticated'}`);
    if (isAuthenticated) {
        logger.withCategory('authentication').info(`Token: ${userSettings.auth.token ? '✅ Present' : '❌ Missing'}`);
    }
};

/**
 * The header's automation lines — the CLI parity of the GUI header indicators:
 * whether auto-claim is on, and whether an auto-join is armed. A fresh CLI
 * process cannot know the next claim time (it lives in the running app's
 * process state), so only the state itself is printed, never a next-claim
 * time. Best-effort like the rest of status: a failed reply, or a handler
 * that throws, prints its own "could not be read" line and never breaks the
 * command.
 */
const logAutomationStatus = async () => {
    const printState = (label: string, state: 'on' | 'off' | 'armed' | null) =>
        logger.withCategory('ui').info(state === null ? `${label}: could not be read` : `${label}: ${state}`);
    try {
        const claim = await actionsHandlers()['get-auto-claim-status'](null);
        printState('Auto-claim', claim?.success === true ? (claim.enabled ? 'on' : 'off') : null);
    } catch {
        printState('Auto-claim', null);
    }
    try {
        const join = await actionsHandlers()['get-auto-join-active'](null);
        printState('Auto-join', join?.success === true ? (join.active ? 'armed' : 'off') : null);
    } catch {
        printState('Auto-join', null);
    }
};

/**
 * The Settings section: the app-level preferences, then every challenge that holds values of
 * its own, formatted and masked like every other settings print.
 */
const logSettingsSection = (userSettings: ReturnType<typeof settings.loadSettings>) => {
    const min = userSettings.app.checkFrequencyMin;
    const max = userSettings.app.checkFrequencyMax;
    logger.withCategory('settings').info('\nSettings:');
    logger.withCategory('settings').info(`  Theme: ${userSettings.app.theme}`);
    logger.withCategory('settings').info(`  Language: ${userSettings.app.language}`);
    logger.withCategory('settings').info(`  Timezone: ${effectiveTimezone(userSettings.app.timezone)}`);
    logger.withCategory('settings').info(`  API Timeout: ${userSettings.app.apiTimeout}s`);
    logger
        .withCategory('settings')
        .info(`  Check Frequency: ${min === max ? `${min}min` : `${min}–${max}min (random per cycle)`}`);
    logger
        .withCategory('settings')
        .info(
            `  Last Minute Check Frequency: ${settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global')}min`,
        );

    const withValues = Object.entries(userSettings.challenges).flatMap(([challengeId, { values }]) =>
        values === undefined ? [] : [{ challengeId, values }],
    );
    if (withValues.length > 0) {
        logger.withCategory('settings').info('\nChallenge Settings:');
        withValues.forEach(({ challengeId, values }) => {
            logger.withCategory('settings').info(`  Challenge ${printableChallengeId(challengeId)}:`);
            Object.entries(values).forEach(([key, value]) => {
                logger.withCategory('settings').info(`    ${key}: ${formatSettingForLog(key, value)}`);
            });
        });
    }
};

/**
 * ONE best-effort fetch of the active challenges behind the boost-window and Standing sections:
 * `challenges` is null when the call failed (each section then prints a note and status goes on),
 * `fetchError` the failure for that note.
 */
const fetchChallengesForStatus = async (): Promise<{ challenges: Challenge[] | null; fetchError: unknown }> => {
    try {
        const resp = await getMiddleware().getActiveChallenges();
        return { challenges: Array.isArray(resp?.challenges) ? resp.challenges : [], fetchError: null };
    } catch (err) {
        return { challenges: null, fetchError: err };
    }
};

/** The note a section prints when the shared fetch failed: the error's message, or the thrown value itself. */
const logUnavailable = (fetchError: unknown) =>
    logger.withCategory('ui').info(`  (unavailable — ${errorMessage(fetchError) || fetchError})`);

/** The Boost Window Open section: which challenges' boost windows are open now, and for how long. */
const logBoostWindows = (challenges: Challenge[] | null, fetchError: unknown) => {
    logger.withCategory('ui').info('\nBoost Window Open:');
    if (challenges === null) {
        logUnavailable(fetchError);
        return;
    }
    const open = openBoostWindows(challenges, Math.floor(Date.now() / 1000));
    if (open.length === 0) {
        logger.withCategory('ui').info('  None');
        return;
    }
    open.forEach(({ title, remaining }) => {
        const suffix = remaining == null ? 'no expiry' : formatDuration(remaining);
        logger.withCategory('ui').info(`  • ${title} — ${suffix}`);
    });
};

/** The Standing section: each challenge's rank with its benchmark gap, then its team-match standing. */
const logStanding = (challenges: Challenge[] | null, fetchError: unknown) => {
    logger.withCategory('ui').info('\nStanding:');
    if (challenges === null) {
        logUnavailable(fetchError);
        return;
    }
    const lines = challenges.flatMap((challenge) => {
        // A marked challenge's rank cannot be read: say so instead of a line
        // built on data the actions refuse.
        if (isMarkedChallenge(challenge)) {
            return [`  • ${stripTerminalControl(challenge.title)} — (data cannot be read)`];
        }
        const total = challenge?.member?.ranking?.total;
        const tail = total ? rankingTail(total) : null;
        return [
            tail === null ? null : `  • ${stripTerminalControl(challenge.title)} — ${tail}`,
            teamMatchLine(challenge),
        ].filter((line): line is string => line !== null);
    });
    if (lines.length === 0) {
        logger.withCategory('ui').info('  None');
        return;
    }
    lines.forEach((line) => logger.withCategory('ui').info(line));
};

const showStatus = async () => {
    const userSettings = settings.loadSettings();
    const isAuthenticated = getMiddleware().isAuthenticated();

    logOverview(userSettings, isAuthenticated);
    await logAutomationStatus();
    logSettingsSection(userSettings);
    logPinnedEntries(userSettings);

    // Boost-window status (the CLI parity of the GUI banner, no anchors) and the member's
    // standing: both fed by ONE best-effort fetch of the active challenges — a failed/offline
    // call prints a note under each section and never crashes status. The boost list reuses
    // the engine's own predicate so there is no duplicated boost-window logic.
    if (isAuthenticated) {
        const { challenges, fetchError } = await fetchChallengesForStatus();
        logBoostWindows(challenges, fetchError);
        logStanding(challenges, fetchError);
    }

    logger.withCategory('ui').info('\nTo change mode, run: login');
};

export { showStatus, rankingTail };
