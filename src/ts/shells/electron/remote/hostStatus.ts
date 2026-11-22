/**
 * What the Electron shell tells the scenario facts about the remote-access pairing: only whether the feature is on, read from
 * the pairing store. The host's connections live in the main window, not here, so whether a phone is connected is not known to
 * this process (`remoteConnected` null). No key, link or peer identity passes through. A module of its own, with no
 * side effect, so that the shell platform module reaches it at call time and registerIpc can set the source without loading
 * the platform module.
 */

import type { ScenarioHostStatus } from '../../../core/platform/port';

type HostStatusSource = () => { enabled: boolean };

let source: HostStatusSource | null = null;

/** Sets where the pairing's enabled state is read from (registerIpc, once the pairing store is built); null clears it. */
const setHostStatusSource = (next: HostStatusSource | null): void => {
    source = next;
};

/** The platform's readScenarioHostStatus on Electron. Rejects while no pairing store is registered: that is a failed read, not an absent one. */
const readHostStatus = async (): Promise<ScenarioHostStatus> => {
    if (source === null) throw new Error('The remote pairing is not ready');
    return { supported: true, remoteEnabled: source().enabled, remoteConnected: null };
};

export { setHostStatusSource, readHostStatus };
