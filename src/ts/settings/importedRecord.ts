/**
 * The record of the one-time 1.x import kept in `config.json` (`imported`): the hash of `settings.json` it was made from,
 * which a later start compares to see that the file changed since, and the report of what the import left unresolved.
 * The record is read and changed in the stored text itself, so everything else in the configuration stays as stored.
 */

import * as logger from '../logger';
import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { isImportedRecord } from './loadValidation';
import { storage } from './storage';

import type { ImportedV2 } from '../types/config';

// The sign-in state `settings.json` still holds after an import is blanked (see legacyImport.ts), so it is no part of
// what the hash says about the file.
const HASH_LEFT_OUT = ['token', 'apiHeaders', 'lastUsername', 'chosenPhotosMemberId'];

/**
 * JSON text of a parsed value with every object's keys in sorted order, so the same content always reads the same.
 */
const stableStringify = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (isPlainObject(value)) {
        const members = Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
        return `{${members.join(',')}}`;
    }
    return String(JSON.stringify(value));
};

/**
 * The SHA-256 (hex) of what a `settings.json` holds apart from its sign-in state, in a canonical form (parsed, the
 * sign-in keys removed, keys sorted), so blanking the sign-in state or reformatting the file never changes it. Null when
 * the text is not a JSON object. WebCrypto, so it runs the same under Node, Electron and the Android WebView.
 */
const canonicalLegacyHash = async (raw: string): Promise<string | null> => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isPlainObject(parsed)) return null;
    const kept = Object.fromEntries(Object.entries(parsed).filter(([key]) => !HASH_LEFT_OUT.includes(key)));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(kept)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Change the stored `imported` record: `change` gets it and answers the record to store, or null to leave it. The text is
 * read and written back in one step, so what another writer of this process saved before is kept.
 *
 * @returns whether the record is stored as `change` left it (false: there is no record, or it could not be saved)
 */
const updateImported = (change: (imported: ImportedV2) => ImportedV2 | null): boolean => {
    try {
        const raw = storage.readRaw();
        if (!raw) return false;
        const parsed: unknown = JSON.parse(raw);
        if (!isPlainObject(parsed) || !isImportedRecord(parsed.imported)) return false;
        const next = change(parsed.imported);
        if (next === null) return true;
        return storage.writeRaw(JSON.stringify({ ...parsed, imported: next }, null, 2));
    } catch (error) {
        logger.withCategory('settings').error('Could not update the import record:', errorMessage(error));
        return false;
    }
};

/**
 * Record the hash of the `settings.json` text an import was made from, once it is stored. An import that is stored
 * without it (the process ended first) gets the hash of the file as it is at the next start (see checkLegacyDrift).
 */
const recordImportHash = async (raw: string): Promise<void> => {
    try {
        const hash = await canonicalLegacyHash(raw);
        if (hash !== null)
            updateImported((imported) => (imported.sha256 === '' ? { ...imported, sha256: hash } : null));
    } catch (error) {
        logger.withCategory('settings').error('Could not record the hash of settings.json:', errorMessage(error));
    }
};

export { canonicalLegacyHash, recordImportHash, updateImported };
