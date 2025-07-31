// Block service worker registration
(() => {
    const C = globalThis.ServiceWorkerContainer;
    if (C?.prototype?.register) {
        Object.defineProperty(C.prototype, 'register', {
            value: function () {
                return Promise.reject(
                    new DOMException('Service workers disabled by Electron host', 'NotAllowedError'),
                );
            },
            writable: false,
            configurable: false,
        });
    }
})();

const {contextBridge, ipcRenderer} = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld(
    'api', {
        // Send methods
        login: () => ipcRenderer.send('login-success'),
        logout: () => ipcRenderer.send('logout'),

        // Settings methods
        getSettings: () => ipcRenderer.invoke('get-settings'),
        getSetting: (key) => ipcRenderer.invoke('get-setting', key),
        setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
        saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
        getEnvironmentInfo: () => ipcRenderer.invoke('get-environment-info'),

        // API methods
        guiVote: () => ipcRenderer.invoke('gui-vote'),
        getActiveChallenges: (token) => ipcRenderer.invoke('get-active-challenges', token),
        authenticate: (username, password, isMock) => ipcRenderer.invoke('authenticate', username, password, isMock),
        runVotingCycle: () => ipcRenderer.invoke('run-voting-cycle'),
        voteOnChallenge: (challengeId, challengeTitle) => ipcRenderer.invoke('vote-on-challenge', challengeId, challengeTitle),
        refreshApi: () => ipcRenderer.invoke('refresh-api'),

        // Logger methods
        logDebug: (message, data) => ipcRenderer.invoke('log-debug', message, data),
        logError: (message, data) => ipcRenderer.invoke('log-error', message, data),
        logApi: (message, data) => ipcRenderer.invoke('log-api', message, data),
        getLogFile: () => ipcRenderer.invoke('get-log-file'),
        getErrorLogFile: () => ipcRenderer.invoke('get-error-log-file'),
        getApiLogFile: () => ipcRenderer.invoke('get-api-log-file'),

        // Boost configuration methods
        getBoostThreshold: (challengeId) => ipcRenderer.invoke('get-boost-threshold', challengeId),
        setBoostThreshold: (challengeId, threshold) => ipcRenderer.invoke('set-boost-threshold', challengeId, threshold),
        setDefaultBoostThreshold: (threshold) => ipcRenderer.invoke('set-default-boost-threshold', threshold),

        // New schema-based settings methods
        getGlobalDefault: (settingKey) => ipcRenderer.invoke('get-global-default', settingKey),
        setGlobalDefault: (settingKey, value) => ipcRenderer.invoke('set-global-default', settingKey, value),
        getChallengeOverride: (settingKey, challengeId) => ipcRenderer.invoke('get-challenge-override', settingKey, challengeId),
        setChallengeOverride: (settingKey, challengeId, value) => ipcRenderer.invoke('set-challenge-override', settingKey, challengeId, value),
        setChallengeOverrides: (challengeId, overrides) => ipcRenderer.invoke('set-challenge-overrides', challengeId, overrides),
        removeChallengeOverride: (settingKey, challengeId) => ipcRenderer.invoke('remove-challenge-override', settingKey, challengeId),
        getEffectiveSetting: (settingKey, challengeId) => ipcRenderer.invoke('get-effective-setting', settingKey, challengeId),
        cleanupStaleChallengeSetting: (activeChallengeIds) => ipcRenderer.invoke('cleanup-stale-challenge-setting', activeChallengeIds),
        cleanupStaleMetadata: (activeChallengeIds) => ipcRenderer.invoke('cleanup-stale-metadata', activeChallengeIds),
        cleanupObsoleteSettings: () => ipcRenderer.invoke('cleanup-obsolete-settings'),
        getSettingsSchema: () => ipcRenderer.invoke('get-settings-schema'),

        // Reset methods
        resetSetting: (key) => ipcRenderer.invoke('reset-setting', key),
        resetGlobalDefault: (settingKey) => ipcRenderer.invoke('reset-global-default', settingKey),
        resetAllGlobalDefaults: () => ipcRenderer.invoke('reset-all-global-defaults'),
        resetAllSettings: () => ipcRenderer.invoke('reset-all-settings'),
        isSettingModified: (key) => ipcRenderer.invoke('is-setting-modified', key),
        isGlobalDefaultModified: (settingKey) => ipcRenderer.invoke('is-global-default-modified', settingKey),

        // External URL methods
        openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

        // Voting control methods
        shouldCancelVoting: () => ipcRenderer.invoke('should-cancel-voting'),
        setCancelVoting: (shouldCancel) => ipcRenderer.invoke('set-cancel-voting', shouldCancel),

        // Boost methods
        applyBoostToEntry: (challengeId, imageId) => ipcRenderer.invoke('apply-boost-to-entry', challengeId, imageId),

        // Window methods
        reloadWindow: () => ipcRenderer.invoke('reload-window'),

        // Update checker methods
        checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
        skipUpdateVersion: () => ipcRenderer.invoke('skip-update-version'),
        clearSkipVersion: () => ipcRenderer.invoke('clear-skip-version'),
        onShowUpdateDialog: (callback) => ipcRenderer.on('show-update-dialog', (event, updateInfo) => callback(updateInfo)),

        // Optional: Add listeners for responses from main process
        // Example: on: (channel, callback) => ipcRenderer.on(channel, (event, ...args) => callback(...args))
    },
);