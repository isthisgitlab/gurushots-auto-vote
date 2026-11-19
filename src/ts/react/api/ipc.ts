/**
 * The renderer's one-shot calls and event subscriptions over the shell bridge
 * (`window.api`, generated from src/ts/core/ipc/manifest.ts by both the Electron
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

import { isPlainObject } from '../../core/plainObject';

import type { WindowApi } from '../../core/types/ipc';
import type { FenceFailure, StopFencePort, WithdrawalOutcome } from '../../core/autovote/runGate';
import type { AccountWakeSources } from '../../core/scheduling/thresholdWindow';
import type { StopFenceRead } from '../../core/settings';

/**
 * The bridge seen as untyped callables, for the pass-throughs below that only
 * forward arguments and results (their public signatures come from WindowApi).
 */
type BridgeCalls<M extends PropertyKey> = Record<M, (...args: unknown[]) => unknown>;

/**
 * @param method - bridge method name
 */
const forward = <M extends keyof WindowApi>(method: M): WindowApi[M] =>
    ((...args: unknown[]) => (window.api as BridgeCalls<M>)[method](...args)) as WindowApi[M];

/**
 * A bridge method a host may leave out: absent (or no bridge at all) resolves
 * to `undefined` instead of throwing.
 *
 * @param method - bridge method name
 */
const forwardOptional =
    <M extends keyof WindowApi>(
        method: M,
    ): ((...args: Parameters<WindowApi[M]>) => ReturnType<WindowApi[M]> | undefined) =>
    (...args) =>
        (window.api as Partial<BridgeCalls<M>> | undefined)?.[method]?.(...args) as
            | ReturnType<WindowApi[M]>
            | undefined;

/** The deliberate no-op for a log write's outcome: a failing log sink must stay silent. */
const dropLogOutcome = (): void => undefined;

/**
 * Fire-and-forget log line: tolerates a missing bridge or method and swallows
 * both a synchronous throw and a rejection, so a failing log sink can never
 * mask or replace the failure being logged.
 *
 * @param method - bridge log method name
 */
function logBestEffort(
    method: 'logError' | 'logWarning' | 'logDebug' | 'logRemoteInfo',
    message: string,
): Promise<void> {
    try {
        // The renderer sends the message only; the handler's `data` is optional at runtime.
        const api = window.api as Partial<BridgeCalls<typeof method>> | undefined;
        return Promise.resolve(api?.[method]?.(message)).then(dropLogOutcome, dropLogOutcome);
    } catch {
        return Promise.resolve();
    }
}

/**
 * Run a bridge call and turn a throw or rejection into `null`, so a caller
 * that branches on `result?.success` takes its failure path instead of
 * leaking an unhandled rejection. Takes a thunk so a missing bridge (a
 * synchronous throw) is caught too.
 */
export const callOrNull = async <T>(call: () => T | Promise<T>): Promise<T | null> => {
    try {
        return await call();
    } catch {
        return null;
    }
};

/** @returns resolves once the line is handed off; never rejects */
export const logRendererError = (message: string): Promise<void> => logBestEffort('logError', message);
/** @returns resolves once the line is handed off; never rejects */
export const logRendererWarning = (message: string): Promise<void> => logBestEffort('logWarning', message);
/** @returns resolves once the line is handed off; never rejects */
export const logRendererDebug = (message: string): Promise<void> => logBestEffort('logDebug', message);
/** The remote-access host's INFO line (the desktop's `log-debug` is silent in a packaged build). @returns resolves once the line is handed off; never rejects */
export const logRemoteInfo = (message: string): Promise<void> => logBestEffort('logRemoteInfo', message);

// Settings
export const getSettings = forward('getSettings');
export const getSetting = forward('getSetting');
export const setSetting = forward('setSetting');
export const getEffectiveSetting = forward('getEffectiveSetting');
export const getGlobalDefault = forward('getGlobalDefault');
export const setGlobalDefault = forward('setGlobalDefault');
export const getSettingsSchema = forward('getSettingsSchema');
export const getEnvironmentInfo = forward('getEnvironmentInfo');
export const getSettingsRecovery = forward('getSettingsRecovery');
export const retrySettingsImport = forward('retrySettingsImport');
export const startFreshSettings = forward('startFreshSettings');
export const getImportReport = forward('getImportReport');
export const acknowledgeImportReport = forward('acknowledgeImportReport');

// This device's data and bundled notices
export const getThirdPartyNotices = forward('getThirdPartyNotices');
export const wipeLocalData = forward('wipeLocalData');
export const reloadWindow = forward('reloadWindow');

// Per-challenge overrides, profiles and title rules
export const getChallengeOverride = forward('getChallengeOverride');
export const getChallengeOverrides = forward('getChallengeOverrides');
export const setChallengeOverride = forward('setChallengeOverride');
export const removeChallengeOverride = forward('removeChallengeOverride');
export const replaceChallengeOverrides = forward('replaceChallengeOverrides');
export const getTitleProfile = forward('getTitleProfile');
export const getEntryPins = forward('getEntryPins');
export const setEntryPin = forward('setEntryPin');
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
export const resetAllScenarioState = forward('resetAllScenarioState');
export const dryRunScenario = forward('dryRunScenario');
export const simulateScenario = forward('simulateScenario');
export const getScenarioRequestStatus = forward('getScenarioRequestStatus');

// The capability catalogue, the per-subject snapshot, and the lifecycle of an assignment: reads first, then the
// effects (each answers {success, error} and, while the Android service owns scenarios, may answer pending).
export const getScenarioCapabilities = forward('getScenarioCapabilities');
export const getScenarioSnapshot = forward('getScenarioSnapshot');
export const getInstallationScenario = forward('getInstallationScenario');
export const setInstallationScenario = forward('setInstallationScenario');
export const transferInstallationScenarioOwner = forward('transferInstallationScenarioOwner');
export const pauseScenario = forward('pauseScenario');
export const resumeScenario = forward('resumeScenario');
export const handoffScenario = forward('handoffScenario');
export const clearScenarioAssignment = forward('clearScenarioAssignment');
export const getPhotoPools = forward('getPhotoPools');
export const setPhotoPool = forward('setPhotoPool');
export const createPhotoPool = forward('createPhotoPool');
export const getPhaseProfiles = forward('getPhaseProfiles');
export const deletePhotoPool = forward('deletePhotoPool');
export const renamePhotoPool = forward('renamePhotoPool');
export const getEffectiveEntryPins = forward('getEffectiveEntryPins');
export const listSimulationSubjects = forward('listSimulationSubjects');

// What applies to the installation now, for a client that mounted or missed an event (useEffectiveSettings.ts).
export const getEffectiveInstallationSettings = forward('getEffectiveInstallationSettings');
export const getEffectivePresentation = forward('getEffectivePresentation');

// The window controller's routes to the host: the priority Stop fence, the withdrawal and the lifting of the installation's
// publication, and the account's scheduling boundaries (autovote/controller.ts takes them as host seams).
const scenarioStopFence = forward('scenarioStopFence');
const recordFullStop = forward('recordFullStop');
const armAutovote = forward('armAutovote');
const armIfAllowed = forward('armIfAllowed');
const withdrawInstallation = forward('withdrawInstallation');
const rearmInstallation = forward('rearmInstallation');
const getAccountWake = forward('getAccountWake');

type Failed = { success: false; error: string } | null;

/** Why a fence route failed, in the words the gate knows: a route that failed to answer is a Stop that was not saved. */
const fenceFailure = (result: Failed): FenceFailure =>
    result?.error === 'unreadable' || result?.error === 'oversize' ? result.error : 'not-saved';

const FENCE_UNREADABLE: StopFenceRead = { state: 'unreadable', reason: 'read-failed' };

/**
 * The priority Stop fence as the controller uses it, through the host's routes (the fence is the main process's: the window
 * reaches it by IPC). Each member only forwards the call and words the answer; a route that cannot be reached answers the
 * failure the gate already handles (an unreadable fence, a Stop not saved). `clearStopBlock` goes through `arm-autovote`, the one
 * route that lifts a block; every other member goes through routes that cannot.
 */
export const createStopFencePort = (): StopFencePort => ({
    read: async () => {
        const result = await callOrNull(() => scenarioStopFence());
        return result?.success ? result.fence : FENCE_UNREADABLE;
    },
    initialize: async () => {
        const result = await callOrNull(() => scenarioStopFence({ initialize: true }));
        return result?.success
            ? { ok: true, created: result.created === true }
            : { ok: false, reason: fenceFailure(result) };
    },
    recordFullStop: async (requestId, at) => {
        const result = await callOrNull(() => recordFullStop(requestId, at));
        return result?.success ? { ok: true, epoch: result.epoch } : { ok: false, reason: fenceFailure(result) };
    },
    clearStopBlock: async (expectedEpoch) => {
        const result = await callOrNull(() => armAutovote(expectedEpoch));
        if (result?.success) return { ok: true };
        return {
            ok: false,
            reason:
                result?.error === 'stale-epoch' || result?.error === 'missing' ? result.error : fenceFailure(result),
        };
    },
    isArmAllowed: async (capturedEpoch) => {
        const result = await callOrNull(() => scenarioStopFence({ armEpoch: capturedEpoch }));
        return result?.success === true && result.armAllowed === true;
    },
    armIfAllowed: async (capturedEpoch) => {
        const result = await callOrNull(() => armIfAllowed(capturedEpoch));
        if (result?.success) return { ok: true };
        const reason = result?.error;
        return {
            ok: false,
            reason:
                reason === 'stale-epoch' || reason === 'blocked' || reason === 'missing'
                    ? reason
                    : fenceFailure(result),
        };
    },
});

/** A full Stop's withdrawal of the installation's publication, under the epoch it is made under; `failed` when it did not land. */
export const withdrawInstallationOnHost = async (epoch: number): Promise<Exclude<WithdrawalOutcome, 'no-route'>> => {
    const result = await callOrNull(() => withdrawInstallation(epoch));
    return result?.success ? result.outcome : 'failed';
};

/** The explicit re-arm's lifting of that withdrawal; `failed` when it still stands. */
export const rearmInstallationOnHost = async (): Promise<'restored' | 'none' | 'failed'> => {
    const result = await callOrNull(() => rearmInstallation());
    return result?.success ? result.outcome : 'failed';
};

/** The account's own scheduling boundaries as the main process works them out; null when it cannot. */
export const getAccountWakeFromHost = async (): Promise<AccountWakeSources | null> => {
    const result = await callOrNull(() => getAccountWake());
    return result?.success ? result.wake : null;
};

/** One installation-only cycle (the installation scenario's publication and account rules; no voting stage runs). */
export const runArmedCycle = () => runVotingCycle('armed');

// Challenges and voting
export const getActiveChallenges = forward('getActiveChallenges');
export const getDeadlineActions = forward('getDeadlineActions');
export const joinChallenge = forward('joinChallenge');
export const forgetUnconfirmedPayment = forward('forgetUnconfirmedPayment');
export const getOpenChosenAnnotations = forward('getOpenChosenAnnotations');
export const getLibraryPhotos = forward('getLibraryPhotos');
export const getPhotoStats = forward('getPhotoStats');
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
export const onUpdateChecking = forward('onUpdateChecking');
export const onUpdateNotAvailable = forward('onUpdateNotAvailable');
export const onDownloadProgress = forward('onDownloadProgress');
export const onUpdateDownloaded = forward('onUpdateDownloaded');
export const onUpdateError = forward('onUpdateError');

// Live log stream
export const startLogStream = forward('startLogStream');
export const stopLogStream = forward('stopLogStream');
export const getLogBacklog = forward('getLogBacklog');
export const onLogMessage = forward('onLogMessage');

// Remote access pairing (the desktop app is what gets paired to)
export const getRemoteAccess = forward('getRemoteAccess');
export const setRemoteAccess = forward('setRemoteAccess');
export const resetRemotePairing = forward('resetRemotePairing');

/**
 * Subscribe to settings-changed. Returns the unsubscribe function, or
 * `undefined` on a host without the event.
 */
export const onSettingsChanged = forwardOptional('onSettingsChanged');
export const onEffectiveSettingsChanged = forwardOptional('onEffectiveSettingsChanged');
export const onEffectivePresentationChanged = forwardOptional('onEffectivePresentationChanged');

/**
 * A change whose result the client does not have yet: `unclear` (the reply was lost, so the computer may or may not have made
 * it), `queued` (an Android request the background service has not applied yet) or `waiting` (a status check found it still
 * pending). `requestId` is what the status is asked by (null: the answer carried none, so it cannot be asked). `checked` is what
 * the last status check found, when one ran.
 */
export type EffectOutcome = {
    kind: 'unclear' | 'queued' | 'waiting';
    requestId: string | null;
    checked: 'not-recorded' | 'unreadable' | null;
};

/**
 * The outcome a result stands at when it is not final: a lost reply that carries the request's identity, or an accepted request
 * the background service has not applied. Anything else (a final success or failure, and a lost reply with no identity, which is
 * the spend channels' own unclear answer) is null.
 */
export const effectOutcomeOf = (result: unknown): EffectOutcome | null => {
    if (!isPlainObject(result)) return null;
    const { requestId } = result;
    if (typeof requestId !== 'string') return null;
    if (result.success === false && result.unclear === true) return { kind: 'unclear', requestId, checked: null };
    if (result.success === true && result.pending === true) return { kind: 'queued', requestId, checked: null };
    return null;
};

/** What a status check came to: the request reached a final result (applied, or failed with its reason), or it is still open. */
export type EffectStatus =
    | { settled: true; applied: true }
    | { settled: true; applied: false; error: string }
    | { settled: false; outcome: EffectOutcome };

/**
 * Asks the host where an effect stands, by its request identity. Only a recorded final result settles it: a status that cannot
 * be read, a request the host has no record of, and one still pending all leave the outcome open with its identity kept. It
 * never sends the change again.
 */
export const checkEffectStatus = async (outcome: EffectOutcome): Promise<EffectStatus> => {
    if (outcome.requestId === null) return { settled: false, outcome };
    const answer = await callOrNull(() => getScenarioRequestStatus({ requestId: outcome.requestId as string }));
    if (!answer?.success || answer.state === 'unknown' || answer.state === 'target') {
        return { settled: false, outcome: { ...outcome, checked: 'unreadable' } };
    }
    if (answer.state === 'not-recorded') return { settled: false, outcome: { ...outcome, checked: 'not-recorded' } };
    const { status, error } = answer.record;
    if (status === 'pending') {
        return {
            settled: false,
            outcome: { ...outcome, kind: outcome.kind === 'queued' ? 'queued' : 'waiting', checked: null },
        };
    }
    return status === 'applied'
        ? { settled: true as const, applied: true as const }
        : { settled: true as const, applied: false as const, error: error ?? status };
};
