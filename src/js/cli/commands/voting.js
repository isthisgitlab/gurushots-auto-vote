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

/**
 * Run a single voting cycle. Pass {isManual: true} to use the manual
 * vote path (votes to 100% regardless of threshold settings). Pass
 * {challengeId} to scope a strategy cycle to a single challenge —
 * ignored when isManual is true.
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
            return false;
        }

        logger.withCategory('voting').startOperation(opId, `${label} cycle ${cycleNumber}${scopeSuffix}`);
        if (isManual) {
            await getMiddleware().cliVoteManual();
        } else {
            await getMiddleware().cliVote(challengeId);
        }
        logger.withCategory('voting').endOperation(opId, `${label} cycle ${cycleNumber} completed`);

        return true;
    } catch (error) {
        const noun = isManual ? 'manual voting' : 'voting';
        logger.withCategory('voting').error(`Error during ${noun} cycle ${cycleNumber}`, error);
        logger.withCategory('voting').debug(`Full ${noun} cycle error details:`, error);
        return false;
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
            return argv[i + 1] ?? null;
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

const showStatus = () => {
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

    logger.withCategory('ui').info('\nTo change mode, run: login');
};

module.exports = { runVotingCycle, parseChallengeFlag, startContinuousVoting, showStatus };
