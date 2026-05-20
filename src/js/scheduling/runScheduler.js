/**
 * Host-agnostic continuous voting scheduler. Implements the same two-tier
 * model as before (normal mode = recursive setTimeout with random delay
 * each tick; threshold mode = node-cron with last-minute cadence) but
 * lives outside the CLI entry point so foreground-service hosts (Android)
 * can drive the same engine.
 *
 * The factory takes platform-agnostic dependencies; the host owns
 * signal/lifecycle (SIGINT on CLI, Service.onDestroy on Android) and
 * keeps the process alive.
 */

const cron = require('node-cron');
const logger = require('../logger');
const settings = require('../settings');
const { getRandomCheckFrequencyMs, MIN_CYCLE_GAP_MS } = require('./randomDelay');
const { calculateNextThresholdEntry, isAnyChallengeInThresholdWindow } = require('./thresholdWindow');

// Node resolver for the shared threshold math: per-challenge lastMinuteThreshold
// straight from the settings facade (synchronous on Electron/CLI/Android-node).
const resolveThreshold = (challengeId) => settings.getEffectiveSetting('lastMinuteThreshold', challengeId);

// Node's timer delay is a 32-bit signed int of milliseconds; a larger delay
// silently wraps and fires after ~1ms. A challenge whose threshold entry is
// further out than this can't be armed with a single setTimeout — defer it and
// let a later cycle re-arm it once it's within range.
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Create a continuous voting scheduler.
 *
 * @param {Object} deps
 * @param {(cycleNumber:number)=>Promise<boolean>} deps.runVotingCycle - one-shot voting cycle.
 * @param {()=>Promise<{challenges:Array}>} deps.getActiveChallenges - fetcher for threshold scheduling.
 * @returns {{start:()=>Promise<void>, stop:()=>void, getCycleCount:()=>number, isRunning:()=>boolean}}
 */
const createScheduler = ({ runVotingCycle, getActiveChallenges }) => {
    let cycleCount = 0;
    let isRunning = false;
    let thresholdScheduler = null;
    let currentScheduledChallenge = null;
    let lastSettingsHash = null;
    let currentCronJob = null;
    let normalScheduler = null;

    // (Re)start the last-minute cron at the current lastMinuteCheckFrequency,
    // stopping any cron already running. Shared by the initial switch and the
    // mid-cron settings-change restart so the cadence value is read in one place.
    const startThresholdCron = () => {
        const lastMinuteCheckFrequency = settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global');
        const thresholdCronExpression = `*/${lastMinuteCheckFrequency} * * * *`;

        if (currentCronJob) {
            currentCronJob.stop();
        }

        currentCronJob = cron.schedule(
            thresholdCronExpression,
            async () => {
                if (!isRunning) {
                    currentCronJob.stop();
                    return;
                }

                try {
                    await runVotingCycle(++cycleCount);
                    await updateThresholdScheduling();
                } catch (error) {
                    logger.withCategory('voting').error('Error in scheduled voting cycle');
                    logger.withCategory('voting').debug('Full threshold cron error details:', error);
                }
            },
            { scheduled: false },
        );

        currentCronJob.start();
        logger
            .withCategory('voting')
            .info(
                `⏰ Switched to last threshold cron: ${thresholdCronExpression} (every ${lastMinuteCheckFrequency} minute(s))`,
            );
    };

    const scheduleThresholdCronChange = async (nextEntry) => {
        if (!nextEntry || !isRunning) return;

        if (
            currentScheduledChallenge &&
            currentScheduledChallenge.challengeId === nextEntry.challengeId &&
            currentScheduledChallenge.entryTime === nextEntry.entryTime
        ) {
            logger
                .withCategory('voting')
                .debug(
                    `⏰ Already scheduling threshold change for challenge "${nextEntry.challengeTitle}", skipping duplicate`,
                );
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const timeUntilEntry = (nextEntry.entryTime - now) * 1000;

        if (timeUntilEntry <= 0) {
            logger
                .withCategory('voting')
                .debug(
                    `⏰ Threshold entry time for challenge "${nextEntry.challengeTitle}" has already passed, skipping`,
                );
            return;
        }

        if (timeUntilEntry > MAX_TIMEOUT_DELAY_MS) {
            logger
                .withCategory('voting')
                .debug(
                    `⏰ Threshold entry for challenge "${nextEntry.challengeTitle}" is ${Math.round(timeUntilEntry / 1000)}s away — beyond the max timer delay; deferring to a later cycle`,
                );
            return;
        }

        logger
            .withCategory('voting')
            .info(
                `⏰ Scheduling threshold cron change for challenge "${nextEntry.challengeTitle}" in ${Math.round(timeUntilEntry / 1000)} seconds`,
            );

        if (thresholdScheduler) {
            clearTimeout(thresholdScheduler);
            thresholdScheduler = null;
        }

        currentScheduledChallenge = {
            challengeId: nextEntry.challengeId,
            challengeTitle: nextEntry.challengeTitle,
            entryTime: nextEntry.entryTime,
            lastMinuteThreshold: nextEntry.lastMinuteThreshold,
        };

        thresholdScheduler = setTimeout(async () => {
            if (!isRunning) return;

            logger
                .withCategory('voting')
                .info(
                    `⏰ Threshold entry time reached for challenge "${nextEntry.challengeTitle}", switching to last threshold frequency`,
                );

            // Stop normal-mode setTimeout chain (one-way transition into threshold cron)
            if (normalScheduler) {
                clearTimeout(normalScheduler);
                normalScheduler = null;
            }

            startThresholdCron();

            currentScheduledChallenge = null;
            await updateThresholdScheduling();
        }, timeUntilEntry);
    };

    const updateThresholdScheduling = async () => {
        if (!isRunning) return;

        try {
            const challengesResponse = await getActiveChallenges();
            const challenges = challengesResponse?.challenges || [];
            const now = Math.floor(Date.now() / 1000);

            const lastMinuteCheckFrequency = settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global');
            const lastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', 'global');

            const currentSettingsHash = JSON.stringify({ lastMinuteCheckFrequency, lastMinuteThreshold });

            if (lastSettingsHash !== null && lastSettingsHash !== currentSettingsHash) {
                logger.withCategory('settings').info('⏰ Settings changed, clearing existing threshold scheduler');
                if (thresholdScheduler) {
                    clearTimeout(thresholdScheduler);
                    thresholdScheduler = null;
                }
                currentScheduledChallenge = null;

                // If we're already in cron mode and a challenge is still within its
                // window, restart the cron so a new lastMinuteCheckFrequency takes
                // effect immediately rather than waiting for the next switch. (When
                // nothing is in-window, the revert below returns us to normal mode.)
                if (currentCronJob && (await isAnyChallengeInThresholdWindow(challenges, now, resolveThreshold))) {
                    logger
                        .withCategory('voting')
                        .info('⏰ Settings changed mid-cron — restarting last-minute cron at the new frequency');
                    startThresholdCron();
                }
            }
            lastSettingsHash = currentSettingsHash;

            // If we're in last-minute cron mode but nothing is currently within
            // its last-minute window, tear down the cron and resume the normal
            // randomized cadence. Without this the cron is a one-way door: a
            // single challenge entering its final minutes would pin the whole
            // session at lastMinuteCheckFrequency forever, even after it closes.
            if (currentCronJob && !(await isAnyChallengeInThresholdWindow(challenges, now, resolveThreshold))) {
                logger
                    .withCategory('voting')
                    .info('⏰ No challenges within last-minute window — reverting to normal check frequency');
                currentCronJob.stop();
                currentCronJob = null;
                // normalScheduler is already null in cron mode (cleared on entry),
                // but clear defensively so we can never leave two live timer chains.
                if (normalScheduler) {
                    clearTimeout(normalScheduler);
                    normalScheduler = null;
                }
                scheduleNextNormalCycle(Date.now());
            }

            const nextEntry = await calculateNextThresholdEntry(challenges, now, resolveThreshold);

            if (nextEntry) {
                await scheduleThresholdCronChange(nextEntry);
            } else if (thresholdScheduler) {
                clearTimeout(thresholdScheduler);
                thresholdScheduler = null;
                currentScheduledChallenge = null;
                logger.withCategory('voting').info('⏰ No upcoming threshold entries, cleared threshold scheduler');
            }
        } catch (error) {
            logger.withCategory('voting').warning('Error updating threshold scheduling:');
            logger.withCategory('voting').debug('updateThresholdScheduling error details:', error);
        }
    };

    // Normal mode uses a recursive setTimeout chain so each cycle re-rolls a random delay
    // in [checkFrequencyMin, checkFrequencyMax]. Re-loading settings each tick lets a live
    // `set-setting checkFrequencyMax 25` apply to the next cycle without restart.
    //
    // The wait is anchored to the *start* of the previous cycle, not its end — so the gap
    // between cycle starts ≈ delayMs regardless of how long the cycle took. When a cycle
    // overruns the rolled delay we still pause MIN_CYCLE_GAP_MS before firing again.
    const scheduleNextNormalCycle = (previousCycleStartMs) => {
        if (!isRunning) {
            normalScheduler = null;
            return;
        }
        const fresh = settings.loadSettings();
        const delayMs = getRandomCheckFrequencyMs(fresh);
        const anchorMs = previousCycleStartMs ?? Date.now();
        const remainingMs = anchorMs + delayMs - Date.now();
        // Clamp into [MIN_CYCLE_GAP_MS, delayMs]: floor handles overrun (cycle
        // took longer than delayMs); ceiling handles wall-clock jump backward
        // (Date.now() shifted earlier than anchor), which would otherwise
        // produce a wait longer than the user configured.
        const waitMs = Math.min(delayMs, Math.max(MIN_CYCLE_GAP_MS, remainingMs));
        const overran = remainingMs < MIN_CYCLE_GAP_MS;
        logger
            .withCategory('voting')
            .info(
                overran
                    ? `Next normal cycle in ${(waitMs / 60_000).toFixed(2)} min — previous cycle overran ${(delayMs / 60_000).toFixed(2)} min target, applying ${(MIN_CYCLE_GAP_MS / 1000).toFixed(0)}s floor (range ${fresh.checkFrequencyMin}-${fresh.checkFrequencyMax})`
                    : `Next normal cycle in ${(waitMs / 60_000).toFixed(2)} min (target ${(delayMs / 60_000).toFixed(2)} min between starts, range ${fresh.checkFrequencyMin}-${fresh.checkFrequencyMax})`,
            );

        normalScheduler = setTimeout(async () => {
            if (!isRunning) {
                normalScheduler = null;
                return;
            }
            const cycleStartMs = Date.now();
            try {
                await runVotingCycle(++cycleCount);
                await updateThresholdScheduling();
            } catch (error) {
                logger.withCategory('voting').error('Error in scheduled voting cycle');
                logger.withCategory('voting').debug('Full normal cycle error details:', error);
            } finally {
                scheduleNextNormalCycle(cycleStartMs);
            }
        }, waitMs);
    };

    const start = async () => {
        if (isRunning) return;
        isRunning = true;

        logger.withCategory('voting').info('🚀 Running initial voting cycle...');
        const initialCycleStartMs = Date.now();
        await runVotingCycle(++cycleCount);

        scheduleNextNormalCycle(initialCycleStartMs);
        logger
            .withCategory('voting')
            .success(
                `Continuous voting started with check frequency range ${settings.getSetting('checkFrequencyMin')}-${settings.getSetting('checkFrequencyMax')} min`,
            );

        await updateThresholdScheduling();
    };

    const stop = () => {
        isRunning = false;

        if (thresholdScheduler) {
            clearTimeout(thresholdScheduler);
            thresholdScheduler = null;
        }
        if (normalScheduler) {
            clearTimeout(normalScheduler);
            normalScheduler = null;
        }
        if (currentCronJob) {
            currentCronJob.stop();
            currentCronJob = null;
        }
        currentScheduledChallenge = null;
    };

    return {
        start,
        stop,
        getCycleCount: () => cycleCount,
        isRunning: () => isRunning,
    };
};

module.exports = { createScheduler };
