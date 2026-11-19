/**
 * CLI voting commands: per-cycle vote runs (manual + strategy) and the
 * continuous-mode entry point with signal handlers. The scheduling engine
 * itself lives in scheduling/runScheduler; this module is the CLI host
 * (signal handling, process keep-alive, progress logging). The status
 * banner lives in status.ts.
 */

import * as logger from '../../../core/logger';
import { ensureAuthenticated, resolveChallenge } from '../guards';
import * as settings from '../../../core/settings';
import { getMiddleware } from '../../../core/apiFactory';
import { createScheduler } from '../runScheduler';
import { EXECUTION_MODE_LABELS } from '../../../core/autovote/state';
import { formatDateTime } from '../../../core/dateFormat';
import { clearTokenUnlessStayingLoggedIn } from '../../../core/services/auth';

// Reuse the GUI's single-challenge manual-vote handler (votes to 100%,
// bypassing thresholds). Built lazily on first use so loading this module for
// status/scheduling commands doesn't construct the handler set; invoked with
// a null event.
import type { NullEventHandlers } from '../../../core/types/cli';
import type { Challenge } from '../../../core/types/gurushots';
import type { CycleMode } from '../../../core/types/votingPass';
import type * as voting_handlersModule from '../../../core/ipc/voting.handlers';
import { errorMessage } from '../../../core/errorMessage';
type VotingHandlers = NullEventHandlers<ReturnType<typeof voting_handlersModule.buildHandlers>>;
let _votingHandlers: VotingHandlers | undefined;
const votingHandlers = (): VotingHandlers =>
    (_votingHandlers ??= (
        require('../../../core/ipc/voting.handlers') as typeof import('../../../core/ipc/voting.handlers')
    ).buildHandlers());

/**
 * Run a single voting cycle. Pass {isManual: true} to use the manual
 * vote path (votes to 100% regardless of threshold settings). Pass
 * {challengeId} to scope a strategy cycle to a single challenge —
 * ignored when isManual is true. Pass {mode: 'armed'} for the installation cycle of an armed scheduler (no voting stage).
 *
 * @returns `challenges` is the
 *   full active list the strategy cycle fetched (null for the manual path or any
 *   failure), letting the scheduler reuse it for threshold scheduling.
 */
const runVotingCycle = async (
    cycleNumber: number = 1,
    {
        isManual = false,
        challengeId = null,
        mode = 'full',
    }: { isManual?: boolean; challengeId?: string | null; mode?: CycleMode } = {},
): Promise<{ success: boolean; challenges: Challenge[] | null }> => {
    const scopeSuffix = !isManual && challengeId != null ? ` (challenge ${challengeId})` : '';
    const label = isManual ? 'Manual Voting' : mode === 'armed' ? 'Installation' : 'Voting';
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
            const result = await getMiddleware().cliVote(challengeId, mode);
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
 * the CLI parity of the GUI card's manual-vote button. resolveChallenge is
 * the shared lookup, with the user-facing line for every refusal (not
 * authenticated, failed fetch, not found, data that cannot be read); the
 * vote handler re-reads and refuses the same way and validates a non-empty
 * title, so the resolved challenge itself is what this needs from it.
 */
const voteChallengeManual = async (
    challengeId: string,
): Promise<{ success: boolean; message?: string; error?: string } | null> => {
    const challenge = await resolveChallenge(challengeId);
    if (challenge === null) return { success: false };
    const { title } = challenge;

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
        // An armed scheduler runs the installation stage only.
        runArmedCycle: (cycleNumber) => runVotingCycle(cycleNumber, { mode: 'armed' }),
        getActiveChallenges: () => getMiddleware().getActiveChallenges(),
        // Armed (a scenario active, voting paused): the process stays alive for the scenario's own work, and says so.
        onModeChange: (mode) => {
            if (mode === 'armed') {
                logger
                    .withCategory('voting')
                    .info(
                        `Mode: ${EXECUTION_MODE_LABELS.armed}. Unattended scenario work (claiming rewards, resuming voting) is still enabled. Press Ctrl+C to stop all automation.`,
                    );
            }
        },
    });

    // The full Stop comes first, and is awaited: nothing may be left armed behind an exit, and a Stop that could not be saved is
    // said (a restart is then not protected). Ctrl+C is never a pause of the voting stages. Then honour stayLoggedIn on the
    // way out, the way the desktop app does. Settings writes are synchronous on the CLI, so the clear lands before exit; the
    // await is there for the shared helper's flush, which no-ops here. A failure must not block the shutdown.
    let shuttingDown = false;
    const handleShutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.withCategory('voting').info('🛑 Shutting down continuous voting...');
        try {
            const stopped = await scheduler.stopAll();
            if (stopped.outcome !== 'stopped') {
                logger
                    .withCategory('voting')
                    .warning('The Stop could not be saved: automation stopped in this process only.');
            }
        } catch (error) {
            logger.withCategory('voting').error('Failed to record the Stop on shutdown', error);
        }
        try {
            if (await clearTokenUnlessStayingLoggedIn()) {
                logger.withCategory('authentication').info('Cleared saved token (Stay Logged In is off)');
            }
        } catch (error) {
            logger.withCategory('authentication').error('Failed to clear token on shutdown', error);
        }
        process.exit(0);
    };

    // One handler for both signals (the same full Stop either way), registered as the same function so a
    // test can see the two routes share it.
    const onShutdownSignal = () => void handleShutdown();
    process.on('SIGINT', onShutdownSignal);
    process.on('SIGTERM', onShutdownSignal);

    await scheduler.start();
    logger.withCategory('ui').info('Press Ctrl+C to stop');

    // Keep the process running.
    process.stdin.resume();
};

type LifecycleHandlers = NullEventHandlers<
    ReturnType<typeof import('../../../core/ipc/scenarioLifecycle.handlers').buildLifecycleHandlers>
>;
let _lifecycleHandlers: LifecycleHandlers | undefined;
const lifecycleHandlers = (): LifecycleHandlers =>
    (_lifecycleHandlers ??= (
        require('../../../core/ipc/scenarioLifecycle.handlers') as typeof import('../../../core/ipc/scenarioLifecycle.handlers')
    ).buildLifecycleHandlers());

let stopCommandCount = 0;

/** Why the fence refused to record a Stop, in the words the banner prints. */
const stopRefusalText = (reason: string): string =>
    reason === 'not-saved'
        ? 'it could not be saved'
        : reason === 'unreadable'
          ? 'the saved Stop record cannot be read'
          : reason === 'oversize'
            ? 'the Stop record does not fit its cell'
            : reason;

/**
 * `stop`: the explicit full Stop from outside the running controller — the CLI parity of the app's Stop all automation.
 * It goes through the same priority route every full Stop uses: the fence record first (nothing else can refuse it, and a
 * withdrawal that could not land never comes before it), then the withdrawal of the installation's published settings under
 * the epoch the record answered (best effort: a withdrawal that fails is reported and never refuses the Stop). What it
 * cannot know it says: whether the running app or service has already acted on the Stop is not observable from here, with
 * an installation scenario assigned and without one — a plain voting run has a controller too. Never a pause of the
 * voting stages.
 */
const stopAllAutomation = async (): Promise<number> => {
    const requestId = `stop-${Date.now().toString(36)}-${(stopCommandCount++).toString(36)}`;
    let recordedEpoch: number;
    try {
        const recorded = await lifecycleHandlers()['record-full-stop'](null, requestId, Date.now());
        if (recorded.success !== true) {
            logger
                .withCategory('voting')
                .error(
                    `The Stop could not be recorded (${stopRefusalText(recorded.error)}): automation on this computer may still run. Close the running app, or try again.`,
                );
            return 1;
        }
        recordedEpoch = recorded.epoch;
        logger
            .withCategory('voting')
            .info(
                `🛑 Full Stop recorded (epoch ${recorded.epoch}). The running app or service stops at its next check.`,
            );
    } catch (error) {
        logger.withCategory('voting').error('The Stop could not be recorded', error);
        return 1;
    }
    try {
        const withdrawn = await lifecycleHandlers()['withdraw-installation'](null, recordedEpoch);
        if (withdrawn?.success === true && withdrawn.outcome === 'withdrawn') {
            logger
                .withCategory('voting')
                .info("The installation's published settings were withdrawn; your own settings apply again.");
        } else if (withdrawn?.success !== true) {
            logger
                .withCategory('voting')
                .warning(
                    "The installation's published settings could not be withdrawn: they may still apply until the next full Stop.",
                );
        }
    } catch (error) {
        logger.withCategory('voting').warning('The installation settings could not be withdrawn', error);
    }
    logger.withCategory('voting').info('Owner status unavailable — the running app or service reports its own state.');
    return 0;
};

export { runVotingCycle, voteChallengeManual, parseChallengeFlag, startContinuousVoting, stopAllAutomation };
