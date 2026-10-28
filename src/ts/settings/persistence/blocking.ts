/**
 * The blocking writers of the settings persistence: the fail-closed state that
 * refuses saves while the stored settings cannot be used, the defaults loader
 * it answers with, the unblock, and the loaded-stores check.
 */

import * as logger from '../../logger';
import { getDefaultSettings } from '../defaults';
import { legacyStorage, storage } from '../storage';
import type { ConfigV2 } from '../../types/config';
import { state } from './state';

/**
 * Default configuration for a missing or unreadable file, logging which case applied.
 */
export const _loadDefaults = (message: string): ConfigV2 => {
    const defaultSettings = getDefaultSettings();
    logger.withCategory('settings').info(`${message}: ${Object.keys(defaultSettings.app).join(', ')}`);
    return defaultSettings;
};

/**
 * A configuration that cannot be used and must not be overwritten: defaults apply for reads, saves are refused until a
 * load gets through, and getSettingsRecovery says why.
 */
export const _blockWrites = (
    code: 'settings-unreadable' | 'settings-import-failed',
    detail: string,
    path: string,
): ConfigV2 => {
    state.blocked = { code, path, blocking: true };
    const message = `Settings cannot be used (${code}); saving is refused so the stored settings are not overwritten: ${detail}`;
    if (message !== state.lastBlockedLog) logger.withCategory('settings').error(message);
    state.lastBlockedLog = message;
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * Clears the block a read had put up (see _blockWrites), and tells the listener, so that a window that was showing the
 * notice for it asks again (and finds it gone).
 */
export const _unblock = () => {
    if (state.blocked === null) return;
    state.blocked = null;
    // Not inside the read that cleared it: the listener reads the settings itself.
    if (state.recoveryListener) queueMicrotask(state.recoveryListener);
};

/**
 * Clears the block without telling the listener: a recovery action has just left a configuration stored and in use,
 * and the next read answers getSettingsRecovery from what is stored then.
 */
export const clearBlocked = (): void => {
    state.blocked = null;
};

/**
 * Whether what a read of the stored settings answers is what is stored (false in the Android window before it
 * hydrates, and in the service while no bridge answers).
 */
export const _storesLoaded = (): boolean => storage.isLoaded() && legacyStorage.isLoaded();
