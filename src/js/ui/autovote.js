import { loadChallenges } from './challengeLoader.js';

const translationManager = window.translationManager;

export const initializeAutovote = () => {
    // Get DOM elements
    const autovoteToggle = document.getElementById('autovote-toggle');
    const autovoteStatus = document.getElementById('autovote-status');
    const autovoteLastRun = document.getElementById('autovote-last-run');
    const autovoteCycles = document.getElementById('autovote-cycles');
    const refreshBtn = document.getElementById('refresh-challenges');

    // State variables
    let autovoteRunning = false;
    let cycleCount = 0;
    let autovoteInterval = null;
    let autoRefreshInterval = null;
    let singleVoteRunning = false;

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

    // Function to update last run time
    const updateLastRun = () => {
        const now = new Date();
        autovoteLastRun.textContent = now.toLocaleTimeString('lv-LV');
    };

    // Function to update cycle count
    const updateCycleCount = () => {
        cycleCount++;
        autovoteCycles.textContent = cycleCount.toString();
    };

    // Function to run a single voting cycle
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

                    await window.api.logDebug(`--- Auto Vote Cycle ${cycleCount} Completed ---\n`);
                    return true;
                } else {
                    await window.api.logDebug('🛑 Autovote was stopped, not updating cycle count or refreshing');
                    return false;
                }
            } else {
                await window.api.logError('Voting cycle failed', result?.error || 'Unknown error');
                if (autovoteRunning) {
                    updateAutovoteStatus('Error', 'badge-error');
                }
                return false;
            }
        } catch (error) {
            await window.api.logError(`Error during auto vote cycle ${cycleCount + 1}:`, error);
            updateAutovoteStatus('Error', 'badge-error');
            return false;
        }
    };

    // Function to start autovote
    const startAutovote = async () => {
        if (autovoteRunning) return;

        autovoteRunning = true;
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
                votingIntervalMs = lastThresholdFrequency * 60000;
                await window.api.logDebug(`⏰ Using last threshold interval: ${lastThresholdFrequency} minutes (challenge within threshold)`);
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
                await window.api.logDebug('⏰ Interval triggered, autovoteRunning:', autovoteRunning);
                if (autovoteRunning) {
                    await runVotingCycle();
                } else {
                    await window.api.logDebug('⏰ Autovote stopped, clearing interval');
                    clearInterval(autovoteInterval);
                    autovoteInterval = null;
                }
            }, votingIntervalMs);

            await window.api.logDebug('=== Auto Vote Started ===');
            await window.api.logDebug(`Scheduling voting every ${useLastThresholdInterval ? lastThresholdFrequency : settings.checkFrequency} minutes`);
            await window.api.logDebug('Challenges will update after each voting cycle');
        };

        await setupVotingInterval();
    };

    // Function to stop autovote
    const stopAutovote = async () => {
        await window.api.logDebug('🛑 stopAutovote called, autovoteRunning:', autovoteRunning, 'Interval:', autovoteInterval);
        if (!autovoteRunning) {
            await window.api.logDebug('🛑 Autovote already stopped, returning');
            return;
        }

        await window.api.logDebug('🛑 Setting autovoteRunning to false and canceling voting');
        autovoteRunning = false;
        await window.api.setCancelVoting(true);

        // Clear autovote interval
        await window.api.logDebug('🛑 Clearing autovote interval:', autovoteInterval);
        if (autovoteInterval) {
            clearInterval(autovoteInterval);
            autovoteInterval = null;
            await window.api.logDebug('🛑 Autovote interval cleared');
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

        // Restart the regular auto-refresh
        startAutoRefresh();

        await window.api.logDebug('=== Auto Vote Stopped ===');
        await window.api.logDebug('🛑 Final autovoteRunning state:', autovoteRunning);
    };

    // Handle autovote toggle
    autovoteToggle.addEventListener('click', async (e) => {
        e.preventDefault(); // Prevent any default behavior
        await window.api.logDebug('🔄 Autovote toggle clicked, current state:', autovoteRunning, 'Interval:', autovoteInterval);
        if (autovoteRunning) {
            await window.api.logDebug('🛑 Stopping autovote...');
            await stopAutovote();
        } else {
            await window.api.logDebug('▶️ Starting autovote...');
            await startAutovote();
        }
    });

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        if (autovoteInterval) {
            clearInterval(autovoteInterval);
        }
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
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
                    await window.api.logWarning('Could not get timezone for auto-refresh:', error);
                    loadChallenges('Europe/Riga', autovoteRunning); // Default fallback
                }
            }, 60000); // 60 seconds
        }
    };

    // Stop auto-refresh
    const stopAutoRefresh = () => {
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }
    };

    // Start auto-refresh initially
    startAutoRefresh();

    // Expose singleVoteRunning to window for other modules
    window.singleVoteRunning = singleVoteRunning;
    
    // Expose stopAutovote function globally so it can be called from other modules
    window.stopAutovote = stopAutovote;
};