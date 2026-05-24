/**
 * Jest setup for React tests
 * Mocks browser globals and window.api
 */

// Mock window.api for IPC calls
const mockApi = {
    // Settings
    getSettings: jest.fn().mockResolvedValue({}),
    getSetting: jest.fn().mockResolvedValue(null),
    setSetting: jest.fn().mockResolvedValue(undefined),
    saveSettings: jest.fn().mockResolvedValue(undefined),
    getEnvironmentInfo: jest.fn().mockResolvedValue({
        nodeEnv: 'test',
        dev: true,
        prod: false,
        defaultMock: false,
        platform: 'darwin',
    }),
    // Match the real IPC shape — { schema, defaults }. Returning a bare
    // `{}` makes hooks that destructure `{ schema }` early-return, which
    // silently masks any reload path under test.
    getSettingsSchema: jest.fn().mockResolvedValue({ schema: {}, defaults: {} }),

    // Authentication
    authenticate: jest.fn().mockResolvedValue({ success: true }),
    login: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),

    // Challenges
    getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [] }),

    // Voting
    runVotingCycle: jest.fn().mockResolvedValue({ success: true }),
    runVotingCycleForChallenge: jest.fn().mockResolvedValue({ success: true }),
    voteOnChallenge: jest.fn().mockResolvedValue({ success: true }),
    voteOnChallengeManual: jest.fn().mockResolvedValue({ success: true }),
    voteAllChallengesManual: jest.fn().mockResolvedValue({ success: true }),
    shouldCancelVoting: jest.fn().mockResolvedValue(false),
    setCancelVoting: jest.fn().mockResolvedValue(undefined),

    // Boost — preload exposes both names; hooks call applyBoost.
    applyBoost: jest.fn().mockResolvedValue({ success: true }),
    applyBoostToEntry: jest.fn().mockResolvedValue({ success: true }),
    getBoostThreshold: jest.fn().mockResolvedValue(30),

    // Turbo
    applyTurbo: jest.fn().mockResolvedValue({ success: true }),
    playAutoTurbo: jest.fn().mockResolvedValue({ success: true }),

    // Auto-fill
    fillChallengeNow: jest.fn().mockResolvedValue({ success: true, submitted: 0, skipped: 0 }),

    // Per-challenge overrides
    getChallengeOverride: jest.fn().mockResolvedValue(null),
    setChallengeOverride: jest.fn().mockResolvedValue(true),
    removeChallengeOverride: jest.fn().mockResolvedValue(true),
    cleanupStaleChallengeSetting: jest.fn().mockResolvedValue(true),
    cleanupStaleMetadata: jest.fn().mockResolvedValue(true),

    // Logging
    logDebug: jest.fn().mockResolvedValue(undefined),
    logError: jest.fn().mockResolvedValue(undefined),
    logWarning: jest.fn().mockResolvedValue(undefined),
    logApi: jest.fn().mockResolvedValue(undefined),

    // Log stream
    startLogStream: jest.fn().mockResolvedValue({ success: true }),
    stopLogStream: jest.fn().mockResolvedValue(undefined),
    onLogMessage: jest.fn(),
    getLogBacklog: jest.fn().mockResolvedValue([]),

    // Update
    checkForUpdates: jest.fn().mockResolvedValue(undefined),
    downloadUpdate: jest.fn().mockResolvedValue(undefined),
    installUpdate: jest.fn().mockResolvedValue(undefined),
    skipUpdateVersion: jest.fn().mockResolvedValue(undefined),
    canAutoUpdate: jest.fn().mockResolvedValue(true),
    getReleasesUrl: jest.fn().mockResolvedValue('https://github.com/releases'),
    onUpdateAvailable: jest.fn(),
    onDownloadProgress: jest.fn(),
    onUpdateDownloaded: jest.fn(),
    onUpdateError: jest.fn(),

    // Menu
    refreshMenu: jest.fn().mockResolvedValue(undefined),

    // External
    openExternalUrl: jest.fn().mockResolvedValue(undefined),

    // Window
    reloadWindow: jest.fn().mockResolvedValue(undefined),

    // Settings events
    onSettingsChanged: jest.fn(),

    // Effective settings
    getEffectiveSetting: jest.fn().mockResolvedValue(null),
    getGlobalDefault: jest.fn().mockResolvedValue(null),
    setGlobalDefault: jest.fn().mockResolvedValue(undefined),
};

// Mock window.translationManager
const mockTranslationManager = {
    initialized: true,
    t: jest.fn((key) => key), // Return key as translation for testing
    getCurrentLanguage: jest.fn().mockReturnValue('en'),
    setLanguage: jest.fn().mockResolvedValue(true),
    getAvailableLanguages: jest.fn().mockReturnValue(['en', 'lv']),
};

// Set up global mocks. Augment the test-env window in place rather than
// replacing it with a plain object — spreading `{...window}` only copies
// own-enumerable props and drops prototype methods like dispatchEvent /
// addEventListener (happy-dom defines them on the prototype). Object.assign
// keeps the real DOM surface intact while attaching the IPC mocks.
Object.assign(global.window, {
    api: mockApi,
    translationManager: mockTranslationManager,
});

// Reset all mocks before each test
beforeEach(() => {
    jest.clearAllMocks();
});

// Export mocks for use in tests
module.exports = {
    mockApi,
    mockTranslationManager,
};
