/**
 * CLI voting commands: per-cycle vote runs (manual + strategy) and the
 * continuous-mode entry point with signal handlers. The scheduling engine
 * itself lives in scheduling/runScheduler; this module is the CLI host
 * (signal handling, process keep-alive, progress logging). The status
 * banner lives in status.ts.
 */

import * as logger from '../../logger';
import { ensureAuthenticated } from '../guards';
import * as settings from '../../settings';
import { getMiddleware } from '../../apiFactory';
import { createScheduler } from '../../scheduling/runScheduler';
import { formatDateTime } from '../../dateFormat';
import { findActionableChallenge } from '../../services/findActiveChallenge';
import { clearTokenUnlessStayingLoggedIn } from '../../services/auth';

// Reuse the GUI's single-challenge manual-vote handler (votes to 100%,
// bypassing thresholds). Built lazily on first use so loading this module for
// status/scheduling commands doesn't construct the handler set; invoked with
// a null event.
import type { NullEventHandlers } from '../../types/cli';
import type { Challenge } from '../../types/gurushots';
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
        const found = findActionableChallenge(resp, challengeId);
        if ('refused' in found) {
            // The vote handler re-reads and refuses the same way (its own
            // mechanic refuses a marked challenge); this is the worded line.
            if (found.refused === 'data-incomplete') {
                logger.withCategory('challenges').error(`Challenge ${challengeId}: challenge data cannot be read`);
                return { success: false, error: 'challenge data cannot be read' };
            }
            logger.withCategory('challenges').error(`Challenge ${challengeId} not found among active challenges`);
            return { success: false, error: `Challenge ${challengeId} not found` };
        }
        title = found.challenge.title;
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

export { runVotingCycle, voteChallengeManual, parseChallengeFlag, startContinuousVoting };
