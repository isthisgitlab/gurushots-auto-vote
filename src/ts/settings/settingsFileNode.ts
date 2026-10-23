/**
 * The Node half of `createSettingsFile` (storage.ts): the fs branches of a settings file's methods, for the
 * Electron/CLI transport where the configuration is a plain file beside the user-data directory. The helpers take the
 * file path and touch only what they are given; every writer keeps going through `writeAtomicOwnerOnly`, which keeps
 * the file owner-only. Nothing here imports storage.ts, so a test's `jest.mock('settings/storage')` still rules over
 * every caller.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { errorMessage } from '../errorMessage';
import { writeAtomicOwnerOnly } from './atomicWrite';

import type { QuarantineResult, WriteIfAbsentResult } from './storageTypes';

/**
 * Whether an unusable copy of the file was set aside earlier: a `<file>.corrupt-<time>` entry beside it. The read
 * failure case (`catch`) answers "no" — a directory that cannot be searched is not evidence of a copy.
 */
export const hasQuarantinedOnDisk = (filePath: () => string): boolean => {
    try {
        const prefix = `${path.basename(filePath())}.corrupt-`;
        return fs.readdirSync(path.dirname(filePath())).some((name) => name.startsWith(prefix));
    } catch {
        return false;
    }
};

/**
 * Renames the unusable file out of the way, so the next save does not overwrite it; the caller built `backupPath`
 * (`<file>.corrupt-<time>`, the time part of the name). Answers where it went, or why it did not.
 */
export const renameToCorruptBackup = (file: string, backupPath: string): QuarantineResult => {
    try {
        fs.renameSync(file, backupPath);
        return { ok: true, path: backupPath };
    } catch (err) {
        return { ok: false, error: errorMessage(err) ?? 'unknown error' };
    }
};

/**
 * Saves the raw JSON only if nothing is stored yet (the import write: the caller holds the import lock, so what it
 * found missing is still missing); otherwise answers the text that is already there.
 */
export const writeIfAbsentOnDisk = (file: string, data: string): WriteIfAbsentResult => {
    if (fs.existsSync(file)) return { outcome: 'exists', current: fs.readFileSync(file, 'utf8') };
    writeAtomicOwnerOnly(file, data);
    return { outcome: 'saved' };
};
