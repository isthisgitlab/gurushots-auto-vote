/**
 * CLI voting commands: per-cycle vote runs (manual + strategy),
 * continuous-mode entry point with signal handlers, and the status
 * banner. The scheduling engine itself lives in scheduling/runScheduler;
 * this module is the CLI host (signal handling, process keep-alive,
 * progress logging).
 */

import * as logger from '../../logger';
import { ensureAuthenticated } from '../guards';
import { formatSettingForLog } from './settings/shared';
import * as settings from '../../settings';
import { effectiveTimezone } from '../../settings/uiDefaults';
import { getMiddleware } from '../../apiFactory';
import { createScheduler } from '../../scheduling/runScheduler';
import { formatDateTime } from '../../dateFormat';
import { formatDuration } from '../../format/duration';
import { benchmarkGap, parseBenchmarkScores } from '../../format/benchmark';
import { stripTerminalControl } from '../../format/logSafe';
import { isInteger } from '../../numbers';
import { printableChallengeId } from './pin';
import { openBoostWindows } from '../../voting/boostWindow';
import { findActiveChallenge } from '../../services/findActiveChallenge';
import { clearTokenUnlessStayingLoggedIn } from '../../services/auth';

// Reuse the GUI's single-challenge manual-vote handler (votes to 100%,
// bypassing thresholds). Built lazily on first use so loading this module for
// status/scheduling commands doesn't construct the handler set; invoked with
// a null event.
import type { NullEventHandlers } from '../../types/cli';
import type { Challenge, RankingTotal } from '../../types/gurushots';
import type * as voting_handlersModule from '../../ipc/voting.handlers';
import { errorMessage } from '../../errorMessage';
type VotingHandlers = NullEventHandlers<ReturnType<typeof voting_handlersModule.buildHandlers>>;
let _votingHandlers: VotingHandlers | undefined;
const votingHandlers = (): VotingHandlers =>
    (_votingHandlers ??= (
        require('../../ipc/voting.handlers') as typeof import('../../ipc/voting.handlers')
    ).buildHandlers());

/**
 * Run a single voting cycle. Pass {isManual: true} to use the manual
 * vote path (votes to 100% regardless of threshold settings). Pass
 * {challengeId} to scope a strategy cycle to a single challenge —
 * ignored when isManual is true.
 *
 * @returns `challenges` is the
 *   full active list the strategy cycle fetched (null for the manual path or any
 *   failure), letting the scheduler reuse it for threshold scheduling.
 */
const runVotingCycle = async (
    cycleNumber: number = 1,
    { isManual = false, challengeId = null }: { isManual?: boolean; challengeId?: string | null } = {},
): Promise<{ success: boolean; challenges: Challenge[] | null }> => {
    const scopeSuffix = !isManual && challengeId != null ? ` (challenge ${challengeId})` : '';
    const label = isManual ? 'Manual Voting' : 'Voting';
    const opId = isManual ? `manual-vote-cycle-${cycleNumber}` : `vote-cycle-${cycleNumber}`;
    try {
        const userSettings = settings.loadSettings();
        const isMockMode = userSettings.app.mock;

        logger
            .withCategory('voting')
            .info(`--- ${label} Cycle ${cycleNumber}${scopeSuffix} (${isMockMode ? 'MOCK' : 'REAL'} MODE) ---`);
        logger.withCategory('voting').info(`Time: ${formatDateTime()}`);
        if (isManual) {
            logger
                .withCategory('voting')
                .info('Mode: Manual (votes to 100% regardless of threshold settings; skips Manual Only challenges)');
        }

        if (!ensureAuthenticated()) {
            return { success: false, challenges: null };
        }

        logger.withCategory('voting').startOperation(opId, `${label} cycle ${cycleNumber}${scopeSuffix}`);
        // Capture the strategy cycle's challenge list so the scheduler can hand it
        // to the threshold step (avoids a duplicate getActiveChallenges fetch). The
        // manual path votes-to-100% and surfaces no list.
        let challenges: Challenge[] | null = null;
        let success = true;
        if (isManual) {
            await getMiddleware().cliVoteManual();
        } else {
            const result = await getMiddleware().cliVote(challengeId);
            // Reflect the strategy's real outcome rather than always reporting
            // success on the non-throw path.
            success = result?.success !== false;
            // Only hand the list back as prefetched when the cycle succeeded.
            // An outage resolves to `{ success: false, challenges: [] }`, and
            // that empty list is indistinguishable from "nothing to vote on"
            // once it reaches the scheduler — it would arm a full normal-cadence
            // wait instead of the short offline-retry cap. Gating on success
            // (mirroring the GUI's AutovoteContext wrapper) makes a failed cycle
            // return null, so the scheduler re-fetches and detects fetchFailed.
            challenges = success && Array.isArray(result?.challenges) ? result.challenges : null;
        }
        logger.withCategory('voting').endOperation(opId, `${label} cycle ${cycleNumber} completed`);

        return { success, challenges };
    } catch (error) {
        const noun = isManual ? 'manual voting' : 'voting';
        logger.withCategory('voting').error(`Error during ${noun} cycle ${cycleNumber}`, error);
        logger.withCategory('voting').debug(`Full ${noun} cycle error details:`, error);
        return { success: false, challenges: null };
    }
};

/**
 * Manually vote a single challenge to 100% (bypassing threshold settings) —
 * the CLI parity of the GUI card's manual-vote button. Reuses the
 * vote-on-challenge-manual handler; resolves the challenge title first
 * because that handler validates a non-empty title.
 */
const voteChallengeManual = async (
    challengeId: string,
): Promise<{ success: boolean; message?: string; error?: string }> => {
    if (!ensureAuthenticated()) {
        return { success: false, error: 'Not authenticated' };
    }

    let title;
    try {
        const resp = await getMiddleware().getActiveChallenges();
        const challenge = findActiveChallenge(resp?.challenges as Challenge[] | undefined, challengeId);
        if (!challenge) {
            logger.withCategory('challenges').error(`Challenge ${challengeId} not found among active challenges`);
            return { success: false, error: `Challenge ${challengeId} not found` };
        }
        title = challenge.title;
    } catch (err) {
        logger.withCategory('challenges').error(`Failed to fetch challenges: ${errorMessage(err) || err}`);
        return { success: false, error: 'Failed to fetch challenges' };
    }

    try {
        const result = await votingHandlers()['vote-on-challenge-manual'](null, challengeId, title);
        if (result?.success) {
            logger.withCategory('voting').success(result.message || `Voted on "${title}"`);
        } else {
            logger.withCategory('voting').error(result?.error || 'Failed to vote');
        }
        return result;
    } catch (err) {
        logger.withCategory('voting').error(`Failed to vote on "${title}": ${errorMessage(err) || err}`);
        return {
            success: false,
            error: errorMessage(err) || 'Failed to vote',
        };
    }
};

/**
 * Pull a `--challenge=<id>` or `--challenge <id>` flag value from
 * the remaining argv tail. Returns null when absent.
 */
const parseChallengeFlag = (argv: string[]): string | null => {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--challenge') {
            // `|| null` (not `??`) so a present-but-empty value (`--challenge ''`)
            // is treated as missing, matching the `--challenge=` form below.
            return argv[i + 1] || null;
        }
        if (a.startsWith('--challenge=')) {
            return a.slice('--challenge='.length) || null;
        }
    }
    return null;
};

/**
 * Start continuous voting with dynamic interval scheduling.
 * Delegates the scheduling engine to runScheduler; this CLI host
 * owns signal handling and process keep-alive.
 */
const startContinuousVoting = async () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.app.mock;

    logger
        .withCategory('voting')
        .info(`=== Starting Continuous Voting Mode (${isMockMode ? 'MOCK' : 'REAL'} MODE) ===`);

    if (!ensureAuthenticated()) {
        return;
    }

    const scheduler = createScheduler({
        runVotingCycle: (cycleNumber) => runVotingCycle(cycleNumber),
        getActiveChallenges: () => getMiddleware().getActiveChallenges(),
    });

    // Honour stayLoggedIn on the way out, the way the desktop app does. Settings writes are
    // synchronous on the CLI, so the clear lands before exit; the await is there for the
    // shared helper's flush, which no-ops here. A failure must not block the shutdown.
    const handleShutdown = () => {
        logger.withCategory('voting').info('🛑 Shutting down continuous voting...');
        scheduler.stop();
        void clearTokenUnlessStayingLoggedIn()
            .then((cleared) => {
                if (cleared) {
                    logger.withCategory('authentication').info('Cleared saved token (Stay Logged In is off)');
                }
            })
            .catch((error) => {
                logger.withCategory('authentication').error('Failed to clear token on shutdown', error);
            })
            .finally(() => {
                process.exit(0);
            });
    };

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    await scheduler.start();
    logger.withCategory('ui').info('Press Ctrl+C to stop');

    // Keep the process running.
    process.stdin.resume();
};

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
 * benchmark its rank sits under and the votes still missing toward it (`top <n> needs <gap> votes`).
 * Benchmark scores arrive as strings and count only when they parse to whole numbers. No gap at
 * rank 1, none once the benchmark is reached; with the votes unreadable, the benchmark's own score
 * is all that can be said.
 */
const rankingTail = (total: RankingTotal): string | null => {
    const rank = total.rank;
    if (!isInteger(rank) || rank <= 0) return null;
    const scores = parseBenchmarkScores(total.benchmark);
    const benchmark = rank <= 10 ? 1 : rank <= 100 ? 10 : 100;
    const score = scores[benchmark];
    if (!isInteger(score) || rank === 1) return `rank ${rank}`;
    const votes = total.votes;
    if (!isInteger(votes) || votes <= 0) {
        return `rank ${rank} — top ${benchmark} at ${score} votes`;
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

const showStatus = async () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.app.mock;
    const isAuthenticated = getMiddleware().isAuthenticated();

    logger.withCategory('ui').info('=== GuruShots Auto Voter - Status ===');

    logger.withCategory('ui').info(`Mode: ${isMockMode ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}`);
    logger
        .withCategory('authentication')
        .info(`Authentication: ${isAuthenticated ? '✅ Authenticated' : '❌ Not authenticated'}`);

    if (isAuthenticated) {
        logger.withCategory('authentication').info(`Token: ${userSettings.auth.token ? '✅ Present' : '❌ Missing'}`);
    }

    logger.withCategory('settings').info('\nSettings:');
    logger.withCategory('settings').info(`  Theme: ${userSettings.app.theme}`);
    logger.withCategory('settings').info(`  Language: ${userSettings.app.language}`);
    logger.withCategory('settings').info(`  Timezone: ${effectiveTimezone(userSettings.app.timezone)}`);
    logger.withCategory('settings').info(`  API Timeout: ${userSettings.app.apiTimeout}s`);
    {
        const min = userSettings.app.checkFrequencyMin;
        const max = userSettings.app.checkFrequencyMax;
        const label = min === max ? `${min}min` : `${min}–${max}min (random per cycle)`;
        logger.withCategory('settings').info(`  Check Frequency: ${label}`);
    }
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

    logPinnedEntries(userSettings);

    // Boost-window status (the CLI parity of the GUI banner, no anchors) and the member's
    // standing: both fed by ONE best-effort fetch of the active challenges — a failed/offline
    // call prints a note under each section and never crashes status. The boost list reuses
    // the engine's own predicate so there is no duplicated boost-window logic.
    if (isAuthenticated) {
        let challenges: Challenge[] | null = null;
        let fetchError: unknown = null;
        try {
            const resp = await getMiddleware().getActiveChallenges();
            challenges = Array.isArray(resp?.challenges) ? resp.challenges : [];
        } catch (err) {
            fetchError = err;
        }
        const noteUnavailable = () =>
            logger.withCategory('ui').info(`  (unavailable — ${errorMessage(fetchError) || fetchError})`);

        logger.withCategory('ui').info('\nBoost Window Open:');
        if (challenges === null) {
            noteUnavailable();
        } else {
            const now = Math.floor(Date.now() / 1000);
            const open = openBoostWindows(challenges, now);

            if (open.length === 0) {
                logger.withCategory('ui').info('  None');
            } else {
                open.forEach(({ title, remaining }) => {
                    const suffix = remaining == null ? 'no expiry' : formatDuration(remaining);
                    logger.withCategory('ui').info(`  • ${title} — ${suffix}`);
                });
            }
        }

        logger.withCategory('ui').info('\nStanding:');
        if (challenges === null) {
            noteUnavailable();
        } else {
            const lines = challenges.flatMap((challenge) => {
                const total = challenge?.member?.ranking?.total;
                const tail = total ? rankingTail(total) : null;
                return [
                    tail === null ? null : `  • ${stripTerminalControl(challenge.title)} — ${tail}`,
                    teamMatchLine(challenge),
                ].filter((line): line is string => line !== null);
            });
            if (lines.length === 0) {
                logger.withCategory('ui').info('  None');
            } else {
                lines.forEach((line) => logger.withCategory('ui').info(line));
            }
        }
    }

    logger.withCategory('ui').info('\nTo change mode, run: login');
};

export { runVotingCycle, voteChallengeManual, parseChallengeFlag, startContinuousVoting, showStatus };
