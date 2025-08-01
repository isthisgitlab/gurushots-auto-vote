import { loadChallenges } from './challengeLoader.js';

// Global function to boost a specific entry
export const initializeBoostEntry = () => {
    window.boostEntry = async (challengeId, imageId, rank) => {
        try {
            await window.api.logDebug(`🚀 Boosting entry: Challenge ${challengeId}, Image ${imageId}, Rank ${rank}`);

            // Show loading state on the button
            const button = document.querySelector(`[data-challenge-id="${challengeId}"][data-image-id="${imageId}"]`);
            if (button) {
                const originalText = button.innerHTML;
                button.disabled = true;
                button.innerHTML = '<span class="loading loading-spinner loading-xs"></span>';

                // Call the API to apply boost
                const result = await window.api.applyBoostToEntry(challengeId, imageId);

                if (result && result.success) {
                    await window.api.logDebug('✅ Boost applied successfully');
                    // Update the button to show success
                    button.innerHTML = '✅';
                    button.className = 'btn btn-xs btn-success ml-1';

                    // Refresh challenges to show updated state
                    setTimeout(async () => {
                        const timezone = await window.api.getSetting('timezone');
                        loadChallenges(timezone, false);
                    }, 1000);
                } else {
                    await window.api.logError(`❌ Failed to apply boost: ${result?.error || 'Unknown error'}`);
                    // Reset button on error
                    button.disabled = false;
                    button.innerHTML = originalText;

                    // Show error message
                    alert(`Failed to apply boost: ${result?.error || 'Unknown error'}`);
                }
            }
        } catch (error) {
            await window.api.logError(`❌ Error boosting entry: ${error.message || error}`);
            alert(`Error boosting entry: ${error.message || 'Unknown error'}`);

            // Reset button on error
            const button = document.querySelector(`[data-challenge-id="${challengeId}"][data-image-id="${imageId}"]`);
            if (button) {
                button.disabled = false;
                button.innerHTML = '🚀';
            }
        }
    };
}; 