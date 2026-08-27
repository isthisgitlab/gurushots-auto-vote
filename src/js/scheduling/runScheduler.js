/**
 * Host-agnostic continuous voting scheduler.
 *
 * A single recursive setTimeout chain: after every cycle the next delay is
 * decided in one place (`computeNextCycleDelayMs` in ./thresholdWindow) so the
 * cadence can never sleep past an upcoming last-minute boundary — the delay is
 * always the minimum of the rolled random delay and the time until the soonest
 * upcoming threshold entry, or a fixed fast cadence once a challenge is inside
 * its window. This replaces the old two-tier model (normal setTimeout chain +
 * a separate node-cron switch) whose independent boundary timer could race a
 * mid-run per-challenge threshold change and overshoot the boundary.
 *
 * The loop itself (decide → arm → cycle → re-arm) is the shared
 * `createCadenceChain` from ./cadenceChain — the same chain the GUI's
 * AutovoteContext drives — so this module only supplies the Node transport:
 * synchronous settings reads, the direct challenge fetcher, the logger, and
 * the host lifecycle (SIGINT on CLI, Service.onDestroy on Android).
 */

const logger = require('../logger');
const settings = require('../settings');
const { createCadenceChain, DECISION_ERROR_MESSAGE } = require('./cadenceChain');
const { resolveThreshold, resolveScheduledFill } = require('./nodeResolvers');

/**
 * Create a continuous voting scheduler.
 *
 * @param {Object} deps
 * @param {(cycleNumber:number)=>Promise<{success:boolean, challenges:Array|null}>} deps.runVotingCycle - one-shot voting cycle; resolves with the active list it fetched (null on failure/manual). A non-array `challenges` (or a legacy boolean return) is treated as "no list" and triggers a fresh fetch when deciding the next delay.
 * @param {()=>Promise<{challenges:Array}>} deps.getActiveChallenges - fetcher used only when a cycle didn't hand its list over.
 * @returns {{start:()=>Promise<void>, stop:()=>void, getCycleCount:()=>number, isRunning:()=>boolean}}
 */
const createScheduler = ({ runVotingCycle, getActiveChallenges }) => {
    let cycleCount = 0;
    let isRunning = false;
    let timer = null;

    const chain = createCadenceChain({
        isRunning: () => isRunning,
        getTimer: () => timer,
        setTimer: (handle) => {
            timer = handle;
        },
        loadSettings: () => settings.loadSettings(),
        fetchChallenges: () => getActiveChallenges(),
        resolveLastMinuteCheckMinutes: () => settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global'),
        resolveThreshold,
        resolveScheduledFill,
        // The chain hands the resolved value straight back to the next
        // decision as the prefetched-list candidate, so unwrap `challenges`
        // here; a cycle failure/legacy boolean yields a non-array → fresh fetch.
        runCycle: async () => (await runVotingCycle(++cycleCount))?.challenges,
        log: {
            cadence: (mode, message) => {
                logger.withCategory('voting').info(message);
            },
            decisionError: (error) => {
                logger.withCategory('voting').warning(DECISION_ERROR_MESSAGE);
                logger.withCategory('voting').debug('scheduleNext error details:', error);
            },
            overslept: (lateMs, waitMs) => {
                logger
                    .withCategory('voting')
                    .warning(
                        `⚠️ Cycle timer fired ${(lateMs / 60_000).toFixed(1)} min late (waited ${(waitMs / 60_000).toFixed(1)} min) — the host was suspended or throttled; any auto-fill, boost, turbo or emergency-fill window inside that gap was missed`,
                    );
            },
            cycleError: (error) => {
                logger.withCategory('voting').error('Error in scheduled voting cycle');
                logger.withCategory('voting').debug('Full voting cycle error details:', error);
            },
        },
    });

    const start = async () => {
        if (isRunning) return;
        isRunning = true;

        logger.withCategory('voting').info('🚀 Running initial voting cycle...');
        const initialCycleStartMs = Date.now();
        const initialCycle = await runVotingCycle(++cycleCount);

        logger
            .withCategory('voting')
            .success(
                `Continuous voting started with check frequency range ${settings.getSetting('checkFrequencyMin')}-${settings.getSetting('checkFrequencyMax')} min`,
            );

        await chain.scheduleNext(initialCycle?.challenges, initialCycleStartMs);
    };

    const stop = () => {
        isRunning = false;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    return {
        start,
        stop,
        getCycleCount: () => cycleCount,
        isRunning: () => isRunning,
    };
};

module.exports = { createScheduler };
