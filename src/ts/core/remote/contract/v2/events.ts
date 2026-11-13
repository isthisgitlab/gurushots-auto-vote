/**
 * Link version 2, frozen: the payload of each event the desktop forwards to a phone (`event` messages), and the
 * `autovote-state` the controller pushes.
 *
 * Written out as concrete types, copied from the shapes the app resolved when link version 2 was cut. Do not edit
 * this file to match a changed payload: a change that breaks it needs a new LINK_VERSION and a new
 * `contract/v<N>/` (see protocol.ts for the rule). `tests/remote/contractV2.test.ts` checks the living types
 * against it.
 */

import type { ConfigV2V2, DownloadProgressV2, GuiLogEntryV2, UpdateSummaryV2 } from './shapesConfig';

/** The event channels a desktop forwards and the payload each carries. */
export type EventPayloadsV2 = {
    'settings-changed': ConfigV2V2;
    'update-checking': null;
    'update-available': UpdateSummaryV2;
    'update-not-available': { version: string };
    'update-download-progress': DownloadProgressV2;
    'update-downloaded': UpdateSummaryV2;
    'update-error': { message: string; code?: string };
    'log-message': GuiLogEntryV2;
};
