/**
 * The module state of the settings persistence: one mutable object that the
 * writers in `persistence.ts` and its siblings update in place — never copied,
 * so every writer sees every other writer's change.
 */

import type { ImportFailure } from '../legacyImport';
import type { SettingsRecovery } from './types';

export const state: {
    // The last file text found to hold only valid values, so an unchanged file is
    // not re-validated on every read; and the last warning, so an invalid file
    // warns once rather than on every read.
    lastCleanRaw: string | null;
    lastWarning: string | null;
    // Set while the stored settings cannot be used and must not be overwritten; cleared by the next load that gets through.
    blocked: (SettingsRecovery & { blocking: true }) | null;
    // Where the last unparseable configuration went; kept for the rest of the process so a window opened later can still say so.
    corruptBackupPath: string | null;
    // The unparseable text already moved aside, so a store that keeps handing it back (the Android service's) is not
    // moved, and logged, again on every read.
    lastQuarantinedRaw: string | null;
    // The import that failed, for as long as this process runs: reads answer the defaults and do not try it again (Retry
    // and the next start do). `importPermanent` says the file itself cannot be imported: the defaults were then stored and
    // the marker written, so saves work and the notice only tells what happened.
    importFailure: ImportFailure | null;
    importPermanent: boolean;
    // Whether this process has found out that no import is due (the marker says it has run, or a set-aside configuration
    // says it must not run unasked): a read of the defaults then takes no lock and looks at nothing.
    importSettled: boolean;
    // Told when a read clears a block that a window was told of (a state that had to wait came through): what
    // getSettingsRecovery answers changed without any write the window would hear of.
    recoveryListener: (() => void) | null;
    // The last message a blocked state logged, so that a failure tried again on every read is said once.
    lastBlockedLog: string | null;
} = {
    lastCleanRaw: null,
    lastWarning: null,
    blocked: null,
    corruptBackupPath: null,
    lastQuarantinedRaw: null,
    importFailure: null,
    importPermanent: false,
    importSettled: false,
    recoveryListener: null,
    lastBlockedLog: null,
};
