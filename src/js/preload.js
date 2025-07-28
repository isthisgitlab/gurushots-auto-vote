const { contextBridge, ipcRenderer } = require('electron');

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
    
        // Boost configuration methods
        getBoostThreshold: (challengeId) => ipcRenderer.invoke('get-boost-threshold', challengeId),
        setBoostThreshold: (challengeId, threshold) => ipcRenderer.invoke('set-boost-threshold', challengeId, threshold),
        setDefaultBoostThreshold: (threshold) => ipcRenderer.invoke('set-default-boost-threshold', threshold),
    
        // External URL methods
        openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
        
        // Voting control methods
        shouldCancelVoting: () => ipcRenderer.invoke('should-cancel-voting'),
        setCancelVoting: (shouldCancel) => ipcRenderer.invoke('set-cancel-voting', shouldCancel),
        
        // Boost methods
        applyBoostToEntry: (challengeId, imageId) => ipcRenderer.invoke('apply-boost-to-entry', challengeId, imageId),
    
    // Optional: Add listeners for responses from main process
    // Example: on: (channel, callback) => ipcRenderer.on(channel, (event, ...args) => callback(...args))
    },
);