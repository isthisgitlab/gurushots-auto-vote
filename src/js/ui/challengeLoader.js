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

        await window.api.logDebug('🌐 Fetching challenges from API', {
            tokenExists: !!settings.token,
            mockMode: settings.mock,
        });

        // Use the real API call that works in both mock and production
        const result = await window.api.getActiveChallenges(settings.token);

        await window.api.logDebug('📋 Challenges received from API', {
            challengeCount: result?.challenges?.length || 0,
            hasResult: !!result,
            resultStructure: result ? Object.keys(result) : [],
        });

        if (result && result.challenges) {
            await window.api.logDebug(`✅ Rendering ${result.challenges.length} challenges`, {
                sampleChallenge: result.challenges[0] ? {
                    id: result.challenges[0].id,
                    title: result.challenges[0].title,
                    type: result.challenges[0].type,
                } : null,
            });

            // Extract challenge IDs for cleanup
            const activeChallengeIds = result.challenges.map(challenge => challenge.id.toString());


            try {
                await window.api.cleanupStaleChallengeSetting(activeChallengeIds);
            } catch (error) {
                console.warn('Failed to cleanup stale challenge settings:', error);
            }

            renderChallenges(result.challenges, timezone, autovoteRunning);
        } else {
            await window.api.logError('❌ No challenges in result', {result});
            renderChallenges([], timezone, autovoteRunning);
        }

    } catch (error) {
        await window.api.logError('❌ Error loading challenges', error);
        renderChallenges([], timezone);
    }
};