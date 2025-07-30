// Import all UI modules
import { updateTranslations, updateSettingsDisplay } from './ui/translations.js';
// Removed unused imports: formatTimeRemaining, formatEndTime, getBoostStatus, getTurboStatus, renderChallenges
import { loadChallenges } from './ui/challengeLoader.js';
import { generateSettingsModalHtml, initializeSettingsModal, generateChallengeSettingsModalHtml, initializeChallengeSettingsModal } from './ui/settingsModal.js';
import { initializeAutovote } from './ui/autovote.js';
import { initializeBoostEntry } from './ui/boostEntry.js';
import { initializeUpdateDialog } from './ui/updateDialog.js';

// Removed unused variable: translationManager

// Global function to open settings modal
window.openSettingsModal = async () => {
    try {
        // Get the settings schema and current values
        const schema = await window.api.getSettingsSchema();

        if (!schema || Object.keys(schema).length === 0) {
            console.error('No schema available');
            alert('Settings schema not available. Please try again.');
            return;
        }

        const globalDefaults = {};

        // Load current global defaults
        for (const key of Object.keys(schema)) {
            try {
                globalDefaults[key] = await window.api.getGlobalDefault(key);
            } catch (error) {
                console.warn(`Error loading global default for ${key}:`, error);
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
        console.error('Error opening settings modal:', error);
        alert('Failed to open settings modal. Check console for details.');
    }
};

// Global function to open challenge settings modal
window.openChallengeSettingsModal = async (challengeId, challengeTitle) => {
    try {
        // Get the settings schema and current values
        const schema = await window.api.getSettingsSchema();

        if (!schema || Object.keys(schema).length === 0) {
            console.error('No schema available');
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
                console.warn(`Error loading settings for ${key}:`, error);
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
        console.error('Error opening challenge settings modal:', error);
        alert('Failed to open challenge settings modal. Check console for details.');
    }
};

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Initializing application...');
    
    // Initialize challenge timers array
    window.challengeTimers = [];

    // Initialize update dialog
    initializeUpdateDialog();

    // Initialize boost entry functionality
    initializeBoostEntry();

    // Initialize autovote functionality
    initializeAutovote();

    // Get DOM elements
    const settingsBtn = document.getElementById('settingsBtn');
    const refreshBtn = document.getElementById('refresh-challenges');
    const timezoneSelect = document.getElementById('timezone-select');

    // Load initial settings and update UI
    try {
        const settings = await window.api.getSettings();
        updateSettingsDisplay(settings);
        updateTranslations();

        // Set timezone select value
        if (timezoneSelect) {
            timezoneSelect.value = settings.timezone || 'Europe/Riga';
        }

        // Load challenges
        await loadChallenges(settings.timezone || 'Europe/Riga', false);

    } catch (error) {
        console.error('Error loading initial settings:', error);
    }

    // Event listeners
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            window.openSettingsModal();
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            const timezone = timezoneSelect ? timezoneSelect.value : 'Europe/Riga';
            await loadChallenges(timezone, false);
        });
    }

    if (timezoneSelect) {
        timezoneSelect.addEventListener('change', async () => {
            const timezone = timezoneSelect.value;
            await window.api.setSetting('timezone', timezone);
            await loadChallenges(timezone, false);
        });
    }

    // Global function to open challenge URL
    window.openChallengeUrl = async (url) => {
        try {
            await window.api.openExternalUrl(`https://gurushots.com/challenge/${url}`);
        } catch (error) {
            console.error('Error opening challenge URL:', error);
        }
    };

    console.log('✅ Application initialized successfully');
});

// Global functions for settings modals
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

window.saveGlobalSettings = async () => {
    try {
        // Save all global settings
        const schema = await window.api.getSettingsSchema();
        
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
                    value = parseInt(input.value) || input.value;
                }
                
                await window.api.setGlobalDefault(key, value);
            }
        }
        
        // Close modal
        window.closeSettingsModal();
        
        // Refresh challenges to show updated settings
        const timezone = await window.api.getSetting('timezone');
        await loadChallenges(timezone, false);
        
    } catch (error) {
        console.error('Error saving global settings:', error);
        alert('Failed to save settings. Check console for details.');
    }
};

window.resetAllSettings = async () => {
    try {
        const schema = await window.api.getSettingsSchema();
        
        for (const [key, config] of Object.entries(schema)) {
            await window.api.setGlobalDefault(key, config.default);
        }
        
        // Close modal
        window.closeSettingsModal();
        
        // Refresh challenges
        const timezone = await window.api.getSetting('timezone');
        await loadChallenges(timezone, false);
        
    } catch (error) {
        console.error('Error resetting settings:', error);
        alert('Failed to reset settings. Check console for details.');
    }
};

window.resetGlobalDefault = async (key) => {
    try {
        const schema = await window.api.getSettingsSchema();
        const config = schema[key];
        if (config) {
            await window.api.setGlobalDefault(key, config.default);
            
            // Update the input to show the default value
            const inputId = `global-${key}`;
            const input = document.getElementById(inputId);
            
            if (input) {
                if (config.type === 'time') {
                    const hours = Math.floor(config.default / 3600);
                    const minutes = Math.floor((config.default % 3600) / 60);
                    const hoursInput = document.getElementById(`${inputId}-hours`);
                    const minutesInput = document.getElementById(`${inputId}-minutes`);
                    if (hoursInput) hoursInput.value = hours;
                    if (minutesInput) minutesInput.value = minutes;
                } else if (config.type === 'boolean') {
                    input.checked = config.default;
                } else {
                    input.value = config.default;
                }
                input.classList.remove('input-warning');
            }
        }
    } catch (error) {
        console.error('Error resetting global default:', error);
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
            votingInterval: 3,
        };
        
        const defaultValue = defaultValues[key];
        if (defaultValue !== undefined) {
            await window.api.setSetting(key, defaultValue);
            
            // Update the input
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
            }
        }
    } catch (error) {
        console.error('Error resetting UI setting:', error);
    }
};

window.saveChallengeSettings = async (challengeId) => {
    try {
        const schema = await window.api.getSettingsSchema();
        
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
                    value = parseInt(input.value) || input.value;
                }
                
                await window.api.setChallengeOverride(key, challengeId, value);
            }
        }
        
        // Close modal
        window.closeChallengeSettingsModal();
        
        // Refresh challenges to show updated settings
        const timezone = await window.api.getSetting('timezone');
        await loadChallenges(timezone, false);
        
    } catch (error) {
        console.error('Error saving challenge settings:', error);
        alert('Failed to save challenge settings. Check console for details.');
    }
};

window.resetChallengeSettings = async (challengeId) => {
    try {
        const schema = await window.api.getSettingsSchema();
        
        for (const [key] of Object.entries(schema)) {
            await window.api.setChallengeOverride(key, challengeId, null);
        }
        
        // Close modal
        window.closeChallengeSettingsModal();
        
        // Refresh challenges
        const timezone = await window.api.getSetting('timezone');
        await loadChallenges(timezone, false);
        
    } catch (error) {
        console.error('Error resetting challenge settings:', error);
        alert('Failed to reset challenge settings. Check console for details.');
    }
};

window.resetChallengeOverride = async (key, challengeId) => {
    try {
        await window.api.setChallengeOverride(key, challengeId, null);
        
        // Update the input to show the global default
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
                    if (hoursInput) hoursInput.value = hours;
                    if (minutesInput) minutesInput.value = minutes;
                } else if (config.type === 'boolean') {
                    input.checked = globalDefault;
                } else {
                    input.value = globalDefault;
                }
                input.classList.remove('input-warning');
            }
        }
    } catch (error) {
        console.error('Error resetting challenge override:', error);
    }
};