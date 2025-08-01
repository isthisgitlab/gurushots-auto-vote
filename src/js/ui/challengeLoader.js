import { renderChallenges } from './challengeRenderer.js';

export const loadChallenges = async (timezone = 'local', autovoteRunning = false) => {
    // Clear any existing timers before loading new challenges
    if (window.challengeTimers) {
        window.challengeTimers.forEach(timer => clearInterval(timer));
        window.challengeTimers = [];
    }
    try {
        await window.api.logDebug('🔄 Loading active challenges');

        // Get token from settings
        const settings = await window.api.getSettings();
        await window.api.logDebug('Settings loaded successfully');

        if (!settings.token) {
            await window.api.logError('No authentication token found');
            renderChallenges([], timezone, autovoteRunning);
            return;
        }

        await window.api.logDebug('🌐 Fetching challenges from API');

        // Use the real API call that works in both mock and production
        const result = await window.api.getActiveChallenges(settings.token);

        await window.api.logDebug('📋 Challenges received from API');

        if (result && result.challenges) {
            await window.api.logDebug(`✅ Rendering ${result.challenges.length} challenges`);

            // Extract challenge IDs for cleanup
            const activeChallengeIds = result.challenges.map(challenge => challenge.id.toString());

            // Cleanup stale challenge settings
            try {
                await window.api.cleanupStaleChallengeSetting(activeChallengeIds);
            } catch (error) {
                await window.api.logWarning(`Failed to cleanup stale challenge settings: ${error.message || error}`);
            }

            // Cleanup stale metadata
            try {
                await window.api.cleanupStaleMetadata(activeChallengeIds);
            } catch (error) {
                await window.api.logWarning(`Failed to cleanup stale metadata: ${error.message || error}`);
            }

            renderChallenges(result.challenges, timezone, autovoteRunning);
        } else {
            await window.api.logError('❌ No challenges in result');
            renderChallenges([], timezone, autovoteRunning);
        }

    } catch (error) {
        await window.api.logError(`❌ Error loading challenges: ${error.message || error}`);
        renderChallenges([], timezone);
    }
};