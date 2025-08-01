import {updateSettingsDisplay, updateTranslations} from './ui/translations.js';
// Removed unused imports: formatTimeRemaining, formatEndTime, getBoostStatus, getTurboStatus, renderChallenges
import {loadChallenges} from './ui/challengeLoader.js';
import {
    generateChallengeSettingsModalHtml,
    generateSettingsModalHtml,
    initializeChallengeSettingsModal,
    initializeSettingsModal,
} from './ui/settingsModal.js';
import {initializeAutovote} from './ui/autovote.js';
import {initializeBoostEntry} from './ui/boostEntry.js';
import {initializeUpdateDialog} from './ui/updateDialog.js';

// Removed unused variable: translationManager
window.openSettingsModal = async () => {
    try {
        // Get the settings schema and current values
        const schema = await window.api.getSettingsSchema();

        if (!schema || Object.keys(schema).length === 0) {
            await window.api.logError('No schema available');
            alert('Settings schema not available. Please try again.');
            return;
        }

        const globalDefaults = {};

        // Load current global defaults
        for (const key of Object.keys(schema)) {
            try {
                globalDefaults[key] = await window.api.getGlobalDefault(key);
            } catch (error) {
                await window.api.logWarning(`Error loading global default for ${key}: ${error.message || error}`);
                globalDefaults[key] = schema[key].default;
            }
        }

        // Create modal HTML (challenges not needed for main settings modal)
        const modalHtml = await generateSettingsModalHtml(schema, globalDefaults, []);

        // Add modal to page
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Initialize modal event handlers
        initializeSettingsModal(schema, []);

    } catch (error) {
        await window.api.logError(`Error opening settings modal: ${error.message || error}`);
        alert('Failed to open settings modal. Check console for details.');
    }
};

window.openChallengeSettingsModal = async (challengeId, challengeTitle) => {
    try {
        // Get the settings schema and current values
        const schema = await window.api.getSettingsSchema();

        if (!schema || Object.keys(schema).length === 0) {
            await window.api.logError('No schema available');
            alert('Settings schema not available. Please try again.');
            return;
        }

        const globalDefaults = {};
        const challengeSettings = {};

        // Load current global defaults and challenge-specific settings
        for (const key of Object.keys(schema)) {
            try {
                globalDefaults[key] = await window.api.getGlobalDefault(key);
                challengeSettings[key] = await window.api.getChallengeOverride(key, challengeId);
            } catch (error) {
                await window.api.logWarning(`Error loading settings for ${key}: ${error.message || error}`);
                globalDefaults[key] = schema[key].default;
                challengeSettings[key] = null;
            }
        }

        // Create modal HTML
        const modalHtml = await generateChallengeSettingsModalHtml(challengeId, challengeTitle, schema, globalDefaults, challengeSettings);

        // Add modal to page
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Initialize modal event handlers
        initializeChallengeSettingsModal(schema, challengeId);

    } catch (error) {
        await window.api.logError(`Error opening challenge settings modal: ${error.message || error}`);
        alert('Failed to open challenge settings modal. Check console for details.');
    }
};

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    await window.api.logDebug('🚀 Initializing application...');

    // Initialize challenge timers array
    window.challengeTimers = [];

    // Expose loadChallenges function to window object
    window.loadChallenges = loadChallenges;

    // Initialize update dialog
    initializeUpdateDialog();

    // Initialize boost entry functionality
    initializeBoostEntry();

    // Initialize autovote functionality
    initializeAutovote();

    // Get DOM elements
    const settingsBtn = document.getElementById('settingsBtn');
    const refreshBtn = document.getElementById('refresh-challenges');
    const logoutBtn = document.getElementById('logoutBtn');

    // Load initial settings and update UI
    try {
        const settings = await window.api.getSettings();
        updateSettingsDisplay(settings);
        updateTranslations();


        // Load challenges
        await loadChallenges(settings.timezone || 'Europe/Riga', false);

    } catch (error) {
        await window.api.logError(`Error loading initial settings: ${error.message || error}`);
    }

    // Event listeners
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            window.openSettingsModal();
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            const timezone = await window.api.getSetting('timezone');
            await loadChallenges(timezone, false);
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            window.api.logout();
        });
    }

    window.openChallengeUrl = async (url) => {
        try {
            await window.api.openExternalUrl(`https://gurushots.com/challenge/${url}`);
        } catch (error) {
            await window.api.logError(`Error opening challenge URL: ${error.message || error}`);
        }
    };

    await window.api.logDebug('✅ Application initialized successfully');
});

window.closeSettingsModal = () => {
    const modal = document.querySelector('.modal');
    if (modal) {
        modal.remove();
    }
};

window.closeChallengeSettingsModal = () => {
    const modal = document.querySelector('.modal');
    if (modal) {
        modal.remove();
    }
};

window.saveGlobalSettings = async (event) => {
    // Prevent default form submission behavior immediately
    if (event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }
    
    try {
        // Stop autovote if it's running before saving settings
        if (window.stopAutovote) {
            await window.stopAutovote();
        }

        // Collect all UI settings without saving yet
        const themeToggle = document.getElementById('modal-theme-toggle');
        const languageSelect = document.getElementById('modal-language-select');
        const timezoneSelect = document.getElementById('modal-timezone-select');
        const stayLoggedIn = document.getElementById('modal-stay-logged-in');
        const apiTimeout = document.getElementById('modal-api-timeout');
        const checkFrequency = document.getElementById('modal-check-frequency');

        const uiSettingsToSave = {};
        
        if (themeToggle) {
            uiSettingsToSave.theme = themeToggle.checked ? 'dark' : 'light';
        }
        if (languageSelect) {
            uiSettingsToSave.language = languageSelect.value;
        }
        if (timezoneSelect) {
            uiSettingsToSave.timezone = timezoneSelect.value;
        }
        if (stayLoggedIn) {
            uiSettingsToSave.stayLoggedIn = stayLoggedIn.checked;
        }
        if (apiTimeout) {
            uiSettingsToSave.apiTimeout = parseInt(apiTimeout.value);
        }
        if (checkFrequency) {
            uiSettingsToSave.checkFrequency = parseInt(checkFrequency.value);
        }

        // Collect all schema settings and validate without saving yet
        const schema = await window.api.getSettingsSchema();
        const validationErrors = [];
        const schemaSettingsToSave = {};

        for (const [key, config] of Object.entries(schema)) {
            const inputId = `global-${key}`;
            const input = document.getElementById(inputId);

            if (input) {
                let value;
                if (config.type === 'time') {
                    const hoursInput = document.getElementById(`${inputId}-hours`);
                    const minutesInput = document.getElementById(`${inputId}-minutes`);
                    if (hoursInput && minutesInput) {
                        value = (parseInt(hoursInput.value) * 3600) + (parseInt(minutesInput.value) * 60);
                    }
                } else if (config.type === 'boolean') {
                    value = input.checked;
                } else {
                    const parsedValue = parseInt(input.value);
                    value = isNaN(parsedValue) ? input.value : parsedValue;
                }

                // Test validation without saving
                const validationError = await window.api.getValidationError(key, value, {...schemaSettingsToSave, [key]: value});
                
                if (!validationError) {
                    // Valid - store for saving later
                    schemaSettingsToSave[key] = value;
                    
                    // Clear error styling
                    if (config.type === 'time') {
                        const hoursInput = document.getElementById(`${inputId}-hours`);
                        const minutesInput = document.getElementById(`${inputId}-minutes`);
                        if (hoursInput && minutesInput) {
                            hoursInput.classList.remove('input-error');
                            minutesInput.classList.remove('input-error');
                        }
                    } else {
                        input.classList.remove('input-error');
                    }
                } else {
                    // Invalid - add to error list and add error styling
                    const settingLabel = window.translationManager ? window.translationManager.t(config.label || key) : (config.label || key);
                    // Handle special validation error formats
                    let errorMessage = validationError;
                    if (validationError && validationError.startsWith('VALIDATION_LESS_OR_EQUAL|')) {
                        const parts = validationError.split('|');
                        const exposureLabel = window.translationManager ? window.translationManager.t(parts[1]) : parts[1];
                        const currentValue = parts[2];
                        errorMessage = window.translationManager 
                            ? window.translationManager.t('app.validationMustBeLessOrEqual').replace('{0}', exposureLabel).replace('{1}', currentValue)
                            : `Must be ≤ ${exposureLabel} (currently ${currentValue})`;
                    } else if (!errorMessage) {
                        errorMessage = window.translationManager ? window.translationManager.t('app.validationInvalidValue') : 'Invalid value';
                    }
                    validationErrors.push(`${settingLabel}: ${errorMessage}`);
                    
                    if (config.type === 'time') {
                        const hoursInput = document.getElementById(`${inputId}-hours`);
                        const minutesInput = document.getElementById(`${inputId}-minutes`);
                        if (hoursInput && minutesInput) {
                            hoursInput.classList.add('input-error');
                            minutesInput.classList.add('input-error');
                        }
                    } else {
                        input.classList.add('input-error');
                    }
                }
            }
        }

        // If there were validation errors, show them to the user
        if (validationErrors.length > 0) {
            // Prevent any navigation
            if (event) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
            }
            
            const errorMessage = `The following settings have invalid values:\n\n${validationErrors.join('\n')}\n\nPlease correct these values and try again.`;
            alert(errorMessage);
            return false; // Don't close modal or refresh
        }

        // All validation passed - now save everything
        // First save UI settings
        for (const [key, value] of Object.entries(uiSettingsToSave)) {
            await window.api.setSetting(key, value);
        }

        // Then save schema settings
        for (const [key, value] of Object.entries(schemaSettingsToSave)) {
            await window.api.setGlobalDefault(key, value);
        }

        // Close modal
        window.closeSettingsModal();

        // Refresh UI and challenges
        const settings = await window.api.getSettings();
        updateSettingsDisplay(settings);
        updateTranslations();

        // Refresh menu to update language
        await window.api.refreshMenu();

        const timezone = await window.api.getSetting('timezone');
        await loadChallenges(timezone, false);

    } catch (error) {
        await window.api.logError(`Error saving settings: ${error.message || error}`);
        alert('Failed to save settings. Check console for details.');
        // Prevent navigation on error
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        return false;
    }
};

window.resetAllSettings = async () => {
    try {
        const schema = await window.api.getSettingsSchema();

        // Reset all global settings to defaults (don't auto-save)
        for (const [key, config] of Object.entries(schema)) {
            const inputId = `global-${key}`;
            const input = document.getElementById(inputId);

            if (input) {
                if (config.type === 'time') {
                    const hours = Math.floor(config.default / 3600);
                    const minutes = Math.floor((config.default % 3600) / 60);
                    const hoursInput = document.getElementById(`${inputId}-hours`);
                    const minutesInput = document.getElementById(`${inputId}-minutes`);
                    if (hoursInput) {
                        hoursInput.value = hours;
                        hoursInput.classList.add('input-error');
                    }
                    if (minutesInput) {
                        minutesInput.value = minutes;
                        minutesInput.classList.add('input-error');
                    }
                } else if (config.type === 'boolean') {
                    input.checked = config.default;
                    input.classList.add('input-error');
                } else {
                    input.value = config.default;
                    input.classList.add('input-error');
                }
            }
        }

        // Reset all UI settings to defaults (don't auto-save)
        const defaultValues = {
            theme: 'light',
            language: 'en',
            timezone: 'Europe/Riga',
            stayLoggedIn: false,
            apiTimeout: 30,
            checkFrequency: 3,
        };

        for (const [key, defaultValue] of Object.entries(defaultValues)) {
            const inputId = `modal-${key}`;
            const input = document.getElementById(inputId);

            if (input) {
                if (key === 'theme') {
                    input.checked = defaultValue === 'dark';
                } else if (key === 'stayLoggedIn') {
                    input.checked = defaultValue;
                } else {
                    input.value = defaultValue;
                }
                input.classList.add('input-error');
            }
        }

    } catch (error) {
        await window.api.logError(`Error resetting settings: ${error.message || error}`);
        alert('Failed to reset settings. Check console for details.');
    }
};

window.resetGlobalDefault = async (key) => {
    try {
        const schema = await window.api.getSettingsSchema();
        const config = schema[key];
        if (config) {
            // Update the input to show the default value (don't auto-save)
            const inputId = `global-${key}`;
            const input = document.getElementById(inputId);

            if (input) {
                if (config.type === 'time') {
                    const hours = Math.floor(config.default / 3600);
                    const minutes = Math.floor((config.default % 3600) / 60);
                    const hoursInput = document.getElementById(`${inputId}-hours`);
                    const minutesInput = document.getElementById(`${inputId}-minutes`);
                    if (hoursInput) {
                        hoursInput.value = hours;
                        hoursInput.classList.add('input-error');
                    }
                    if (minutesInput) {
                        minutesInput.value = minutes;
                        minutesInput.classList.add('input-error');
                    }
                } else if (config.type === 'boolean') {
                    input.checked = config.default;
                    input.classList.add('input-error');
                } else {
                    input.value = config.default;
                    input.classList.add('input-error');
                }
            }
        }
    } catch (error) {
        await window.api.logError(`Error resetting global default: ${error.message || error}`);
    }
};

window.resetUISetting = async (key) => {
    try {
        const defaultValues = {
            theme: 'light',
            language: 'en',
            timezone: 'Europe/Riga',
            stayLoggedIn: false,
            apiTimeout: 30,
            checkFrequency: 3,
        };

        const defaultValue = defaultValues[key];
        if (defaultValue !== undefined) {
            // Update the input (don't auto-save)
            const inputId = `modal-${key}`;
            const input = document.getElementById(inputId);

            if (input) {
                if (key === 'theme') {
                    input.checked = defaultValue === 'dark';
                } else if (key === 'stayLoggedIn') {
                    input.checked = defaultValue;
                } else {
                    input.value = defaultValue;
                }
                input.classList.add('input-error');
            }
        }
    } catch (error) {
        await window.api.logError(`Error resetting UI setting: ${error.message || error}`);
    }
};

window.saveChallengeSettings = async (challengeId, event) => {
    // Prevent default form submission behavior
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    try {
        // Stop autovote if it's running before saving challenge settings
        if (window.stopAutovote) {
            await window.stopAutovote();
        }

        const schema = await window.api.getSettingsSchema();
        const validationErrors = [];

        for (const [key, config] of Object.entries(schema)) {
            const inputId = `${key}-${challengeId}`;
            const input = document.getElementById(inputId);

            if (input) {
                let value;
                if (config.type === 'time') {
                    const hoursInput = document.getElementById(`${inputId}-hours`);
                    const minutesInput = document.getElementById(`${inputId}-minutes`);
                    if (hoursInput && minutesInput) {
                        value = (parseInt(hoursInput.value) * 3600) + (parseInt(minutesInput.value) * 60);
                    }
                } else if (config.type === 'boolean') {
                    value = input.checked;
                } else {
                    const parsedValue = parseInt(input.value);
                    value = isNaN(parsedValue) ? input.value : parsedValue;
                }

                const result = await window.api.setChallengeOverride(key, challengeId, value);
                
                if (result) {
                    // Success - clear warning classes
                    if (config.type === 'time') {
                        const hoursInput = document.getElementById(`${inputId}-hours`);
                        const minutesInput = document.getElementById(`${inputId}-minutes`);
                        if (hoursInput && minutesInput) {
                            hoursInput.classList.remove('input-error');
                            minutesInput.classList.remove('input-error');
                        }
                    } else {
                        input.classList.remove('input-error');
                    }
                } else {
                    // Validation failed - keep error styling and add to error list
                    const settingLabel = window.translationManager ? window.translationManager.t(config.label || key) : (config.label || key);
                    const invalidMessage = window.translationManager ? window.translationManager.t('app.validationInvalidValue') : 'Invalid value';
                    validationErrors.push(`${settingLabel}: ${invalidMessage}`);
                    
                    if (config.type === 'time') {
                        const hoursInput = document.getElementById(`${inputId}-hours`);
                        const minutesInput = document.getElementById(`${inputId}-minutes`);
                        if (hoursInput && minutesInput) {
                            hoursInput.classList.add('input-error');
                            minutesInput.classList.add('input-error');
                        }
                    } else {
                        input.classList.add('input-error');
                    }
                }
            }
        }

        // If there were validation errors, show them to the user
        if (validationErrors.length > 0) {
            const errorMessage = `The following challenge settings have invalid values:\n\n${validationErrors.join('\n')}\n\nPlease correct these values and try again.`;
            alert(errorMessage);
            return; // Don't close modal or refresh
        }

        // Close modal
        window.closeChallengeSettingsModal();

        // Refresh challenges to show updated settings
        const timezone = await window.api.getSetting('timezone');
        await loadChallenges(timezone, false);

    } catch (error) {
        await window.api.logError(`Error saving challenge settings: ${error.message || error}`);
        alert('Failed to save challenge settings. Check console for details.');
    }
};

window.resetChallengeSettings = async (challengeId) => {
    try {
        const schema = await window.api.getSettingsSchema();

        // Reset all inputs to global defaults (don't auto-save)
        for (const [key, config] of Object.entries(schema)) {
            const globalDefault = await window.api.getGlobalDefault(key);
            const inputId = `${key}-${challengeId}`;
            const input = document.getElementById(inputId);

            if (input) {
                if (config.type === 'time') {
                    const hours = Math.floor(globalDefault / 3600);
                    const minutes = Math.floor((globalDefault % 3600) / 60);
                    const hoursInput = document.getElementById(`${inputId}-hours`);
                    const minutesInput = document.getElementById(`${inputId}-minutes`);
                    if (hoursInput) {
                        hoursInput.value = hours;
                        hoursInput.classList.add('input-error');
                    }
                    if (minutesInput) {
                        minutesInput.value = minutes;
                        minutesInput.classList.add('input-error');
                    }
                } else if (config.type === 'boolean') {
                    input.checked = globalDefault;
                    input.classList.add('input-error');
                } else {
                    input.value = globalDefault;
                    input.classList.add('input-error');
                }
            }
        }

    } catch (error) {
        await window.api.logError(`Error resetting challenge settings: ${error.message || error}`);
        alert('Failed to reset challenge settings. Check console for details.');
    }
};

window.resetChallengeOverride = async (key, challengeId) => {
    try {
        // Update the input to show the global default (don't auto-save)
        const schema = await window.api.getSettingsSchema();
        const config = schema[key];
        if (config) {
            const globalDefault = await window.api.getGlobalDefault(key);
            const inputId = `${key}-${challengeId}`;
            const input = document.getElementById(inputId);

            if (input) {
                if (config.type === 'time') {
                    const hours = Math.floor(globalDefault / 3600);
                    const minutes = Math.floor((globalDefault % 3600) / 60);
                    const hoursInput = document.getElementById(`${inputId}-hours`);
                    const minutesInput = document.getElementById(`${inputId}-minutes`);
                    if (hoursInput) {
                        hoursInput.value = hours;
                        hoursInput.classList.add('input-error');
                    }
                    if (minutesInput) {
                        minutesInput.value = minutes;
                        minutesInput.classList.add('input-error');
                    }
                } else if (config.type === 'boolean') {
                    input.checked = globalDefault;
                    input.classList.add('input-error');
                } else {
                    input.value = globalDefault;
                    input.classList.add('input-error');
                }
            }
        }
    } catch (error) {
        await window.api.logError(`Error resetting challenge override: ${error.message || error}`);
    }
};