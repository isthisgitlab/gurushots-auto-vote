/**
 * Types and the pure helpers of the settings persistence: the recovery states
 * a caller can be told of, the stored-text parse, and the value checks that
 * touch no module state and no storage adapter.
 */

import { isPlainObject } from '../../plainObject';
import { appValueAllowed, authValueAllowed, isAuthKey, isPrototypeKey } from '../loadValidation';
import type { ImportFailure } from '../legacyImport';
import type { ConfigV2 } from '../../types/config';

/**
 * Why the stored configuration is not in use, or what a start found worth telling, for a renderer or the CLI to tell
 * the user. `code` is stable; `blocking` says whether saves are refused while it stands (a notice only informs):
 *   - settings-unreadable (blocking): `config.json` cannot be read, or cannot be set aside; `path` is the configuration
 *     file. Saves are refused until it can be read. Every read tries again.
 *   - settings-corrupt (notice): `config.json` is not a parseable configuration; it sits at `path`, set aside, and the
 *     defaults apply. Saves work, and the state stays this one for the process, however often it is read.
 *   - settings-import-failed: there is no `config.json` and the `settings.json` at `path` could not be imported.
 *     Blocking while the failure may pass by itself (the file held by another program, a read or a write that failed
 *     once): nothing was overwritten, and the import is tried again on Retry and at the next start, never on each
 *     setting read. Non-blocking (`detail` names the reason) when the file itself cannot be imported: the defaults
 *     were stored in its place, the marker says the import is done, and the file is left as it is.
 */
export type SettingsRecovery = {
    code: 'settings-unreadable' | 'settings-corrupt' | 'settings-import-failed';
    path: string;
    blocking: boolean;
    detail?: string;
};

/**
 * Whether a failed import says the file itself cannot be imported (damaged, or the frozen pipeline cannot convert it),
 * rather than that it could not be tried just now (a lock another process held, a read that failed, a write that did
 * not land).
 */
export const _importIsPermanent = (failure: ImportFailure): boolean =>
    failure.reason === 'corrupt' || failure.reason === 'migration-failed';

/**
 * Parse the stored text as a configuration object; the reason it is not one otherwise.
 */
export const _parseSettings = (raw: string): { ok: true; value: object } | { ok: false; reason: string } => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // The parser's message can quote the text (the token among it): only the class of the failure is reported.
        return { ok: false, reason: 'it is not valid JSON' };
    }
    return isPlainObject(parsed) ? { ok: true, value: parsed } : { ok: false, reason: 'its root is not an object' };
};

/**
 * The key of the first value in a partial configuration that may not be saved: an `app` key that names an
 * Object.prototype member, or an `app` or `auth` value its schema entry or range rejects.
 */
export const _refusedKey = (settings: Partial<ConfigV2>): string | undefined => {
    const { app, auth } = settings;
    const appKey = app && Object.keys(app).find((key) => isPrototypeKey(key) || !appValueAllowed(key, app[key]));
    if (appKey !== undefined) return appKey;
    return auth && Object.keys(auth).find((key) => !isAuthKey(key) || !authValueAllowed(key, auth[key]));
};
