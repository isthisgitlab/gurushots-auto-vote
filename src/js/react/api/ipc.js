/**
 * The renderer's one-shot calls and event subscriptions over the shell bridge
 * (`window.api`, generated from src/js/ipc/manifest.ts by both the Electron
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

/** @import { WindowApi } from '../../types/ipc' */

/**
 * The bridge seen as untyped callables, for the pass-throughs below that only
 * forward arguments and results (their public signatures come from WindowApi).
 *
 * @template {PropertyKey} M
 * @typedef {Record<M, (...args: unknown[]) => unknown>} BridgeCalls
 */

/**
 * @template {keyof WindowApi} M
 * @param {M} method - bridge method name
 * @returns {WindowApi[M]}
 */
const forward = (method) =>
    /** @type {WindowApi[M]} */ (
        /** @type {unknown} */ (
            (/** @type {unknown[]} */ ...args) => /** @type {BridgeCalls<M>} */ (window.api)[method](...args)
        )
    );

/**
 * A bridge method a host may leave out: absent (or no bridge at all) resolves
 * to `undefined` instead of throwing.
 *
 * @template {keyof WindowApi} M
 * @param {M} method - bridge method name
 * @returns {(...args: Parameters<WindowApi[M]>) => ReturnType<WindowApi[M]> | undefined}
 */
const forwardOptional = (method) =>
    /** @type {(...args: Parameters<WindowApi[M]>) => ReturnType<WindowApi[M]> | undefined} */ (
        /** @type {unknown} */ (
            (/** @type {unknown[]} */ ...args) =>
                /** @type {Partial<BridgeCalls<M>> | undefined} */ (window.api)?.[method]?.(...args)
        )
    );

const ignore = () => {};

/**
 * Fire-and-forget log line: tolerates a missing bridge or method and swallows
 * both a synchronous throw and a rejection, so a failing log sink can never
 * mask or replace the failure being logged.
 *
 * @param {'logError' | 'logWarning' | 'logDebug'} method - bridge log method name
 * @param {string} message
 * @returns {Promise<void>}
 */
function logBestEffort(method, message) {
    try {
        // The renderer sends the message only; the handler's `data` is optional at runtime.
        const api = /** @type {Partial<BridgeCalls<typeof method>> | undefined} */ (window.api);
        return Promise.resolve(api?.[method]?.(message)).then(ignore, ignore);
    } catch {
        return Promise.resolve();
    }
}

/**
 * Run a bridge call and turn a throw or rejection into `null`, so a caller
 * that branches on `result?.success` takes its failure path instead of
 * leaking an unhandled rejection. Takes a thunk so a missing bridge (a
 * synchronous throw) is caught too.
 *
 * @template T
 * @param {() => T | Promise<T>} call
 * @returns {Promise<T | null>}
 */
export const callOrNull = async (call) => {
    try {
        return await call();
    } catch {
        return null;
    }
};

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
export const checkScenario = forward('checkScenario');
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
