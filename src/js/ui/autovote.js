import { loadChallenges } from './challengeLoader.js';

const translationManager = window.translationManager;

export const initializeAutovote = () => {
    const autovoteToggle = document.getElementById('autovote-toggle');
    const autovoteStatus = document.getElementById('autovote-status');
    const autovoteLastRun = document.getElementById('autovote-last-run');
    const autovoteCycles = document.getElementById('autovote-cycles');
    const refreshBtn = document.getElementById('refresh-challenges');

    let autovoteRunning = false;
    window.autovoteRunning = autovoteRunning;
    let cycleCount = 0;
    let autovoteInterval = null;
    let autoRefreshInterval = null;
    let singleVoteRunning = false;
    let thresholdScheduler = null; // For scheduling threshold interval changes
    let currentScheduledChallenge = null; // Track currently scheduled challenge to prevent duplicates
    let lastSettingsHash = null; // Track settings changes

    const updateAutovoteStatus = (status, badgeClass = 'badge-neutral') => {
        // Translate status if it's a known key
        let translatedStatus = status;
        if (status === 'Running') {
            translatedStatus = translationManager.t('common.running');
        } else if (status === 'Stopped') {
            translatedStatus = translationManager.t('common.stopped');
        } else if (status === 'Error') {
            translatedStatus = 'Error'; // Keep error as is
        } else if (status === 'Error: Not logged in') {
            translatedStatus = 'Error: Not logged in'; // Keep error as is
        }

        autovoteStatus.textContent = translatedStatus;
        autovoteStatus.className = `badge ${badgeClass}`;
    };

    const updateLastRun = () => {
        const now = new Date();
        autovoteLastRun.textContent = now.toLocaleTimeString('lv-LV');
    };

    const updateCycleCount = () => {
        cycleCount++;
        autovoteCycles.textContent = cycleCount.toString();
    };

    /**
     * Calculate when the next challenge will enter the last threshold period
     * @param {Array} challenges - Array of challenge objects
     * @param {number} now - Current time (Unix timestamp)
     * @returns {Object|null} - Object with challengeId and entryTime, or null if no upcoming entries
     */
    const calculateNextLastThresholdEntry = async (challenges, now) => {
        let nextEntry = null;
        let earliestEntryTime = Infinity;

        for (const challenge of challenges) {
            // Skip flash challenges and ended challenges
            if (challenge.type === 'flash' || challenge.close_time <= now) {
                continue;
            }

            const effectiveLastMinuteThreshold = await window.api.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
            const thresholdEntryTime = challenge.close_time - (effectiveLastMinuteThreshold * 60);

            // Only consider future entries
            if (thresholdEntryTime > now && thresholdEntryTime < earliestEntryTime) {
                earliestEntryTime = thresholdEntryTime;
                nextEntry = {
                    challengeId: challenge.id,
                    challengeTitle: challenge.title,
                    entryTime: thresholdEntryTime,
                    lastMinuteThreshold: effectiveLastMinuteThreshold,
                };
            }
        }

        return nextEntry;
    };

    /**
     * Schedule an interval change when a challenge enters the last threshold period
     * @param {Object} nextEntry - Object with challengeId, entryTime, and lastMinuteThreshold
     */
    const scheduleThresholdIntervalChange = async (nextEntry) => {
        if (!nextEntry || !autovoteRunning) {
            return;
        }

        // Check if we're already scheduling the same challenge
        if (currentScheduledChallenge && 
            currentScheduledChallenge.challengeId === nextEntry.challengeId &&
            currentScheduledChallenge.entryTime === nextEntry.entryTime) {
            await window.api.logDebug(`⏰ Already scheduling threshold change for challenge "${nextEntry.challengeTitle}", skipping duplicate`);
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const timeUntilEntry = (nextEntry.entryTime - now) * 1000; // Convert to milliseconds

        // Only schedule if the entry time is in the future
        if (timeUntilEntry <= 0) {
            await window.api.logDebug(`⏰ Threshold entry time for challenge "${nextEntry.challengeTitle}" has already passed, skipping`);
            return;
        }

        await window.api.logDebug(`⏰ Scheduling threshold interval change for challenge "${nextEntry.challengeTitle}" in ${Math.round(timeUntilEntry / 1000)} seconds`);

        // Clear any existing scheduler
        if (thresholdScheduler) {
            clearTimeout(thresholdScheduler);
            thresholdScheduler = null;
        }

        // Track the currently scheduled challenge
        currentScheduledChallenge = {
            challengeId: nextEntry.challengeId,
            challengeTitle: nextEntry.challengeTitle,
            entryTime: nextEntry.entryTime,
            lastMinuteThreshold: nextEntry.lastMinuteThreshold,
        };

        // Save metadata for persistence
        await saveThresholdMetadata(nextEntry);

        // Schedule the interval change
        thresholdScheduler = setTimeout(async () => {
            if (autovoteRunning) {
                await window.api.logDebug(`⏰ Threshold entry time reached for challenge "${nextEntry.challengeTitle}", switching to last threshold frequency`);
                
                // Clear current interval and set up new one with last threshold frequency
                if (autovoteInterval) {
                    clearInterval(autovoteInterval);
                }

                const lastMinuteCheckFrequency = await window.api.getEffectiveSetting('lastMinuteCheckFrequency', 'global');
                const votingIntervalMs = lastMinuteCheckFrequency * 60000;

                autovoteInterval = setInterval(async () => {
                    if (autovoteRunning) {
                        await runVotingCycle();
                    } else {
                        clearInterval(autovoteInterval);
                        autovoteInterval = null;
                    }
                }, votingIntervalMs);

                await window.api.logDebug(`⏰ Switched to last threshold interval: ${lastMinuteCheckFrequency} minutes`);
                
                // Clear the scheduled challenge tracking
                currentScheduledChallenge = null;
                
                // Update threshold scheduling for the next potential entry
                await updateThresholdScheduling();
            }
        }, timeUntilEntry);
    };

    /**
     * Update threshold scheduling based on current challenges
     */
    const updateThresholdScheduling = async () => {
        if (!autovoteRunning) {
            return;
        }

        try {
            const settings = await window.api.getSettings();
            const result = await window.api.getActiveChallenges(settings.token);
            const challenges = result?.challenges || [];
            const now = Math.floor(Date.now() / 1000);

            // Check if settings have changed (relevant settings for threshold scheduling)
            const currentSettingsHash = JSON.stringify({
                lastMinuteCheckFrequency: await window.api.getEffectiveSetting('lastMinuteCheckFrequency', 'global'),
                lastMinuteThreshold: await window.api.getEffectiveSetting('lastMinuteThreshold', 'global'),
            });

            if (lastSettingsHash !== null && lastSettingsHash !== currentSettingsHash) {
                await window.api.logDebug('⏰ Settings changed, clearing existing threshold scheduler');
                if (thresholdScheduler) {
                    clearTimeout(thresholdScheduler);
                    thresholdScheduler = null;
                }
                currentScheduledChallenge = null;
            }
            lastSettingsHash = currentSettingsHash;

            const nextEntry = await calculateNextLastThresholdEntry(challenges, now);
            
            if (nextEntry) {
                await scheduleThresholdIntervalChange(nextEntry);
            } else {
                // Clear any existing scheduler if no upcoming entries
                if (thresholdScheduler) {
                    clearTimeout(thresholdScheduler);
                    thresholdScheduler = null;
                    currentScheduledChallenge = null;
                    await window.api.logDebug('⏰ No upcoming threshold entries, cleared threshold scheduler');
                }
            }
        } catch (error) {
            await window.api.logWarning(`Error updating threshold scheduling: ${error.message || error}`);
        }
    };

    /**
     * Handle settings changes that affect threshold scheduling
     */
    const handleSettingsChange = async () => {
        if (!autovoteRunning) {
            return;
        }

        await window.api.logDebug('⚙️ Settings changed, updating threshold scheduling');
        
        // Clear existing scheduler to force recalculation
        if (thresholdScheduler) {
            clearTimeout(thresholdScheduler);
            thresholdScheduler = null;
        }
        currentScheduledChallenge = null;
        lastSettingsHash = null; // Reset to force recalculation
        
        // Update threshold scheduling with new settings
        await updateThresholdScheduling();
    };

    /**
     * Save threshold scheduling metadata for persistence
     */
    const saveThresholdMetadata = async (nextEntry) => {
        if (!nextEntry) {
            return;
        }

        try {
            await window.api.logDebug(`💾 Saving threshold scheduling metadata for challenge "${nextEntry.challengeTitle}"`);
        } catch (error) {
            await window.api.logWarning(`Error saving threshold metadata: ${error.message || error}`);
        }
    };

    const runVotingCycle = async () => {
        await window.api.logDebug(`🔄 runVotingCycle called, autovoteRunning: ${autovoteRunning}`);

        // Check if autovote is still running before proceeding
        if (!autovoteRunning) {
            await window.api.logDebug('🛑 Autovote stopped, skipping voting cycle');
            return false;
        }

        try {
            await window.api.logDebug(`--- Auto Vote Cycle ${cycleCount + 1} ---`);
            await window.api.logDebug(`Time: ${new Date().toLocaleString()}`);

            // Check if user is authenticated
            const settings = await window.api.getSettings();
            if (!settings.token) {
                await window.api.logError('No authentication token found. Please login first.');
                updateAutovoteStatus('Error: Not logged in', 'badge-error');
                return false;
            }

            // Run the voting process using the API factory
            const result = await window.api.runVotingCycle();

            // Check if autovote was stopped during the cycle
            if (!autovoteRunning) {
                await window.api.logDebug('🛑 Autovote stopped during voting cycle, aborting');
                return false;
            }

            if (result && result.success) {
                // Double-check that autovote is still running before updating
                if (autovoteRunning) {
                    updateCycleCount();
                    updateLastRun();

                    // Refresh challenges immediately after voting cycle completes
                    const timezone = await window.api.getSetting('timezone');
                    await loadChallenges(timezone, autovoteRunning);

                    // Update threshold scheduling after challenge refresh
                    await updateThresholdScheduling();

                    await window.api.logDebug(`--- Auto Vote Cycle ${cycleCount} Completed ---\n`);
                    return true;
                } else {
                    await window.api.logDebug('🛑 Autovote was stopped, not updating cycle count or refreshing');
                    return false;
                }
            } else {
                await window.api.logError(`Voting cycle failed: ${result?.error || 'Unknown error'}`);
                if (autovoteRunning) {
                    updateAutovoteStatus('Error', 'badge-error');
                }
                return false;
            }
        } catch (error) {
            await window.api.logError(`Error during auto vote cycle ${cycleCount + 1}: ${error.message || error}`);
            updateAutovoteStatus('Error', 'badge-error');
            return false;
        }
    };

    const startAutovote = async () => {
        if (autovoteRunning) return;

        autovoteRunning = true;
        window.autovoteRunning = autovoteRunning;
        await window.api.setCancelVoting(false);
        updateAutovoteStatus('Running', 'badge-success');

        // Update button
        autovoteToggle.innerHTML = `
            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
            ${translationManager.t('app.stopAutoVote')}
        `;
        autovoteToggle.className = 'btn btn-error';

        // Stop the regular auto-refresh since we'll update after each voting cycle
        stopAutoRefresh();

        // Hide the refresh button when autovote is running
        refreshBtn.style.display = 'none';

        // Refresh challenges to hide individual vote buttons
        const timezone = await window.api.getSetting('timezone');
        loadChallenges(timezone, autovoteRunning);

        // Run immediately
        await window.api.logDebug('▶️ Starting immediate voting cycle');
        runVotingCycle();

        // Set up simple interval without dynamic logic to avoid service worker issues
        const setupVotingInterval = async () => {
            const settings = await window.api.getSettings();
            
            // Check if last threshold check frequency is disabled (set to 0)
            const lastMinuteCheckFrequency = await window.api.getEffectiveSetting('lastMinuteCheckFrequency', 'global');
            const useLastThreshold = lastMinuteCheckFrequency > 0;
            
            let votingIntervalMs;
            let useLastThresholdInterval = false;
            
            if (useLastThreshold) {
                // Check if any challenges are within the last minutes threshold
                const settings = await window.api.getSettings();
                const result = await window.api.getActiveChallenges(settings.token);
                const challenges = result?.challenges || [];
                const now = Math.floor(Date.now() / 1000);
                
                for (const challenge of challenges) {
                    if (challenge.type !== 'flash') {
                        const effectiveLastMinuteThreshold = await window.api.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
                        const timeUntilEnd = challenge.close_time - now;
                        const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

                        if (isWithinLastMinuteThreshold) {
                            useLastThresholdInterval = true;
                            break;
                        }
                    }
                }
            }
            
            if (useLastThresholdInterval) {
                votingIntervalMs = lastMinuteCheckFrequency * 60000;
                await window.api.logDebug(`⏰ Using last threshold interval: ${lastMinuteCheckFrequency} minutes (challenge within threshold)`);
            } else {
                votingIntervalMs = settings.checkFrequency * 60000;
                await window.api.logDebug(`⏰ Using normal check frequency: ${settings.checkFrequency} minutes`);
            }
            
            // Clear existing interval if any
            if (autovoteInterval) {
                clearInterval(autovoteInterval);
            }
            
            await window.api.logDebug('⏰ Setting up autovote interval');
            autovoteInterval = setInterval(async () => {
                await window.api.logDebug(`⏰ Interval triggered, autovoteRunning: ${autovoteRunning}`);
                if (autovoteRunning) {
                    await runVotingCycle();
                } else {
                    await window.api.logDebug('⏰ Autovote stopped, clearing interval');
                    clearInterval(autovoteInterval);
                    autovoteInterval = null;
                }
            }, votingIntervalMs);

            await window.api.logDebug('=== Auto Vote Started ===');
            await window.api.logDebug(`Scheduling voting every ${useLastThresholdInterval ? lastMinuteCheckFrequency : settings.checkFrequency} minutes`);
            await window.api.logDebug('Challenges will update after each voting cycle');

            // Set up proactive threshold scheduling
            await updateThresholdScheduling();
        };

        await setupVotingInterval();
    };

    const stopAutovote = async () => {
        await window.api.logDebug(`🛑 stopAutovote called, autovoteRunning: ${autovoteRunning}, Interval: ${autovoteInterval}`);
        if (!autovoteRunning) {
            await window.api.logDebug('🛑 Autovote already stopped, returning');
            return;
        }

        await window.api.logDebug('🛑 Setting autovoteRunning to false and canceling voting');
        autovoteRunning = false;
        window.autovoteRunning = autovoteRunning;
        await window.api.setCancelVoting(true);

        // Clear autovote interval
        await window.api.logDebug(`🛑 Clearing autovote interval: ${autovoteInterval}`);
        if (autovoteInterval) {
            clearInterval(autovoteInterval);
            autovoteInterval = null;
            await window.api.logDebug('🛑 Autovote interval cleared');
        }

        // Clear threshold scheduler
        if (thresholdScheduler) {
            clearTimeout(thresholdScheduler);
            thresholdScheduler = null;
            await window.api.logDebug('🛑 Threshold scheduler cleared');
        }

        // Clear scheduled challenge tracking
        if (currentScheduledChallenge) {
            currentScheduledChallenge = null;
            await window.api.logDebug('🛑 Scheduled challenge tracking cleared');
        }

        // Only update UI elements if they exist (for when called from main UI)
        if (autovoteStatus) {
            updateAutovoteStatus('Stopped', 'badge-neutral');
        }

        if (autovoteToggle) {
            autovoteToggle.innerHTML = `
                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h1m4 0h1m-6 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                ${translationManager.t('app.startAutoVote')}
            `;
            autovoteToggle.className = 'btn btn-latvian';
        }

        if (refreshBtn && !singleVoteRunning) {
            refreshBtn.style.display = 'inline-flex';
        }

        // Refresh challenges to show vote buttons again
        const timezone = await window.api.getSetting('timezone');
        await loadChallenges(timezone, autovoteRunning);

        // Restart the regular auto-refresh
        startAutoRefresh();

        await window.api.logDebug('=== Auto Vote Stopped ===');
        await window.api.logDebug(`🛑 Final autovoteRunning state: ${autovoteRunning}`);
    };

    autovoteToggle.addEventListener('click', async (e) => {
        e.preventDefault(); // Prevent any default behavior
        await window.api.logDebug(`🔄 Autovote toggle clicked, current state: ${autovoteRunning}, Interval: ${autovoteInterval}`);
        if (autovoteRunning) {
            await window.api.logDebug('🛑 Stopping autovote...');
            await stopAutovote();
        } else {
            await window.api.logDebug('▶️ Starting autovote...');
            await startAutovote();
        }
    });

    window.addEventListener('beforeunload', () => {
        if (autovoteInterval) {
            clearInterval(autovoteInterval);
        }
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
        }
        if (thresholdScheduler) {
            clearTimeout(thresholdScheduler);
        }
    });

    // Start auto-refresh for challenges (every 60 seconds when autovote is not running)
    const startAutoRefresh = () => {
        if (!autovoteRunning) {
            autoRefreshInterval = setInterval(async () => {
                try {
                    const timezone = await window.api.getSetting('timezone');
                    loadChallenges(timezone, autovoteRunning);
                } catch (error) {
                    await window.api.logWarning(`Could not get timezone for auto-refresh: ${error.message || error}`);
                    loadChallenges('Europe/Riga', autovoteRunning); // Default fallback
                }
            }, 60000); // 60 seconds
        }
    };

    const stopAutoRefresh = () => {
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }
    };

    startAutoRefresh();

    // Expose singleVoteRunning to window for other modules
    window.singleVoteRunning = singleVoteRunning;
    
    // Expose stopAutovote function globally so it can be called from other modules
    window.stopAutovote = stopAutovote;
    
    // Expose settings change handler for threshold scheduling
    window.handleThresholdSettingsChange = handleSettingsChange;
};