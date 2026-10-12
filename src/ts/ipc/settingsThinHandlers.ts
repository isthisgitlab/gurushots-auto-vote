/**
 * The settings channels that just delegate to a settings facade method with a uniform try/catch shape, registered in
 * bulk from one table (see settings.handlers.ts for the rest of the settings channels).
 */

import * as settings from '../settings';
import type { IpcHandler } from './registerHandlers';
import { toRendererSettings } from './rendererSettings';
import * as logger from '../logger';
import { stampChosenPhotosOwner } from './chosenPhotosOwner';
import { isIdArg } from './isIdArg';
import { refuseInvalidArgs } from './actions/shared';

/**
 * A settings write listener: receives the settings to broadcast to every
 * renderer after a successful user-facing write.
 */
type BroadcastSettingsChange = (settings: object) => void;

// Where the challenge id sits in each thin channel's arguments, and whether the channel may be called without one.
// An id that is not a plain id (a non-blank string of bounded length, or a number) never reaches the settings.
const CHALLENGE_ID_ARGS: Record<string, { index: number; optional?: boolean }> = {
    'get-challenge-override': { index: 1 },
    'set-challenge-override': { index: 1 },
    'set-challenge-overrides': { index: 0 },
    'remove-challenge-override': { index: 1 },
    'get-effective-setting': { index: 1, optional: true },
    'get-challenge-overrides': { index: 0 },
    'replace-challenge-overrides': { index: 0 },
    'apply-challenge-profile': { index: 1 },
};

// Channels that just delegate to a settings facade method. Each row:
// [channel, lazy method lookup, fallback-on-error, verb-for-log]. The lookup
// runs per call, so the handler always reaches the facade's current method.
const thinRows = () =>
    [
        ['get-validation-error', () => settings.getValidationError, 'Validation error', 'getting validation error'],
        ['get-global-default', () => settings.getGlobalDefault, null, 'getting global default'],
        ['set-global-default', () => settings.setGlobalDefault, false, 'setting global default'],
        ['get-challenge-override', () => settings.getChallengeOverride, false, 'getting challenge override'],
        ['set-challenge-override', () => settings.setChallengeOverride, false, 'setting challenge override'],
        ['set-challenge-overrides', () => settings.setChallengeOverrides, false, 'setting challenge overrides'],
        ['remove-challenge-override', () => settings.removeChallengeOverride, false, 'removing challenge override'],
        ['get-effective-setting', () => settings.getEffectiveSetting, null, 'getting effective setting'],
        ['get-title-rules', () => settings.getTitleRules, null, 'getting title rules'],
        ['set-title-rules', () => settings.setTitleRules, false, 'setting title rules'],
        ['get-title-profile', () => settings.getTitleProfile, null, 'getting title profile'],
        ['get-challenge-overrides', () => settings.getChallengeOverrides, null, 'getting challenge overrides'],
        [
            'replace-challenge-overrides',
            () => settings.replaceChallengeOverrides,
            false,
            'replacing challenge overrides',
        ],
        ['get-challenge-profiles', () => settings.getChallengeProfiles, null, 'getting challenge profiles'],
        ['save-challenge-profile', () => settings.saveChallengeProfile, false, 'saving challenge profile'],
        ['delete-challenge-profile', () => settings.deleteChallengeProfile, false, 'deleting challenge profile'],
        ['apply-challenge-profile', () => settings.applyChallengeProfile, false, 'applying challenge profile'],
        ['cleanup-obsolete-settings', () => settings.cleanupObsoleteSettings, false, 'cleaning up obsolete settings'],
        ['reset-setting', () => settings.resetSetting, false, 'resetting setting'],
        ['reset-global-default', () => settings.resetGlobalDefault, false, 'resetting global default'],
        ['reset-all-global-defaults', () => settings.resetAllGlobalDefaults, false, 'resetting all global defaults'],
        ['reset-all-settings', () => settings.resetAllSettings, false, 'resetting all settings'],
        ['is-setting-modified', () => settings.isSettingModified, false, 'checking if setting is modified'],
        [
            'is-global-default-modified',
            () => settings.isGlobalDefaultModified,
            false,
            'checking if global default is modified',
        ],
    ] as const;

type ThinRow = ReturnType<typeof thinRows>[number];

/**
 * Each thin channel as a handler: the facade method's arguments, resolving to
 * its result or the row's fallback on error.
 */
type ThinHandlers = {
    [R in ThinRow as R[0]]: (
        event: unknown,
        ...args: Parameters<ReturnType<R[1]>>
    ) => Promise<ReturnType<ReturnType<R[1]>> | R[2]>;
};

// Capacitor has no filesystem watcher to rebroadcast settings mutations, and
// Electron's watcher reloads only the main window for reload-required keys.
// Notify every renderer subscriber after a successful user-facing write so
// cards immediately re-read effective global/profile/per-challenge values and
// every open window follows a saved language (set-setting broadcasts too).
const CHANGE_BROADCAST_CHANNELS = new Set([
    'set-global-default',
    'set-challenge-override',
    'set-challenge-overrides',
    'remove-challenge-override',
    'set-title-rules',
    'replace-challenge-overrides',
    'save-challenge-profile',
    'delete-challenge-profile',
    'apply-challenge-profile',
    'reset-setting',
    'reset-global-default',
    'reset-all-global-defaults',
    'reset-all-settings',
]);

// The writes that can carry a Chosen Photos list, after which the saving
// account is recorded (see chosenPhotosOwner.ts).
const CHOSEN_LIST_CHANNELS = new Set([
    'set-global-default',
    'set-challenge-override',
    'set-challenge-overrides',
    'replace-challenge-overrides',
    'set-title-rules',
    'save-challenge-profile',
]);

const buildThinHandlers = ({ broadcastSettingsChange }: { broadcastSettingsChange?: BroadcastSettingsChange }) => {
    const handlers: Record<string, IpcHandler> = {};
    thinRows().forEach(([channel, lookup, fallback, verb]) => {
        const idArg = Object.hasOwn(CHALLENGE_ID_ARGS, channel) ? CHALLENGE_ID_ARGS[channel] : null;
        handlers[channel] = async (event, ...args: unknown[]) => {
            if (idArg) {
                const id = args[idArg.index];
                if (!(idArg.optional && (id === undefined || id === null)) && !isIdArg(id)) {
                    refuseInvalidArgs('settings', channel);
                    // aislop-ignore-next-line ai-slop/hidden-fallback -- refused and logged by refuseInvalidArgs; the row's fallback is the channel contract
                    return fallback;
                }
            }
            try {
                const result = (lookup() as (...a: unknown[]) => unknown)(...args);
                if (result && CHOSEN_LIST_CHANNELS.has(channel)) stampChosenPhotosOwner(args);
                if (result && CHANGE_BROADCAST_CHANNELS.has(channel) && typeof broadcastSettingsChange === 'function') {
                    broadcastSettingsChange(toRendererSettings(settings.loadSettings()));
                }
                return result;
            } catch (error) {
                logger.withCategory('settings').error(`Error ${verb}:`, error);
                // aislop-ignore-next-line ai-slop/hidden-fallback -- logged via the settings logger; the row's fallback is the channel contract
                return fallback;
            }
        };
    });
    return handlers as ThinHandlers;
};

export { buildThinHandlers };
export type { BroadcastSettingsChange };
