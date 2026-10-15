/**
 * The marker of the one-time 1.x import (`v2-import.json`): it exists once the import has run, or once there was no
 * 1.x file to import. It lives in a store of its own, outside `config.json`, so that deleting or setting aside the
 * configuration never makes the next start import `settings.json` again without being asked.
 */

import { createJsonStore } from './storage';

const importMarkerStore = createJsonStore({ fileName: 'v2-import.json', prefKey: 'gs_v2_import', atomic: true });

/** Whether the import has run (or had nothing to import) on this device. */
const isImportMarked = (): boolean => importMarkerStore.readRaw() !== null;

/** Records that the import has run. */
const markImportDone = (): void => {
    importMarkerStore.writeRaw(JSON.stringify({ importedAt: new Date().toISOString() }, null, 2));
};

export { importMarkerStore, isImportMarked, markImportDone };
