/**
 * The record of the import kept in `config.json` (`imported`): the report of what the import left unresolved, and whether
 * the user has seen it. The record is read and changed in the stored text itself, so everything else in the
 * configuration stays as stored; the import marker keeps a copy, so a configuration restored from `settings.json` has
 * its report back.
 */

import * as logger from '../logger';
import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { keepImportedRecord } from './importMarker';
import { isImportedRecord } from './loadValidation';
import { storage } from './storage';

import type { ImportedV2 } from '../types/config';

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
        if (!storage.writeRaw(JSON.stringify({ ...parsed, imported: next }, null, 2))) return false;
        keepImportedRecord(next);
        return true;
    } catch (error) {
        // The parser's message can quote the text (the token among it): a stored text that does not parse is said so.
        const reason = error instanceof SyntaxError ? 'the stored settings are not valid JSON' : errorMessage(error);
        logger.withCategory('settings').error(`Could not update the import record: ${reason ?? 'unknown error'}`);
        return false;
    }
};

export { updateImported };
