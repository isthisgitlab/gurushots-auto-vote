/**
 * The read path of the settings persistence: stored text parsed (types.ts), a
 * damaged file set aside, and the configuration filled and validated over the
 * defaults.
 */

import * as logger from '../../logger';
import { dropInvalidValues, mergeWithDefaults } from '../loadValidation';
import { storage } from '../storage';
import { oneLine } from '../../format/logSafe';
import type { ConfigV2 } from '../../types/config';
import { _blockWrites, _loadDefaults, _unblock } from './blocking';
import { _parseSettings } from './types';
import { state } from './state';

/**
 * Configuration text that does not parse is set aside once (see storage.quarantineRaw), and the defaults apply, so the
 * next save writes a new file instead of mixing into a broken one. When it cannot be set aside it is left alone and
 * saves are refused. The block is lifted when the move is known to have landed — at once where it is made in one step,
 * when the queued one (the Android app window) has.
 */
export const _recoverCorrupt = (raw: string, reason: string): ConfigV2 => {
    if (raw === state.lastQuarantinedRaw) {
        return _loadDefaults('Loaded default settings with keys');
    }
    const moved = storage.quarantineRaw(raw);
    if (!moved.ok) {
        return _blockWrites(
            'settings-unreadable',
            `the unusable settings (${reason}) could not be set aside: ${moved.error}`,
            storage.location(),
        );
    }
    state.lastQuarantinedRaw = raw;
    state.corruptBackupPath = moved.path;
    logger
        .withCategory('settings')
        .error(`The stored settings were unusable (${reason}); they were moved to ${moved.path}`);
    if (moved.moved) {
        void moved.moved.then((made) => {
            if (made) {
                _unblock();
            } else {
                // The damaged text is still what is stored: the next read tries the move again.
                state.lastQuarantinedRaw = null;
                state.corruptBackupPath = null;
                _blockWrites(
                    'settings-unreadable',
                    'the unusable settings could not be set aside: Preferences refused the copy',
                    storage.location(),
                );
                // (A block set after a read answered is told on its own: _blockWrites does not announce.)
                if (state.recoveryListener) queueMicrotask(state.recoveryListener);
            }
        });
    } else {
        _unblock();
    }
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * Fill and validate the parsed configuration.
 */
export const _interpretSettings = (settingsData: string, parsed: object, stored: boolean): ConfigV2 => {
    const config = mergeWithDefaults(parsed);
    if (settingsData !== state.lastCleanRaw) {
        const dropped = dropInvalidValues(config);
        const warning = `Ignoring stored settings that are not valid (defaults apply): ${oneLine(dropped.join(', ')).slice(0, 500)}`;
        if (dropped.length === 0) {
            state.lastCleanRaw = settingsData;
        } else if (warning !== state.lastWarning) {
            state.lastWarning = warning;
            logger.withCategory('settings').warning(warning);
        }
    }
    // A configuration only shown by the cache until its queued write lands (an import in the Android window) is no proof
    // that anything works: the block stands until it is stored, and so does a failure the defaults were stored for —
    // they carry the failure in their import record, and the notice says so until the user acts or the process ends.
    if (stored) {
        _unblock();
        if (!state.importPermanent) {
            state.importFailure = null;
            state.lastBlockedLog = null;
        }
    }
    return config;
};

/**
 * The configuration a stored text holds: parsed, filled and validated, or defaults (the damaged text set aside).
 */
export const _loadFromText = (settingsData: string, stored: boolean): ConfigV2 => {
    const parsed = _parseSettings(settingsData);
    if (!parsed.ok) return _recoverCorrupt(settingsData, parsed.reason);
    return _interpretSettings(settingsData, parsed.value, stored);
};
