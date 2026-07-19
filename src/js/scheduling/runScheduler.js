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
 * The factory takes platform-agnostic dependencies; the host owns
 * signal/lifecycle (SIGINT on CLI, Service.onDestroy on Android) and
 * keeps the process alive.
 */

const logger = require('../logger');
const settings = require('../settings');
const { getRandomCheckFrequencyMs, MIN_CYCLE_GAP_MS } = require('./randomDelay');
const { computeNextCycleDelayMs } = require('./thresholdWindow');

// Node resolver for the shared threshold math: per-challenge lastMinuteThreshold
// straight from the settings facade (synchronous on Electron/CLI/Android-node).
const resolveThreshold = (challengeId) => settings.getEffectiveSetting('lastMinuteThreshold', challengeId);

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

    // Decide how long to wait before the next cycle and arm the single timer.
    //
    // `prefetched` lets a just-completed cycle hand over the active list it
    // already fetched, so we skip a redundant getActiveChallenges request. A
    // non-array (null/undefined, or a cycle that failed before fetching) falls
    // back to a fresh fetch. In normal mode the wait is anchored to the *start*
    // of the previous cycle so the gap between cycle starts ≈ the rolled delay
    // regardless of how long the cycle took; in approaching/last-minute mode the
    // wait runs from cycle completion so the boundary is never undershot.
    const scheduleNext = async (prefetched = null, previousCycleStartMs = null) => {
        if (!isRunning) {
            timer = null;
            return;
        }

        let waitMs;
        try {
            const fresh = settings.loadSettings();
            const normalDelayMs = getRandomCheckFrequencyMs(fresh);
            const challenges = Array.isArray(prefetched) ? prefetched : (await getActiveChallenges())?.challenges || [];
            const now = Math.floor(Date.now() / 1000);
            const lastMinuteCheckMinutes =
                Number(settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global')) || 1;

            const decision = await computeNextCycleDelayMs(challenges, now, {
                resolveThreshold,
                normalDelayMs,
                lastMinuteCheckMinutes,
                minGapMs: MIN_CYCLE_GAP_MS,
            });

            if (decision.mode === 'normal') {
                // Anchor to the previous cycle start: floor handles an overrun
                // (cycle took longer than the delay); the delayMs ceiling handles
                // a wall-clock jump backward that would otherwise inflate the wait.
                const anchorMs = previousCycleStartMs ?? Date.now();
                const remainingMs = anchorMs + decision.delayMs - Date.now();
                waitMs = Math.min(decision.delayMs, Math.max(MIN_CYCLE_GAP_MS, remainingMs));
                logger
                    .withCategory('voting')
                    .info(
                        `Next cycle in ${(waitMs / 60_000).toFixed(2)} min (target ${(decision.delayMs / 60_000).toFixed(2)} min between starts, range ${fresh.checkFrequencyMin}-${fresh.checkFrequencyMax})`,
                    );
            } else {
                waitMs = decision.delayMs;
                if (decision.mode === 'last-minute') {
                    logger
                        .withCategory('voting')
                        .info(`⏰ Last-minute cadence — next cycle in ${(waitMs / 60_000).toFixed(2)} min`);
                } else {
                    logger
                        .withCategory('voting')
                        .info(
                            `⏰ Approaching last-minute window for "${decision.nextEntry?.challengeTitle}" — next cycle in ${Math.round(waitMs / 1000)}s (capped to the ${decision.nextEntry?.lastMinuteThreshold}m boundary)`,
                        );
                }
            }
        } catch (error) {
            // An error deciding the delay must never kill the loop — fall back to
            // a plain random cadence; the next cycle re-reads on success.
            logger.withCategory('voting').warning('Error computing next cycle delay; using normal cadence');
            logger.withCategory('voting').debug('scheduleNext error details:', error);
            waitMs = getRandomCheckFrequencyMs(settings.loadSettings());
        }

        if (!isRunning) {
            timer = null;
            return;
        }

        timer = setTimeout(() => {
            void (async () => {
                if (!isRunning) {
                    timer = null;
                    return;
                }
                const cycleStartMs = Date.now();
                let cycleResult;
                try {
                    cycleResult = await runVotingCycle(++cycleCount);
                } catch (error) {
                    logger.withCategory('voting').error('Error in scheduled voting cycle');
                    logger.withCategory('voting').debug('Full voting cycle error details:', error);
                } finally {
                    await scheduleNext(cycleResult?.challenges, cycleStartMs);
                }
            })();
        }, waitMs);
    };

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

        await scheduleNext(initialCycle?.challenges, initialCycleStartMs);
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
