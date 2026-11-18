/**
 * The installation's effective time zone at a boundary: the saved one, or the published phase of the installation scenario
 * over it (settings.captureInstallationSettings). The saved value never takes the place of one that cannot be read: the
 * caller gets `null` and treats the evidence as unknown (no window, no deadline, no step), as it does for any unreadable read.
 *
 * A boundary reads it once (an evaluation, a cycle, a step) and keeps what it read, so that a publication that lands
 * meanwhile applies from the next boundary and a zone is never changed under a computation in flight.
 */

import * as settings from '../settings';
import { effectiveTimezone } from '../settings/uiDefaults';

/** The effective IANA zone (an empty or unknown one means UTC, as everywhere), or null when it cannot be read. */
const captureInstallationTimezone = (): string | null => {
    const captured = settings.captureInstallationSettings(['timezone']);
    return captured.ok ? effectiveTimezone(captured.values.timezone) : null;
};

export { captureInstallationTimezone };
