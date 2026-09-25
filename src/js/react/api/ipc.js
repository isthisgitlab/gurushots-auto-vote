/**
 * The renderer's one-shot calls and event subscriptions over the shell bridge
 * (`window.api`, generated from src/js/ipc/manifest.js by both the Electron
 * preload and the Capacitor bridge). Components, hooks and contexts import
 * this module as a namespace (`import * as ipc from '@/api/ipc'`) — or use the
 * query/action hooks beside it — and never touch `window.api` themselves.
 *
 * Every wrapper looks the bridge up at call time, not import time: the
 * Capacitor entry installs it after the bundle loads, and tests swap it per
 * case. The pass-throughs forward arguments and results unchanged — a handler
 * that resolves `false` still means "rejected", and a rejection or throw still
 * reaches the caller's catch. Only the `logRenderer*` helpers differ: they are
 * best-effort and never throw.
 */

/**
 * @param {string} method - bridge method name
 * @returns {(...args: any[]) => any}
 */
const forward =
    (method) =>
    (...args) =>
        window.api[method](...args);

/**
 * A bridge method a host may leave out: absent (or no bridge at all) resolves
 * to `undefined` instead of throwing.
 *
 * @param {string} method - bridge method name
 * @returns {(...args: any[]) => any}
 */
const forwardOptional =
    (method) =>
    (...args) =>
        window.api?.[method]?.(...args);

const ignore = () => {};

/**
 * Fire-and-forget log line: tolerates a missing bridge or method and swallows
 * both a synchronous throw and a rejection, so a failing log sink can never
 * mask or replace the failure being logged.
 *
 * @param {string} method - bridge log method name
 * @param {string} message
 * @returns {Promise<void>}
 */
function logBestEffort(method, message) {
    try {
        return Promise.resolve(window.api?.[method]?.(message)).then(ignore, ignore);
    } catch {
        return Promise.resolve();
    }
}

/** @param {string} message @returns {Promise<void>} resolves once the line is handed off; never rejects */
export const logRendererError = (message) => logBestEffort('logError', message);
/** @param {string} message @returns {Promise<void>} resolves once the line is handed off; never rejects */
export const logRendererWarning = (message) => logBestEffort('logWarning', message);
/** @param {string} message @returns {Promise<void>} resolves once the line is handed off; never rejects */
export const logRendererDebug = (message) => logBestEffort('logDebug', message);

// Settings
export const getSettings = forward('getSettings');
export const getSetting = forward('getSetting');
export const setSetting = forward('setSetting');
export const getEffectiveSetting = forward('getEffectiveSetting');
export const getGlobalDefault = forward('getGlobalDefault');
export const setGlobalDefault = forward('setGlobalDefault');
export const getSettingsSchema = forward('getSettingsSchema');

// Per-challenge overrides, profiles and title rules
export const getChallengeOverride = forward('getChallengeOverride');
export const getChallengeOverrides = forward('getChallengeOverrides');
export const setChallengeOverride = forward('setChallengeOverride');
export const removeChallengeOverride = forward('removeChallengeOverride');
export const replaceChallengeOverrides = forward('replaceChallengeOverrides');
export const getTitleProfile = forward('getTitleProfile');
export const getChallengeProfiles = forward('getChallengeProfiles');
export const saveChallengeProfile = forward('saveChallengeProfile');
export const deleteChallengeProfile = forward('deleteChallengeProfile');
export const getTitleRules = forward('getTitleRules');
export const setTitleRules = forward('setTitleRules');

// User-defined scenarios
export const getScenarios = forward('getScenarios');
export const saveScenario = forward('saveScenario');
export const renameScenario = forward('renameScenario');
export const deleteScenario = forward('deleteScenario');
export const previewScenarioImport = forward('previewScenarioImport');
export const importScenario = forward('importScenario');
export const exportScenario = forward('exportScenario');
export const getScenarioStatus = forward('getScenarioStatus');
export const resetScenarioState = forward('resetScenarioState');
export const dryRunScenario = forward('dryRunScenario');
export const simulateScenario = forward('simulateScenario');

// Challenges and voting
export const getActiveChallenges = forward('getActiveChallenges');
export const getDeadlineActions = forward('getDeadlineActions');
export const joinChallenge = forward('joinChallenge');
export const runVotingCycle = forward('runVotingCycle');
export const runVotingCycleForChallenge = forward('runVotingCycleForChallenge');
export const voteOnChallengeManual = forward('voteOnChallengeManual');
export const voteAllChallengesManual = forward('voteAllChallengesManual');
export const setCancelVoting = forward('setCancelVoting');

// Session and shell
export const logout = forward('logout');
export const openExternalUrl = forward('openExternalUrl');
/** Rebuild the native app menu (Electron); `undefined` on a host without one. */
export const refreshMenu = forwardOptional('refreshMenu');

// App updates
export const canAutoUpdate = forward('canAutoUpdate');
export const getReleasesUrl = forward('getReleasesUrl');
export const downloadUpdate = forward('downloadUpdate');
export const installUpdate = forward('installUpdate');
export const skipUpdateVersion = forward('skipUpdateVersion');
export const onUpdateAvailable = forward('onUpdateAvailable');
export const onDownloadProgress = forward('onDownloadProgress');
export const onUpdateDownloaded = forward('onUpdateDownloaded');
export const onUpdateError = forward('onUpdateError');

// Live log stream
export const startLogStream = forward('startLogStream');
export const stopLogStream = forward('stopLogStream');
export const getLogBacklog = forward('getLogBacklog');
export const onLogMessage = forward('onLogMessage');

/**
 * Subscribe to settings-changed. Returns the unsubscribe function, or
 * `undefined` on a host without the event.
 */
export const onSettingsChanged = forwardOptional('onSettingsChanged');
