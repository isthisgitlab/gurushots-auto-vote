/**
 * The import path of the settings persistence: what a load does when no
 * configuration is stored — the one-time import of `settings.json` through the
 * frozen pipeline in `../legacyImport.ts`, and the failure states it answers.
 */

import * as logger from '../../logger';
import { errorMessage } from '../../errorMessage';
import { getDefaultSettings } from '../defaults';
import { IMPORT_LOCK_WAIT_MS, importWhenAbsent } from '../legacyImport';
import type { ImportFailure } from '../legacyImport';
import { isImportMarked, markImportDone } from '../importMarker';
import { legacyStorage, storage } from '../storage';
import { underSettingsLock } from '../settingsLock';
import type { ConfigV2, ImportRef } from '../../types/config';
import { _blockWrites, _loadDefaults, _storesLoaded, _unblock } from './blocking';
import { _loadFromText } from './loadText';
import { _importIsPermanent } from './types';
import { state } from './state';

/**
 * What the persistence layer answers to a failed import: one the file itself cannot make up for (it is damaged, or the
 * frozen pipeline cannot convert it) is settled — the defaults are written with the failure in their import record and
 * the marker says the import is done, so no start tries it again; the file is left as it is, and the notice names the
 * reason. The defaults are written under the import lock, and only while nothing is stored (`writeIfAbsent`, like
 * every import-path write): a configuration another process stored meanwhile is loaded instead. Where the defaults
 * could not be written nothing is settled: the failure is treated as one that may pass, and the next start tries the
 * import again. The others block saves until the import is retried (Retry, or the next start).
 */
export const _importFailed = (failure: ImportFailure): ConfigV2 => {
    state.importFailure = failure;
    if (!_importIsPermanent(failure)) {
        return _blockWrites(
            'settings-import-failed',
            `settings.json could not be imported (${failure.reason}): ${failure.detail}`,
            legacyStorage.location(),
        );
    }
    const failureSaid = `settings.json could not be imported (${failure.reason}): ${failure.detail}`;
    const imported = {
        at: new Date().toISOString(),
        report: { refsBlocked: [] as ImportRef[] },
        acknowledged: true,
        failure: { reason: failure.reason, detail: failure.detail },
    };
    const unwrittenDefaults = () =>
        _blockWrites(
            'settings-import-failed',
            `settings.json could not be imported (${failure.reason}): ${failure.detail}, and the default settings could not be saved`,
            legacyStorage.location(),
        );
    let written: ReturnType<typeof storage.writeIfAbsent> | 'busy';
    try {
        written = underSettingsLock<ReturnType<typeof storage.writeIfAbsent> | 'busy'>(
            IMPORT_LOCK_WAIT_MS,
            () => storage.writeIfAbsent(JSON.stringify({ ...getDefaultSettings(), imported, version: 2 }, null, 2)),
            'busy',
        );
    } catch (error) {
        logger.withCategory('settings').error('The default settings could not be saved:', error);
        written = { outcome: 'failed' };
    }
    if (written === 'busy' || written.outcome === 'failed') return unwrittenDefaults();
    if (written.outcome === 'exists') {
        // A configuration another process stored while this one saw the failure is the settings in use now: the
        // stored read clears the failure with it (no notice of this import stands).
        if (written.current) {
            logger
                .withCategory('settings')
                .error(
                    `${failureSaid}; the configuration another process stored meanwhile is in use, and the file is left as it is`,
                );
            return _loadFromText(written.current, true);
        }
        return unwrittenDefaults();
    }
    logger
        .withCategory('settings')
        .error(`${failureSaid}; the default settings were stored in its place and the file is left as it is`);
    // The marker is written once the defaults are stored: a write that did not land stored nothing, and the next
    // start tries the import again.
    if (written.landed) {
        void written.landed.then((outcome) => {
            if (outcome === 'failed') {
                logger
                    .withCategory('settings')
                    .error(
                        'The default settings could not be saved; the import of settings.json is tried again at the next start',
                    );
            } else {
                markImportDone();
            }
        });
    } else {
        markImportDone();
    }
    state.importPermanent = true;
    state.importSettled = true;
    state.lastBlockedLog = null;
    return _loadDefaults('Loaded default settings with keys');
};

/**
 * An import that looked done (its configuration shown by the cache) and then was not stored: the cache is back to what
 * is stored, so the next read finds no configuration, and until the import is retried nothing is saved. The window is
 * told — nothing else announces a block that comes after a read has answered.
 */
export const _importFailedLater = (failure: ImportFailure): void => {
    _importFailed(failure);
    if (state.recoveryListener) queueMicrotask(state.recoveryListener);
};

/**
 * What a load finds when there is no configuration: the import of `settings.json` the first time (once, on Retry or at
 * a start after a failure), and defaults from then on.
 */
export const _loadWithoutConfig = (): ConfigV2 => {
    // Stores not read yet (the Android window before it hydrates): nothing is wrong with the settings, they are just
    // not there to be read; the defaults answer, and the read is made again once they are.
    if (!_storesLoaded()) return getDefaultSettings();
    // A failure this process has seen stands until it is retried (Retry, or the next start): a read of a setting does
    // not try the import again.
    if (state.importFailure !== null) return _loadDefaults('Loaded default settings with keys');
    // Nothing to import: the marker says the import has run, or this process has settled it. Defaults, silently.
    // (A marker that cannot be looked at at all counts as done, as one that cannot be read does.)
    let marked: boolean;
    try {
        marked = isImportMarked();
    } catch (error) {
        logger
            .withCategory('settings')
            .error(
                `The import marker could not be looked at, so it counts as done: ${errorMessage(error) ?? 'unknown error'}`,
            );
        marked = true;
    }
    if (state.importSettled || marked) {
        state.importSettled = true;
        _unblock();
        return _loadDefaults('No settings file found, loaded default settings with keys');
    }
    const outcome = importWhenAbsent(_importFailedLater);
    if (!outcome.ok) return _importFailed(outcome);
    if (outcome.kind === 'imported' || outcome.kind === 'adopted') {
        return _loadFromText(outcome.text, outcome.landed === undefined);
    }
    // `fresh` (there is no settings.json) or `skipped` (a set-aside configuration says the import must not run
    // unasked): defaults, silently.
    state.importSettled = true;
    _unblock();
    return _loadDefaults('No settings file found, loaded default settings with keys');
};
