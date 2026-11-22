/**
 * Link version 3, frozen: the payload of each event the desktop forwards to a phone (`event` messages), and the
 * `autovote-state` the controller pushes.
 *
 * Written out as concrete types, copied from the shapes the app resolved when link version 3 was cut. Do not edit
 * this file to match a changed payload: a change that breaks it needs a new LINK_VERSION and a new
 * `contract/v<N>/` (see protocol.ts for the rule). `tests/remote/contractV3.test.ts` checks the living types
 * against it.
 */

import type { EffectiveValueV3 } from './shapesLifecycle';
import type { ConfigV2V3, DownloadProgressV3, GuiLogEntryV3, UpdateSummaryV3 } from './shapesConfig';

/** The event channels a desktop forwards and the payload each carries. */
export type EventPayloadsV3 = {
    'settings-changed': ConfigV2V3;
    'update-checking': null;
    'update-available': UpdateSummaryV3;
    'update-not-available': { version: string };
    'update-download-progress': DownloadProgressV3;
    'update-downloaded': UpdateSummaryV3;
    'update-error': { message: string; code?: string };
    'log-message': GuiLogEntryV3;
    /** The installation's effective settings; `revision` rises with every change, and a client ignores an older one. */
    'effective-settings-changed': {
        revision: number;
        subject: 'installation';
        generation: number | null;
        values: { [key: string]: EffectiveValueV3 };
    };
    /** The presentation-only projection: theme, language, availability and the same rising revision. */
    'effective-presentation-changed': {
        revision: number;
        available: boolean;
        theme: string | null;
        language: string | null;
        reason: string | null;
    };
};
