const translationManager = window.translationManager;

export const generateSettingsModalHtml = async (schema, globalDefaults, challenges) => {
    console.log('generateSettingsModalHtml called with:', {schema, globalDefaults, challengesCount: challenges.length});

    // Validate inputs
    if (!schema || Object.keys(schema).length === 0) {
        console.error('No schema provided to generateSettingsModalHtml');
        return '<div class="text-error">Error: No settings schema available</div>';
    }

    if (!globalDefaults) {
        console.error('No globalDefaults provided to generateSettingsModalHtml');
        return '<div class="text-error">Error: No global defaults available</div>';
    }

    // Generate global settings inputs (same style as per-challenge)
    let globalSettingsHtml = '';
    for (const [key, config] of Object.entries(schema)) {
        try {
            const value = globalDefaults[key];
            console.log(`Processing global setting ${key}:`, {value, config});

            if (value === undefined || value === null) {
                console.warn(`Missing value for global setting ${key}, using default`);
                globalDefaults[key] = config.default;
            }

            const inputHtml = generateInputHtml(key, config, globalDefaults[key], '');
            const labelText = translationManager.t(config.label) || config.label || key;
            const descText = translationManager.t(config.description) || config.description || 'No description';

            globalSettingsHtml += `
                <div class="form-control mb-4">
                    <label class="label">
                        <span class="label-text font-medium" data-translate="${config.label}">${labelText}</span>
                        <span class="badge badge-ghost badge-xs ml-2" data-translate="app.globalDefault">${translationManager.t('app.globalDefault')}</span>
                    </label>
                    <p class="text-xs text-base-content/60 mb-2" data-translate="${config.description}">${descText}</p>
                    <div class="flex items-center gap-2">
                        ${inputHtml}
                        <button class="btn btn-ghost btn-sm tooltip tooltip-left" data-tip="${translationManager.t('app.resetToDefaultNotSaved')}" onclick="resetGlobalDefault('${key}')">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                            </svg>
                        </button>
                    </div>
                </div>
            `;
        } catch (error) {
            console.error(`Error generating HTML for global setting ${key}:`, error);
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

    console.log('Generated global settings HTML length:', globalSettingsHtml.length);

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
                        <span data-translate="app.globalSettings">${translationManager.t('app.globalSettings')}</span>
                    </h3>
                    <button class="btn btn-ghost btn-sm" onclick="closeSettingsModal()">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                
                <div class="space-y-6">
                    <!-- App Settings Section -->
                    <div>
                        <h4 class="font-semibold text-base mb-3 border-b border-base-300 pb-2" data-translate="app.applicationSettings">${translationManager.t('app.applicationSettings')}</h4>
                        <div class="space-y-4">
                            ${uiSettingsHtml || `<div class="text-error" data-translate="app.noUiSettingsToDisplay">${translationManager.t('app.noUiSettingsToDisplay')}</div>`}
                        </div>
                    </div>
                    
                    <!-- Challenge Settings Section -->
                    <div>
                        <h4 class="font-semibold text-base mb-3 border-b border-base-300 pb-2" data-translate="app.challengeDefaults">${translationManager.t('app.challengeDefaults')}</h4>
                        <div class="space-y-4">
                            ${globalSettingsHtml || `<div class="text-error" data-translate="app.noGlobalSettingsToDisplay">${translationManager.t('app.noGlobalSettingsToDisplay')}</div>`}
                        </div>
                    </div>
                </div>
                
                <div class="modal-action">
                    <button class="btn btn-latvian" onclick="saveGlobalSettings()">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                        </svg>
                        <span data-translate="app.save">${translationManager.t('app.save') || 'Save'}</span>
                    </button>
                    <button class="btn btn-warning" onclick="resetAllSettings()">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                        <span data-translate="app.resetAll">${translationManager.t('app.resetAll')}</span>
                    </button>
                    <button class="btn" onclick="closeSettingsModal()">
                        <span data-translate="app.cancel">${translationManager.t('app.cancel') || 'Cancel'}</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    console.log('Final modal HTML length:', modalHtml.length);
    return modalHtml;
};

// Function to generate UI settings HTML
const generateUISettingsHtml = async () => {
    try {
        const settings = await window.api.getSettings();

        let uiSettingsHtml = '';

        // Theme Setting
        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.theme">${translationManager.t('app.theme')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.uiSetting">${translationManager.t('app.uiSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.themeDesc">${translationManager.t('app.themeDesc')}</p>
                <div class="flex items-center gap-2">
                    <span class="text-sm" data-translate="common.light">${translationManager.t('common.light')}</span>
                    <input type="checkbox" id="modal-theme-toggle" class="toggle toggle-sm" ${settings.theme === 'dark' ? 'checked' : ''}>
                    <span class="text-sm" data-translate="common.dark">${translationManager.t('common.dark')}</span>
                    <button class="btn btn-ghost btn-sm tooltip tooltip-left" data-tip="${translationManager.t('app.resetToDefaultNotSaved')}" onclick="resetUISetting('theme')">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        // Language Setting
        const currentLang = settings.language || 'en';
        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.language">${translationManager.t('app.language')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.uiSetting">${translationManager.t('app.uiSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.languageDesc">${translationManager.t('app.languageDesc')}</p>
                <div class="flex items-center gap-2">
                    <select id="modal-language-select" class="select select-bordered select-sm">
                        <option value="en" ${currentLang === 'en' ? 'selected' : ''}>${translationManager.t('app.english')}</option>
                        <option value="lv" ${currentLang === 'lv' ? 'selected' : ''}>${translationManager.t('app.latvian')}</option>
                    </select>
                    <button class="btn btn-ghost btn-sm tooltip tooltip-left" data-tip="${translationManager.t('app.resetToDefaultNotSaved')}" onclick="resetUISetting('language')">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        // Timezone Setting
        const currentTimezone = settings.timezone || 'Europe/Riga';
        const customTimezones = settings.customTimezones || [];
        let timezoneOptions = '<option value="Europe/Riga">Europe/Riga</option>';

        // Add custom timezones
        customTimezones.forEach(tz => {
            if (tz !== 'Europe/Riga') {
                timezoneOptions += `<option value="${tz}"${currentTimezone === tz ? ' selected' : ''}>${tz}</option>`;
            }
        });

        // If current timezone is not in the list, add it
        if (currentTimezone !== 'Europe/Riga' && !customTimezones.includes(currentTimezone)) {
            timezoneOptions += `<option value="${currentTimezone}" selected>${currentTimezone}</option>`;
        }

        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.timezone">${translationManager.t('app.timezone')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.uiSetting">${translationManager.t('app.uiSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.timezoneDesc">${translationManager.t('app.timezoneDesc')}</p>
                <div class="flex items-center gap-2">
                    <select id="modal-timezone-select" class="select select-bordered select-sm" style="width: 200px;">
                        ${timezoneOptions}
                    </select>
                    <button id="modal-timezone-add" class="btn btn-ghost btn-sm" title="${translationManager.t('app.addCustomTimezone')}">+</button>
                    <button id="modal-timezone-remove" class="btn btn-ghost btn-sm text-red-500" title="${translationManager.t('app.removeCurrentTimezone')}" style="visibility: ${currentTimezone !== 'Europe/Riga' ? 'visible' : 'hidden'}">×</button>
                    <button class="btn btn-ghost btn-sm tooltip tooltip-left" data-tip="${translationManager.t('app.resetToDefaultNotSaved')}" onclick="resetUISetting('timezone')">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                    </button>
                </div>
                <input id="modal-timezone-input" type="text" placeholder="${translationManager.t('app.timezonePlaceholder')}" class="input input-bordered input-sm mt-2" style="display: none; width: 250px;">
            </div>
        `;

        // Stay Logged In Setting
        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.stayLoggedIn">${translationManager.t('app.stayLoggedIn')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.appSetting">${translationManager.t('app.appSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.stayLoggedInDesc">${translationManager.t('app.stayLoggedInDesc')}</p>
                <div class="flex items-center gap-2">
                    <input type="checkbox" id="modal-stay-logged-in" class="checkbox checkbox-sm" ${settings.stayLoggedIn ? 'checked' : ''}>
                    <span class="text-sm" data-translate="app.rememberLoginSession">${translationManager.t('app.rememberLoginSession')}</span>
                    <button class="btn btn-ghost btn-sm tooltip tooltip-left" data-tip="${translationManager.t('app.resetToDefaultNotSaved')}" onclick="resetUISetting('stayLoggedIn')">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        // Update Check Setting
        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.checkForUpdates">${translationManager.t('app.checkForUpdates')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.appSetting">${translationManager.t('app.appSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.checkForUpdatesDesc">${translationManager.t('app.checkForUpdatesDesc')}</p>
                <div class="flex items-center gap-2">
                    <button id="check-updates-btn" class="btn btn-sm btn-outline">
                        <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                        <span data-translate="app.checkForUpdates">${translationManager.t('app.checkForUpdates')}</span>
                    </button>
                    <span id="update-check-status" class="text-sm text-base-content/60"></span>
                </div>
            </div>
        `;

        // API Timeout Setting
        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.apiTimeout">${translationManager.t('app.apiTimeout')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.appSetting">${translationManager.t('app.appSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.apiTimeoutDesc">${translationManager.t('app.apiTimeoutDesc')}</p>
                <div class="flex items-center gap-2">
                    <input type="number" id="modal-api-timeout" class="input input-bordered input-sm w-20" 
                           value="${settings.apiTimeout || 30}" min="1" max="120" step="1">
                    <span class="text-sm text-base-content/60" data-translate="app.seconds">${translationManager.t('app.seconds')}</span>
                </div>
            </div>
        `;

        // Voting Interval Setting
        uiSettingsHtml += `
            <div class="form-control mb-4">
                <label class="label">
                    <span class="label-text font-medium" data-translate="app.votingInterval">${translationManager.t('app.votingInterval')}</span>
                    <span class="badge badge-ghost badge-xs ml-2" data-translate="app.appSetting">${translationManager.t('app.appSetting')}</span>
                </label>
                <p class="text-xs text-base-content/60 mb-2" data-translate="app.votingIntervalDesc">${translationManager.t('app.votingIntervalDesc')}</p>
                <div class="flex items-center gap-2">
                    <input type="number" id="modal-voting-interval" class="input input-bordered input-sm w-20" 
                           value="${settings.votingInterval || 3}" min="1" max="60" step="1">
                    <span class="text-sm text-base-content/60" data-translate="app.minutes">${translationManager.t('app.minutes')}</span>
                </div>
            </div>
        `;

        return uiSettingsHtml;
    } catch (error) {
        console.error('Error generating UI settings HTML:', error);
        return `<div class="text-error" data-translate="app.errorLoadingUiSettings">${translationManager.t('app.errorLoadingUiSettings')}</div>`;
    }
};

// Function to generate input HTML based on setting type
const generateInputHtml = (key, config, value, challengeId = '', hasOverride = false) => {
    try {
        console.log(`Generating input HTML for ${key}:`, {config, value, challengeId, hasOverride});

        if (!config) {
            console.error(`No config provided for setting ${key}`);
            return `<div class="text-error" data-translate="app.missingConfigFor">${translationManager.t('app.missingConfigFor')} ${key}</div>`;
        }

        const inputId = challengeId ? `${key}-${challengeId}` : `global-${key}`;
        const inputClass = hasOverride ? 'input-error' : '';

        // Handle undefined/null values
        if (value === undefined || value === null) {
            console.warn(`Using default value for ${key}:`, config.default);
            value = config.default || 0;
        }

        // Safe translation with fallbacks
        const hoursText = translationManager.t('app.hours') || 'hours';
        const minutesText = translationManager.t('app.minutes') || 'minutes';
        const resetTooltip = translationManager.t('app.resetToGlobal') || 'Reset to Global';

        switch (config.type) {
        case 'time': {
            const hours = Math.floor(Number(value) / 3600);
            const minutes = Math.floor((Number(value) % 3600) / 60);
            return `
                    <div class="flex gap-2 items-center">
                        <input type="number" id="${inputId}-hours" class="input input-bordered input-sm w-20 ${inputClass}" 
                               value="${hours}" min="0" max="24" data-setting="${key}" data-challenge="${challengeId}">
                        <span class="text-sm" data-translate="app.hours">${hoursText}</span>
                        <input type="number" id="${inputId}-minutes" class="input input-bordered input-sm w-20 ${inputClass}" 
                               value="${minutes}" min="0" max="59" data-setting="${key}" data-challenge="${challengeId}">
                        <span class="text-sm" data-translate="app.minutes">${minutesText}</span>
                        ${challengeId ? `<button class="btn btn-xs btn-ghost" onclick="resetChallengeOverride('${key}', '${challengeId}')" title="${resetTooltip}">↻</button>` : ''}
                    </div>
                `;
        }

        case 'boolean': {
            return `
                    <div class="flex items-center gap-2">
                        <input type="checkbox" id="${inputId}" class="checkbox checkbox-sm ${inputClass}" 
                               ${value ? 'checked' : ''} data-setting="${key}" data-challenge="${challengeId}">
                        ${challengeId ? `<button class="btn btn-xs btn-ghost" onclick="resetChallengeOverride('${key}', '${challengeId}')" title="${resetTooltip}">↻</button>` : ''}
                    </div>
                `;
        }

        case 'number':
        default:
            return `
                    <div class="flex items-center gap-2">
                        <input type="number" id="${inputId}" class="input input-bordered input-sm w-24 ${inputClass}" 
                               value="${Number(value)}" min="0" data-setting="${key}" data-challenge="${challengeId}">
                        ${challengeId ? `<button class="btn btn-xs btn-ghost" onclick="resetChallengeOverride('${key}', '${challengeId}')" title="${resetTooltip}">↻</button>` : ''}
                    </div>
                `;
        }
    } catch (error) {
        console.error(`Error generating input HTML for ${key}:`, error);
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

    // Voting interval
    const votingInterval = document.getElementById('modal-voting-interval');
    if (votingInterval) {
        votingInterval.addEventListener('change', () => {
            // Mark as modified - don't auto-save
            votingInterval.classList.add('input-error');
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
    console.log('generateChallengeSettingsModalHtml called with:', {challengeId, challengeTitle, schema, globalDefaults, challengeSettings});

    // Validate inputs
    if (!schema || Object.keys(schema).length === 0) {
        console.error('No schema provided to generateChallengeSettingsModalHtml');
        return '<div class="text-error">Error: No settings schema available</div>';
    }

    if (!globalDefaults) {
        console.error('No globalDefaults provided to generateChallengeSettingsModalHtml');
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

            console.log(`Processing challenge setting ${key}:`, {globalValue, challengeValue, hasOverride, effectiveValue});

            if (effectiveValue === undefined || effectiveValue === null) {
                console.warn(`Missing value for challenge setting ${key}, using default`);
                challengeSettings[key] = config.default;
            }

            const inputHtml = generateInputHtml(key, config, effectiveValue, challengeId, hasOverride);
            const labelText = translationManager.t(config.label) || config.label || key;
            const descText = translationManager.t(config.description) || config.description || 'No description';

            challengeSettingsHtml += `
                <div class="form-control mb-4">
                    <label class="label">
                        <span class="label-text font-medium" data-translate="${config.label}">${labelText}</span>
                        ${hasOverride ? '<span class="badge badge-warning badge-xs ml-2" data-translate="app.override">Override</span>' : '<span class="badge badge-ghost badge-xs ml-2" data-translate="app.globalDefault">Global</span>'}
                    </label>
                    <p class="text-xs text-base-content/60 mb-2" data-translate="${config.description}">${descText}</p>
                    <div class="flex items-center gap-2">
                        ${inputHtml}
                    </div>
                </div>
            `;
        } catch (error) {
            console.error(`Error generating HTML for challenge setting ${key}:`, error);
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
                        <span data-translate="app.challengeSettings">${translationManager.t('app.challengeSettings')}</span>
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
                
                <div class="space-y-4">
                    ${challengeSettingsHtml || `<div class="text-error" data-translate="app.noChallengeSettingsToDisplay">${translationManager.t('app.noChallengeSettingsToDisplay')}</div>`}
                </div>
                
                <div class="modal-action">
                    <button class="btn btn-latvian" onclick="saveChallengeSettings('${challengeId}')">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                        </svg>
                        <span data-translate="app.save">${translationManager.t('app.save') || 'Save'}</span>
                    </button>
                    <button class="btn btn-warning" onclick="resetChallengeSettings('${challengeId}')">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                        </svg>
                        <span data-translate="app.resetAll">${translationManager.t('app.resetAll')}</span>
                    </button>
                    <button class="btn" onclick="closeChallengeSettingsModal()">
                        <span data-translate="app.cancel">${translationManager.t('app.cancel') || 'Cancel'}</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    console.log('Final challenge settings modal HTML length:', modalHtml.length);
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