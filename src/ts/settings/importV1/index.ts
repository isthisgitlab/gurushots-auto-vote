/**
 * The one-time import of a 1.x `settings.json` into the 2.x configuration. The 1.x load pipeline lives here as a
 * frozen copy (frozen schema, merge over the defaults, the eight migrations, load validation, prune), so a later
 * change to the live settings cannot change what an old file imports as. It runs in memory only: it reads the
 * text it is given, writes nothing, and never saves the migrated blob back as 1.x did.
 */

import * as logger from '../../logger';
import { errorMessage } from '../../errorMessage';
import { isPlainObject } from '../../plainObject';
import { oneLine } from '../../format/logSafe';
import { convertV1Blob } from './convert';
import { dropInvalidV1Values, mergeV1WithDefaults, pruneV1Obsolete } from './loadValidation';
import { runV1Migrations } from './migrations';

import type { ConfigV2, ImportReportV2 } from '../../types/config';
import type { V1Blob } from './types';

/**
 * Parse the stored text as a settings object; the reason it is not one otherwise.
 */
const parseV1Settings = (raw: string): { ok: true; value: object } | { ok: false; reason: string } => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return { ok: false, reason: `it is not valid JSON (${errorMessage(error)})` };
    }
    return isPlainObject(parsed) ? { ok: true, value: parsed } : { ok: false, reason: 'its root is not an object' };
};

/**
 * Merge a parsed 1.x settings object over the defaults, migrate it and drop the values it may not hold: what a 1.x
 * load returned. Returns the blob and the paths whose values were dropped. Throws when a migration cannot handle
 * the file.
 */
const interpretV1Settings = (parsed: object): { blob: V1Blob; dropped: string[] } => {
    const blob = mergeV1WithDefaults(parsed);
    runV1Migrations(blob);
    return { blob, dropped: dropInvalidV1Values(blob) };
};

type ImportV1Result =
    | { ok: true; config: ConfigV2; titlePins: Record<string, string>; report: ImportReportV2 }
    | { ok: false; code: 'corrupt' | 'migration-failed'; detail: string };

/**
 * Turn the text of a 1.x `settings.json` into a 2.x configuration. `corrupt`: the text is not JSON, or its root is
 * not an object. `migration-failed`: the 1.x pipeline threw on it. The title pins come back next to the
 * configuration, which does not hold them.
 */
const importV1Settings = (raw: string): ImportV1Result => {
    const parsed = parseV1Settings(raw);
    if (!parsed.ok) return { ok: false, code: 'corrupt', detail: parsed.reason };
    try {
        const { blob, dropped } = interpretV1Settings(parsed.value);
        if (dropped.length > 0) {
            logger
                .withCategory('settings')
                .warning(
                    `Importing 1.x settings: ignoring stored values that are not valid (defaults apply): ${oneLine(dropped.join(', ')).slice(0, 500)}`,
                );
        }
        pruneV1Obsolete(blob);
        return { ok: true, ...convertV1Blob(blob) };
    } catch (error) {
        return { ok: false, code: 'migration-failed', detail: errorMessage(error) ?? 'unknown error' };
    }
};

export { importV1Settings, interpretV1Settings, parseV1Settings };
export { V1_KEY_RENAMES, renameV1ScenarioDocument } from './renames';
