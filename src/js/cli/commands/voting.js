/**
 * CLI voting commands: per-cycle vote runs (manual + strategy),
 * continuous-mode entry point with signal handlers, and the status
 * banner. The scheduling engine itself lives in scheduling/runScheduler;
 * this module is the CLI host (signal handling, process keep-alive,
 * progress logging).
 */

const logger = require('../../logger');
const settings = require('../../settings');
const { getMiddleware } = require('../../apiFactory');
const { createScheduler } = require('../../scheduling/runScheduler');
const { formatDateTime } = require('../../dateFormat');
const { formatDuration } = require('../../format/duration');
const { isBoostWindowOpen } = require('../../services/VotingLogic');

// Reuse the GUI's single-challenge manual-vote handler (votes to 100%,
// bypassing thresholds). Built lazily on first use so loading this module for
// status/scheduling commands doesn't construct the handler set; invoked with
// a null event.
let _votingHandlers;
const votingHandlers = () => (_votingHandlers ??= require('../../ipc/voting.handlers').buildHandlers());

/**
 * Run a single voting cycle. Pass {isManual: true} to use the manual
 * vote path (votes to 100% regardless of threshold settings). Pass
 * {challengeId} to scope a strategy cycle to a single challenge —
 * ignored when isManual is true.
 *
 * @returns {Promise<{success:boolean, challenges:Array|null}>} `challenges` is the
 *   full active list the strategy cycle fetched (null for the manual path or any
 *   failure), letting the scheduler reuse it for threshold scheduling.
 */
const runVotingCycle = async (cycleNumber = 1, { isManual = false, challengeId = null } = {}) => {
    const scopeSuffix = !isManual && challengeId != null ? ` (challenge ${challengeId})` : '';
    const label = isManual ? 'Manual Voting' : 'Voting';
    const opId = isManual ? `manual-vote-cycle-${cycleNumber}` : `vote-cycle-${cycleNumber}`;
    try {
        const userSettings = settings.loadSettings();
        const isMockMode = userSettings.mock;

        logger
            .withCategory('voting')
            .info(`--- ${label} Cycle ${cycleNumber}${scopeSuffix} (${isMockMode ? 'MOCK' : 'REAL'} MODE) ---`);
        logger.withCategory('voting').info(`Time: ${formatDateTime()}`);
        if (isManual) {
            logger.withCategory('voting').info('Mode: Manual (votes to 100% regardless of threshold settings)');
        }

        if (!getMiddleware().isAuthenticated()) {
            logger.withCategory('authentication').error('No authentication token found. Please login first');
            logger.withCategory('ui').info('Run: login');
            return { success: false, challenges: null };
        }

        logger.withCategory('voting').startOperation(opId, `${label} cycle ${cycleNumber}${scopeSuffix}`);
        // Capture the strategy cycle's challenge list so the scheduler can hand it
        // to the threshold step (avoids a duplicate getActiveChallenges fetch). The
        // manual path votes-to-100% and surfaces no list.
        let challenges = null;
        let success = true;
        if (isManual) {
            await getMiddleware().cliVoteManual();
        } else {
            const result = await getMiddleware().cliVote(challengeId);
            challenges = Array.isArray(result?.challenges) ? result.challenges : null;
            // Reflect the strategy's real outcome rather than always reporting
            // success on the non-throw path.
            success = result?.success !== false;
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
 *
 * @returns {Promise<{success:boolean, message?:string, error?:string}>}
 */
const voteChallengeManual = async (challengeId) => {
    if (!getMiddleware().isAuthenticated()) {
        logger.withCategory('authentication').error('No authentication token found. Please login first');
        logger.withCategory('ui').info('Run: login');
        return { success: false, error: 'Not authenticated' };
    }

    let title;
    try {
        const resp = await getMiddleware().getActiveChallenges();
        const challenges = Array.isArray(resp?.challenges) ? resp.challenges : [];
        const challenge = challenges.find((c) => String(c.id) === String(challengeId));
        if (!challenge) {
            logger.withCategory('challenges').error(`Challenge ${challengeId} not found among active challenges`);
            return { success: false, error: `Challenge ${challengeId} not found` };
        }
        title = challenge.title;
    } catch (err) {
        logger.withCategory('challenges').error(`Failed to fetch challenges: ${err?.message || err}`);
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
        logger.withCategory('voting').error(`Failed to vote on "${title}": ${err?.message || err}`);
        return { success: false, error: err?.message || 'Failed to vote' };
    }
};

/**
 * Pull a `--challenge=<id>` or `--challenge <id>` flag value from
 * the remaining argv tail. Returns null when absent.
 */
const parseChallengeFlag = (argv) => {
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
    const isMockMode = userSettings.mock;

    logger
        .withCategory('voting')
        .info(`=== Starting Continuous Voting Mode (${isMockMode ? 'MOCK' : 'REAL'} MODE) ===`);

    if (!getMiddleware().isAuthenticated()) {
        logger.withCategory('authentication').error('No authentication token found. Please login first');
        logger.withCategory('ui').info('Run: login');
        return;
    }

    const scheduler = createScheduler({
        runVotingCycle: (cycleNumber) => runVotingCycle(cycleNumber),
        getActiveChallenges: () => getMiddleware().getActiveChallenges(),
    });

    const handleShutdown = () => {
        logger.withCategory('voting').info('🛑 Shutting down continuous voting...');
        scheduler.stop();
        process.exit(0);
    };

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    await scheduler.start();
    logger.withCategory('ui').info('Press Ctrl+C to stop');

    // Keep the process running.
    process.stdin.resume();
};

const showStatus = async () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.mock;
    const isAuthenticated = getMiddleware().isAuthenticated();

    logger.withCategory('ui').info('=== GuruShots Auto Voter - Status ===');

    logger.withCategory('ui').info(`Mode: ${isMockMode ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}`);
    logger
        .withCategory('authentication')
        .info(`Authentication: ${isAuthenticated ? '✅ Authenticated' : '❌ Not authenticated'}`);

    if (isAuthenticated) {
        logger.withCategory('authentication').info(`Token: ${userSettings.token ? '✅ Present' : '❌ Missing'}`);
    }

    logger.withCategory('settings').info('\nSettings:');
    logger.withCategory('settings').info(`  Theme: ${userSettings.theme}`);
    logger.withCategory('settings').info(`  Language: ${userSettings.language}`);
    logger.withCategory('settings').info(`  Timezone: ${userSettings.timezone}`);
    logger.withCategory('settings').info(`  API Timeout: ${userSettings.apiTimeout}s`);
    {
        const min = userSettings.checkFrequencyMin;
        const max = userSettings.checkFrequencyMax;
        const label = min === max ? `${min}min` : `${min}–${max}min (random per cycle)`;
        logger.withCategory('settings').info(`  Check Frequency: ${label}`);
    }
    logger
        .withCategory('settings')
        .info(
            `  Last Minute Check Frequency: ${settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global') || 1}min`,
        );

    if (userSettings.challengeSettings && Object.keys(userSettings.challengeSettings).length > 0) {
        logger.withCategory('settings').info('\nChallenge Settings:');
        Object.entries(userSettings.challengeSettings).forEach(([challengeId, challengeSettings]) => {
            logger.withCategory('settings').info(`  Challenge ${challengeId}:`);
            Object.entries(challengeSettings).forEach(([key, value]) => {
                logger.withCategory('settings').info(`    ${key}: ${value}`);
            });
        });
    }

    // Boost-window status: the CLI parity of the GUI banner (no anchors —
    // just the informational list). Best-effort fetch: a failed/offline call
    // prints a note and never crashes status. Reuses the engine's own
    // predicate so there is no duplicated boost-window logic.
    if (isAuthenticated) {
        logger.withCategory('ui').info('\nBoost Window Open:');
        try {
            const resp = await getMiddleware().getActiveChallenges();
            const challenges = Array.isArray(resp?.challenges) ? resp.challenges : [];
            const now = Math.floor(Date.now() / 1000);
            const open = challenges
                .filter((c) => isBoostWindowOpen(c, now))
                .map((c) => {
                    const boost = c.member?.boost;
                    // Only timed windows carry a countdown; key-unlocked
                    // (AVAILABLE_KEY) boosts never expire.
                    const remaining =
                        boost?.state === 'AVAILABLE' && typeof boost.timeout === 'number' && boost.timeout > 0
                            ? boost.timeout - now
                            : null;
                    return { title: c.title, remaining };
                })
                // Soonest-expiring first; key-unlocked (no timer) sort last.
                .sort((a, b) => {
                    if (a.remaining == null) return b.remaining == null ? 0 : 1;
                    if (b.remaining == null) return -1;
                    return a.remaining - b.remaining;
                });

            if (open.length === 0) {
                logger.withCategory('ui').info('  None');
            } else {
                open.forEach(({ title, remaining }) => {
                    const suffix = remaining == null ? 'no expiry' : formatDuration(remaining);
                    logger.withCategory('ui').info(`  • ${title} — ${suffix}`);
                });
            }
        } catch (err) {
            logger.withCategory('ui').info(`  (unavailable — ${err?.message || err})`);
        }
    }

    logger.withCategory('ui').info('\nTo change mode, run: login');
};

module.exports = { runVotingCycle, voteChallengeManual, parseChallengeFlag, startContinuousVoting, showStatus };
