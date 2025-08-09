// Get translation manager with fallback
const getTranslationManager = () => {
    if (window.translationManager && typeof window.translationManager.t === 'function') {
        return window.translationManager;
    }
    // Fallback translation manager - return key if translation manager is not available
    return {
        t: (key) => key,
    };
};

const translationManager = getTranslationManager();

export const generateSettingsModalHtml = async (schema, globalDefaults, challenges) => {
    await window.api.logDebug(`generateSettingsModalHtml called with: schema=${Object.keys(schema).length} keys, globalDefaults=${Object.keys(globalDefaults).length} keys, challengesCount=${challenges.length}`);

    // Validate inputs
    if (!schema || Object.keys(schema).length === 0) {
        await window.api.logError('No schema provided to generateSettingsModalHtml');
        return '<div class="text-error">Error: No settings schema available</div>';
    }

    if (!globalDefaults) {
        await window.api.logError('No globalDefaults provided to generateSettingsModalHtml');
        return '<div class="text-error">Error: No global defaults available</div>';
    }

    // Generate global settings inputs (same style as per-challenge)
    let globalSettingsHtml = '';
    for (const [key, config] of Object.entries(schema)) {
        try {
            const value = globalDefaults[key];
            await window.api.logDebug(`Processing global setting ${key}: value=${value}, config.type=${config.type}`);

            if (value === undefined || value === null) {
                await window.api.logDebug(`Missing value for global setting ${key}, using default: ${config.default}`);
                globalDefaults[key] = config.default;
            }

            const inputHtml = await generateInputHtml(key, config, globalDefaults[key], '');
            const globalInputWithReset = `
                <div class="flex items-center gap-2">
                    ${inputHtml}
                    ${generateResetButton(key, true)}
                </div>
            `;
            globalSettingsHtml += generateSettingHtml(key, config.label, config.description, globalInputWithReset, 'globalDefault');
        } catch (error) {
            await window.api.logError(`Error generating HTML for global setting ${key}: ${error.message || error}`);
            // Add a simple fallback
            globalSettingsHtml += `
                <div class="form-control mb-4">
                    <label class="label">
                        <span class="label-text font-medium">${key}</span>
                        <span class="badge badge-error badge-xs ml-2">Error</span>
                    </label>
                    <p class="text-xs text-base-content/60 mb-2">Error loading setting</p>
                    <div class="text-error">Error: ${error.message || 'Unknown error'}</div>
                </div>
            `;
        }
    }

    await window.api.logDebug(`Generated global settings HTML length: ${globalSettingsHtml.length}`);

    // Generate UI settings HTML
    const uiSettingsHtml = await generateUISettingsHtml();

    const modalHtml = `
        <div class="modal modal-open">
            <div class="modal-box max-w-3xl">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="font-bold text-lg">
                        <svg class="w-5 h-5 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                        </svg>
                        <span>${translationManager.t('app.globalSettings')}</span>
                    </h3>
                    <button class="btn btn-ghost btn-sm" onclick="closeSettingsModal()">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                
                <!-- Duplicate buttons at top for better UX -->
                <div class="flex justify-end gap-2 mb-4">
                    <button class="btn btn-latvian" onclick="saveGlobalSettings(event)" type="button">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                        </svg>
                        <span>${translationManager.t('app.save')}</span>
                    </button>
                    <button class="btn btn-warning" onclick="resetAllSettings()">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                        <span>${translationManager.t('app.resetAll')}</span>
                    </button>
                    <button class="btn" onclick="closeSettingsModal()">
                        <span>${translationManager.t('app.cancel')}</span>
                    </button>
                </div>
                
                <div class="space-y-6">
                    <!-- App Settings Section -->
                    <div>
                        <h4 class="font-semibold text-base mb-3 border-b border-base-300 pb-2">${translationManager.t('app.applicationSettings')}</h4>
                        <div class="space-y-4">
                            ${uiSettingsHtml || `<div class="text-error">${translationManager.t('app.noUiSettingsToDisplay')}</div>`}
                        </div>
                    </div>
                    
                    <!-- Challenge Settings Section -->
                    <div>
                        <h4 class="font-semibold text-base mb-3 border-b border-base-300 pb-2">${translationManager.t('app.challengeDefaults')}</h4>
                        <div class="space-y-4">
                            ${globalSettingsHtml || `<div class="text-error">${translationManager.t('app.noGlobalSettingsToDisplay')}</div>`}
                        </div>
                    </div>
                </div>
                
                <div class="modal-action">
                    <button class="btn btn-latvian" onclick="saveGlobalSettings(event)" type="button">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                        </svg>
                        <span>${translationManager.t('app.save')}</span>
                    </button>
                    <button class="btn btn-warning" onclick="resetAllSettings()">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                        <span>${translationManager.t('app.resetAll')}</span>
                    </button>
                    <button class="btn" onclick="closeSettingsModal()">
                        <span>${translationManager.t('app.cancel')}</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    await window.api.logDebug(`Final modal HTML length: ${modalHtml.length}`);
    return modalHtml;
};

// Helper function to generate reset button HTML
const generateResetButton = (settingKey, isGlobal = false) => {
    const onclick = isGlobal ? `resetGlobalDefault('${settingKey}')` : `resetUISetting('${settingKey}')`;
    return `
        <button class="btn btn-ghost btn-sm tooltip tooltip-right" data-tip="${translationManager.t('app.resetToDefaultNotSaved')}" onclick="${onclick}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
            </svg>
        </button>
    `;
};

// Helper function to generate setting wrapper HTML
const generateSettingHtml = (key, label, description, inputHtml, badgeType = 'uiSetting') => {
    return `
        <div class="form-control mb-4">
            <label class="label">
                <span class="label-text font-medium">${translationManager.t(label)}</span>
                <span class="badge badge-ghost badge-xs ml-2">${translationManager.t(`app.${badgeType}`)}</span>
            </label>
            <p class="text-xs text-base-content/60 mb-2">${translationManager.t(description)}</p>
            ${inputHtml}
        </div>
    `;
};

// Function to generate UI settings HTML
const generateUISettingsHtml = async () => {
    try {
        const settings = await window.api.getSettings();
        let uiSettingsHtml = '';

        // Theme Setting
        const themeInputHtml = `
            <div class="flex items-center gap-2">
                <span class="text-sm">${translationManager.t('common.light')}</span>
                <input type="checkbox" id="modal-theme-toggle" class="toggle toggle-sm" ${settings.theme === 'dark' ? 'checked' : ''}>
                <span class="text-sm">${translationManager.t('common.dark')}</span>
                ${generateResetButton('theme')}
            </div>
        `;
        uiSettingsHtml += generateSettingHtml('theme', 'app.theme', 'app.themeDesc', themeInputHtml);

        // Language Setting
        const currentLang = settings.language;
        const languageInputHtml = `
            <div class="flex items-center gap-2">
                <select id="modal-language-select" class="select select-bordered select-sm">
                    <option value="en" ${currentLang === 'en' ? 'selected' : ''}>${translationManager.t('app.english')}</option>
                    <option value="lv" ${currentLang === 'lv' ? 'selected' : ''}>${translationManager.t('app.latvian')}</option>
                </select>
                ${generateResetButton('language')}
            </div>
        `;
        uiSettingsHtml += generateSettingHtml('language', 'app.language', 'app.languageDesc', languageInputHtml);

        // Timezone Setting
        const currentTimezone = settings.timezone;
        const customTimezones = settings.customTimezones || [];
        let timezoneOptions = '<option value="Europe/Riga">Europe/Riga</option>';
        
        customTimezones.forEach(tz => {
            if (tz !== 'Europe/Riga') {
                timezoneOptions += `<option value="${tz}"${currentTimezone === tz ? ' selected' : ''}>${tz}</option>`;
            }
        });
        
        if (currentTimezone !== 'Europe/Riga' && !customTimezones.includes(currentTimezone)) {
            timezoneOptions += `<option value="${currentTimezone}" selected>${currentTimezone}</option>`;
        }

        const timezoneInputHtml = `
            <div class="flex items-center gap-2">
                <select id="modal-timezone-select" class="select select-bordered select-sm w-48">
                    ${timezoneOptions}
                </select>
                <button id="modal-timezone-add" class="btn btn-ghost btn-sm" title="${translationManager.t('app.addCustomTimezone')}">+</button>
                <button id="modal-timezone-remove" class="btn btn-ghost btn-sm text-error ${currentTimezone !== 'Europe/Riga' ? '' : 'invisible'}" title="${translationManager.t('app.removeCurrentTimezone')}">×</button>
                ${generateResetButton('timezone')}
            </div>
            <input id="modal-timezone-input" type="text" placeholder="${translationManager.t('app.timezonePlaceholder')}" class="input input-bordered input-sm mt-2 w-60 hidden">
        `;
        uiSettingsHtml += generateSettingHtml('timezone', 'app.timezone', 'app.timezoneDesc', timezoneInputHtml);

        // Stay Logged In Setting
        const stayLoggedInInputHtml = `
            <div class="flex items-center gap-2">
                <input type="checkbox" id="modal-stay-logged-in" class="checkbox checkbox-sm" ${settings.stayLoggedIn ? 'checked' : ''}>
                <span class="text-sm">${translationManager.t('app.rememberLoginSession')}</span>
                ${generateResetButton('stayLoggedIn')}
            </div>
        `;
        uiSettingsHtml += generateSettingHtml('stayLoggedIn', 'app.stayLoggedIn', 'app.stayLoggedInDesc', stayLoggedInInputHtml, 'appSetting');

        // Update Check Setting
        const updateCheckInputHtml = `
            <div class="flex items-center gap-2">
                <button id="check-updates-btn" class="btn btn-sm btn-outline">
                    <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                    </svg>
                    <span>${translationManager.t('app.checkForUpdates')}</span>
                </button>
                <span id="update-check-status" class="text-sm text-base-content/60"></span>
            </div>
        `;
        uiSettingsHtml += generateSettingHtml('checkForUpdates', 'app.checkForUpdates', 'app.checkForUpdatesDesc', updateCheckInputHtml, 'appSetting');

        // API Timeout Setting
        const apiTimeoutInputHtml = `
            <div class="flex items-center gap-2">
                <input type="number" id="modal-api-timeout" class="input input-bordered input-sm w-20" 
                       value="${settings.apiTimeout}" min="1" max="120" step="1">
                <span class="text-sm text-base-content/60">${translationManager.t('app.seconds')}</span>
                ${generateResetButton('apiTimeout')}
            </div>
        `;
        uiSettingsHtml += generateSettingHtml('apiTimeout', 'app.apiTimeout', 'app.apiTimeoutDesc', apiTimeoutInputHtml, 'appSetting');

        // Check Frequency Setting
        const checkFrequencyInputHtml = `
            <div class="flex items-center gap-2">
                <input type="number" id="modal-check-frequency" class="input input-bordered input-sm w-20" 
                       value="${settings.checkFrequency}" min="1" max="60" step="1">
                <span class="text-sm text-base-content/60">${translationManager.t('app.minutes')}</span>
                ${generateResetButton('checkFrequency')}
            </div>
        `;
        uiSettingsHtml += generateSettingHtml('checkFrequency', 'app.checkFrequency', 'app.checkFrequencyDesc', checkFrequencyInputHtml, 'appSetting');

        return uiSettingsHtml;
    } catch (error) {
        await window.api.logError(`Error generating UI settings HTML: ${error.message || error}`);
        return `<div class="text-error">${translationManager.t('app.errorLoadingUiSettings')}</div>`;
    }
};

// Function to generate input HTML based on setting type
const generateInputHtml = async (key, config, value, challengeId = '', hasOverride = false) => {
    try {
        await window.api.logDebug(`=== generateInputHtml START for ${key} ===`);
        await window.api.logDebug(`Generating input HTML for ${key}: config=${JSON.stringify(config)}, value=${value}, challengeId=${challengeId}, hasOverride=${hasOverride}`);

        if (!config) {
            await window.api.logError(`No config provided for setting ${key}`);
            return `<div class="text-error">${translationManager.t('app.missingConfigFor')} ${key}</div>`;
        }

        const inputId = challengeId ? `${key}-${challengeId}` : `global-${key}`;
        const inputClass = hasOverride ? 'input-error' : '';

        // Handle undefined/null values
        if (value === undefined || value === null) {
            await window.api.logDebug(`Using default value for ${key}: ${config.default}`);
            value = config.default || 0;
        }

        // Safe translation with fallbacks
        const hoursText = translationManager.t('app.hours');
        const minutesText = translationManager.t('app.minutes');
        const resetTooltip = translationManager.t('app.resetToDefaultNotSaved');

        // Generate challenge reset button with proper tooltip
        const challengeResetButton = challengeId ? `<button class="btn btn-xs btn-ghost tooltip tooltip-right" data-tip="${resetTooltip}" onclick="resetChallengeOverride('${key}', '${challengeId}')">↻</button>` : '';

        switch (config.type) {
        case 'time': {
            const hours = Math.floor(Number(value) / 3600);
            const minutes = Math.floor((Number(value) % 3600) / 60);
            const html = `
                    <div class="flex gap-2 items-center">
                        <input type="number" id="${inputId}-hours" class="input input-bordered input-sm w-20 ${inputClass}" 
                               value="${hours}" min="0" max="24" data-setting="${key}" data-challenge="${challengeId}">
                        <span class="text-sm">${hoursText}</span>
                        <input type="number" id="${inputId}-minutes" class="input input-bordered input-sm w-20 ${inputClass}" 
                               value="${minutes}" min="0" max="59" data-setting="${key}" data-challenge="${challengeId}">
                        <span class="text-sm">${minutesText}</span>
                        ${challengeResetButton}
                    </div>
                `;
            await window.api.logDebug(`=== generateInputHtml END for ${key} (time) ===`);
            return html;
        }

        case 'boolean': {
            const html = `
                    <div class="flex items-center gap-2">
                        <input type="checkbox" id="${inputId}" class="checkbox checkbox-sm ${inputClass}" 
                               ${value ? 'checked' : ''} data-setting="${key}" data-challenge="${challengeId}">
                        ${challengeResetButton}
                    </div>
                `;
            await window.api.logDebug(`=== generateInputHtml END for ${key} (boolean) ===`);
            return html;
        }

        case 'number':
        default: {
            const html = `
                    <div class="flex items-center gap-2">
                        <input type="number" id="${inputId}" class="input input-bordered input-sm w-24 ${inputClass}" 
                               value="${Number(value)}" min="0" data-setting="${key}" data-challenge="${challengeId}">
                        ${challengeResetButton}
                    </div>
                `;
            await window.api.logDebug(`=== generateInputHtml END for ${key} (number) ===`);
            return html;
        }
        }
    } catch (error) {
        await window.api.logError(`Error generating input HTML for ${key}: ${error.message || error}`);
        await window.api.logError(`Translation manager available: ${!!window.translationManager}`);
        await window.api.logError(`Translation manager type: ${typeof window.translationManager}`);
        return `<div class="text-error">Error generating input for ${key}: ${error.message || 'Unknown error'}</div>`;
    }
};

// Function to initialize settings modal event handlers
export const initializeSettingsModal = (schema) => {
    // Add event listeners for UI settings
    initializeUISettingsHandlers();

    // Add event listeners for global settings
    for (const [key] of Object.entries(schema)) {
        const inputId = `global-${key}`;
        const input = document.getElementById(inputId);
        
        if (input) {
            input.addEventListener('change', () => {
                // Mark as modified
                input.classList.add('input-error');
            });
        }
    }
};

// Function to initialize UI settings handlers
const initializeUISettingsHandlers = () => {
    // Theme toggle
    const themeToggle = document.getElementById('modal-theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('change', () => {
            // Mark as modified - don't auto-save
            themeToggle.classList.add('input-error');
        });
    }

    // Language select
    const languageSelect = document.getElementById('modal-language-select');
    if (languageSelect) {
        languageSelect.addEventListener('change', () => {
            // Mark as modified - don't auto-save
            languageSelect.classList.add('input-error');
        });
    }

    // Timezone select
    const timezoneSelect = document.getElementById('modal-timezone-select');
    if (timezoneSelect) {
        timezoneSelect.addEventListener('change', () => {
            // Mark as modified - don't auto-save
            timezoneSelect.classList.add('input-error');
        });
    }

    // Stay logged in
    const stayLoggedIn = document.getElementById('modal-stay-logged-in');
    if (stayLoggedIn) {
        stayLoggedIn.addEventListener('change', () => {
            // Mark as modified - don't auto-save
            stayLoggedIn.classList.add('input-error');
        });
    }

    // API timeout
    const apiTimeout = document.getElementById('modal-api-timeout');
    if (apiTimeout) {
        apiTimeout.addEventListener('change', () => {
            // Mark as modified - don't auto-save
            apiTimeout.classList.add('input-error');
        });
    }

    // Check frequency
    const checkFrequency = document.getElementById('modal-check-frequency');
    if (checkFrequency) {
        checkFrequency.addEventListener('change', () => {
            // Mark as modified - don't auto-save
            checkFrequency.classList.add('input-error');
        });
    }

    // Check updates button
    const checkUpdatesBtn = document.getElementById('check-updates-btn');
    const updateCheckStatus = document.getElementById('update-check-status');
    if (checkUpdatesBtn && updateCheckStatus) {
        checkUpdatesBtn.addEventListener('click', async () => {
            // Update button state to show checking
            checkUpdatesBtn.disabled = true;
            checkUpdatesBtn.classList.add('loading');
            updateCheckStatus.textContent = translationManager.t('common.loading');
            
            try {
                const result = await window.api.checkForUpdates();
                
                if (result.success) {
                    if (result.updateInfo) {
                        // Update available - show in dialog
                        updateCheckStatus.textContent = translationManager.t('app.updateAvailable');
                        updateCheckStatus.classList.remove('text-base-content/60');
                        updateCheckStatus.classList.add('text-success');
                        
                        // Show the update dialog
                        if (window.showUpdateDialog) {
                            window.showUpdateDialog(result.updateInfo);
                        }
                    } else {
                        // No update available - show status message
                        updateCheckStatus.textContent = translationManager.t('app.noUpdatesAvailable');
                        updateCheckStatus.classList.remove('text-base-content/60');
                        updateCheckStatus.classList.add('text-success');
                        
                        // Clear status message after 3 seconds
                        setTimeout(() => {
                            updateCheckStatus.textContent = '';
                            updateCheckStatus.classList.remove('text-success');
                            updateCheckStatus.classList.add('text-base-content/60');
                        }, 3000);
                    }
                } else {
                    // Error checking for updates
                    updateCheckStatus.textContent = translationManager.t('app.errorCheckingUpdates');
                    updateCheckStatus.classList.remove('text-base-content/60');
                    updateCheckStatus.classList.add('text-error');
                    
                    // Clear error message after 5 seconds
                    setTimeout(() => {
                        updateCheckStatus.textContent = '';
                        updateCheckStatus.classList.remove('text-error');
                        updateCheckStatus.classList.add('text-base-content/60');
                    }, 5000);
                }
            } catch (error) {
                await window.api.logError(`Error checking for updates: ${error.message || error}`);
                updateCheckStatus.textContent = translationManager.t('app.errorCheckingUpdates');
                updateCheckStatus.classList.remove('text-base-content/60');
                updateCheckStatus.classList.add('text-error');
                
                // Clear error message after 5 seconds
                setTimeout(() => {
                    updateCheckStatus.textContent = '';
                    updateCheckStatus.classList.remove('text-error');
                    updateCheckStatus.classList.add('text-base-content/60');
                }, 5000);
            } finally {
                // Reset button state
                checkUpdatesBtn.disabled = false;
                checkUpdatesBtn.classList.remove('loading');
            }
        });
    }
};



// Function to close settings modal
export const closeSettingsModal = () => {
    const modal = document.querySelector('.modal');
    if (modal) {
        modal.remove();
    }
};

// Function to generate challenge settings modal HTML
export const generateChallengeSettingsModalHtml = async (challengeId, challengeTitle, schema, globalDefaults, challengeSettings) => {
    await window.api.logDebug(`generateChallengeSettingsModalHtml called with: challengeId=${challengeId}, challengeTitle=${challengeTitle}, schema=${Object.keys(schema).length} keys`);

    // Validate inputs
    if (!schema || Object.keys(schema).length === 0) {
        await window.api.logError('No schema provided to generateChallengeSettingsModalHtml');
        return '<div class="text-error">Error: No settings schema available</div>';
    }

    if (!globalDefaults) {
        await window.api.logError('No globalDefaults provided to generateChallengeSettingsModalHtml');
        return '<div class="text-error">Error: No global defaults available</div>';
    }

    // Generate challenge-specific settings inputs
    let challengeSettingsHtml = '';
    for (const [key, config] of Object.entries(schema)) {
        // Skip settings that don't support per-challenge overrides
        if (!config.perChallenge) {
            continue;
        }
        try {
            const globalValue = globalDefaults[key];
            const challengeValue = challengeSettings[key];
            const hasOverride = challengeValue !== null && challengeValue !== undefined;
            const effectiveValue = hasOverride ? challengeValue : globalValue;

            await window.api.logDebug(`Processing challenge setting ${key}: globalValue=${globalValue}, challengeValue=${challengeValue}, hasOverride=${hasOverride}, effectiveValue=${effectiveValue}`);

            if (effectiveValue === undefined || effectiveValue === null) {
                await window.api.logDebug(`Missing value for challenge setting ${key}, using default: ${config.default}`);
                challengeSettings[key] = config.default;
            }

            const inputHtml = await generateInputHtml(key, config, effectiveValue, challengeId, hasOverride);
            const labelText = translationManager.t(config.label);
            const descText = translationManager.t(config.description);

            challengeSettingsHtml += `
                <div class="form-control mb-4">
                    <label class="label">
                        <span class="label-text font-medium">${labelText}</span>
                        ${hasOverride ? `<span class="badge badge-warning badge-xs ml-2">${translationManager.t('app.override')}</span>` : `<span class="badge badge-ghost badge-xs ml-2">${translationManager.t('app.globalDefault')}</span>`}
                    </label>
                    <p class="text-xs text-base-content/60 mb-2">${descText}</p>
                    <div class="flex items-center gap-2">
                        ${inputHtml}
                    </div>
                </div>
            `;
        } catch (error) {
            await window.api.logError(`Error generating HTML for challenge setting ${key}: ${error.message || error}`);
            // Add a simple fallback
            challengeSettingsHtml += `
                <div class="form-control mb-4">
                    <label class="label">
                        <span class="label-text font-medium">${key}</span>
                        <span class="badge badge-error badge-xs ml-2">Error</span>
                    </label>
                    <p class="text-xs text-base-content/60 mb-2">Error loading setting</p>
                    <div class="text-error">Error: ${error.message || 'Unknown error'}</div>
                </div>
            `;
        }
    }

    const modalHtml = `
        <div class="modal modal-open">
            <div class="modal-box max-w-2xl">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="font-bold text-lg">
                        <svg class="w-5 h-5 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                        </svg>
                        <span>${translationManager.t('app.challengeSettings')}</span>
                    </h3>
                    <button class="btn btn-ghost btn-sm" onclick="closeChallengeSettingsModal()">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                
                <div class="mb-4">
                    <h4 class="font-semibold text-base mb-2">${challengeTitle}</h4>
                    <p class="text-sm text-base-content/60">${translationManager.t('app.challengeSettingsDesc')}</p>
                </div>
                
                <!-- Duplicate buttons at top for better UX -->
                <div class="flex justify-end gap-2 mb-4">
                    <button class="btn btn-latvian" onclick="saveChallengeSettings('${challengeId}', event)" type="button">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                        </svg>
                        <span>${translationManager.t('app.save')}</span>
                    </button>
                    <button class="btn btn-warning" onclick="resetChallengeSettings('${challengeId}')">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                        <span>${translationManager.t('app.resetAll')}</span>
                    </button>
                    <button class="btn" onclick="closeChallengeSettingsModal()">
                        <span>${translationManager.t('app.cancel')}</span>
                    </button>
                </div>
                
                <div class="space-y-4">
                    ${challengeSettingsHtml || `<div class="text-error">${translationManager.t('app.noChallengeSettingsToDisplay')}</div>`}
                </div>
                
                <div class="modal-action">
                    <button class="btn btn-latvian" onclick="saveChallengeSettings('${challengeId}', event)" type="button">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                        </svg>
                        <span>${translationManager.t('app.save')}</span>
                    </button>
                    <button class="btn btn-warning" onclick="resetChallengeSettings('${challengeId}')">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                        <span>${translationManager.t('app.resetAll')}</span>
                    </button>
                    <button class="btn" onclick="closeChallengeSettingsModal()">
                        <span>${translationManager.t('app.cancel')}</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    await window.api.logDebug(`Final challenge settings modal HTML length: ${modalHtml.length}`);
    await window.api.logDebug(`Challenge settings HTML content length: ${challengeSettingsHtml.length}`);
    await window.api.logDebug(`Translation manager available: ${!!window.translationManager}`);
    return modalHtml;
};

// Function to initialize challenge settings modal event handlers
export const initializeChallengeSettingsModal = (schema, challengeId) => {
    // Add event listeners for challenge settings
    for (const [key] of Object.entries(schema)) {
        const inputId = `${key}-${challengeId}`;
        const input = document.getElementById(inputId);
        
        if (input) {
            input.addEventListener('change', () => {
                // Mark as modified
                input.classList.add('input-error');
            });
        }
    }
};

// Function to format value for display
export const formatValue = (config, value) => {
    if (value === undefined || value === null) {
        return 'Not set';
    }

    switch (config.type) {
    case 'time': {
        const hours = Math.floor(Number(value) / 3600);
        const minutes = Math.floor((Number(value) % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }
    case 'boolean':
        return value ? 'Yes' : 'No';
    case 'number':
    default:
        return value.toString();
    }
}; 