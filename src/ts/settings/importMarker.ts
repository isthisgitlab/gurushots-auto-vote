/**
 * The marker of the import (`v2-import.json`): it exists once the import has run, or once there was no `settings.json`
 * to import. It lives in a store of its own, outside `config.json`, so that deleting or setting aside the
 * configuration never makes the next start import `settings.json` again without being asked. It also says whether the
 * mirror has started writing `settings.json`: from then on the file is the app's own output, and no copy of it is kept
 * as `settings.json.original`.
 */

import { isPlainObject } from '../plainObject';
import { isImportedRecord } from './loadValidation';
import { createJsonStore } from './storage';

import type { ImportedV2 } from '../types/config';

const importMarkerStore = createJsonStore({ fileName: 'v2-import.json', prefKey: 'gs_v2_import', atomic: true });

/** Whether the import has run (or had nothing to import) on this device. */
const isImportMarked = (): boolean => importMarkerStore.readRaw() !== null;

const readMarker = (): Record<string, unknown> | null => {
    const raw = importMarkerStore.readRaw();
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

const writeMarker = (marker: Record<string, unknown>): void => {
    importMarkerStore.writeRaw(JSON.stringify(marker, null, 2));
};

/**
 * Records that the import has run, keeping what the marker already says (that the mirror has started). `imported` is the
 * record of the import the marker keeps a copy of, so a configuration restored from `settings.json` has its report
 * back: a record sets it, `null` says there is none, and leaving it out keeps the one that is there.
 */
const markImportDone = (imported?: ImportedV2 | null): void => {
    const { importedRecord, ...rest } = readMarker() ?? {};
    const record = imported === undefined ? importedRecord : (imported ?? undefined);
    writeMarker({
        ...rest,
        importedAt: new Date().toISOString(),
        ...(record === undefined ? {} : { importedRecord: record }),
    });
};

/** The record of the import the marker keeps a copy of, or null. */
const keptImportedRecord = (): ImportedV2 | null => {
    const record = readMarker()?.importedRecord;
    return isImportedRecord(record) ? record : null;
};

/** Keeps a copy of the import record that changed (the report was acknowledged); nothing when there is no marker. */
const keepImportedRecord = (record: ImportedV2): void => {
    const marker = readMarker();
    if (marker !== null) writeMarker({ ...marker, importedRecord: record });
};

/** Whether the mirror has written `settings.json` on this device (see formatOneMirror.ts). */
const isMirrorStarted = (): boolean => typeof readMarker()?.mirrorStartedAt === 'string';

/** Records that the mirror has written `settings.json`; nothing when there is no marker to record it in. */
const markMirrorStarted = (): void => {
    const marker = readMarker();
    if (marker === null || typeof marker.mirrorStartedAt === 'string') return;
    writeMarker({ ...marker, mirrorStartedAt: new Date().toISOString() });
};

export {
    importMarkerStore,
    isImportMarked,
    isMirrorStarted,
    keepImportedRecord,
    keptImportedRecord,
    markImportDone,
    markMirrorStarted,
};
