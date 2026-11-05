/**
 * Link version 1, frozen: the payload of each event the desktop forwards to a phone (`event` messages), and the
 * `autovote-state` the controller pushes.
 *
 * Written out as concrete types, copied from the shapes the app resolved when link version 1 was cut. Do not edit
 * this file to match a changed payload: a change that breaks it needs a new LINK_VERSION and a new
 * `contract/v<N>/` (see protocol.ts for the rule). `tests/remote/contractV1.test.ts` checks the living types
 * against it.
 */

import type { ConfigV2V1, DownloadProgressV1, GuiLogEntryV1, UpdateSummaryV1 } from './shapesConfig';

/** The event channels a desktop forwards and the payload each carries. */
export type EventPayloadsV1 = {
    'settings-changed': ConfigV2V1;
    'update-checking': null;
    'update-available': UpdateSummaryV1;
    'update-not-available': { version: string };
    'update-download-progress': DownloadProgressV1;
    'update-downloaded': UpdateSummaryV1;
    'update-error': { message: string; code?: string };
    'log-message': GuiLogEntryV1;
};
