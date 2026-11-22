/**
 * The Node-side seams of the autovote controller over the settings facade: the priority Stop fence, and the withdrawal and
 * restoration of the installation's publication. The CLI scheduler is built on them, and so is any Node-hosted controller; the
 * WebView reaches the same operations through its own channel. Not for the renderer bundle (it imports the settings facade).
 */

import * as settings from '../settings';

import type { StopFencePort, WithdrawalOutcome } from './runGate';

/** The priority Stop fence, over the settings facade (the platform's storage). */
const nodeStopFence: StopFencePort = {
    read: () => settings.readStopFence(),
    initialize: () => settings.initializeStopFence(),
    recordFullStop: (requestId, at) => settings.recordFullStop(requestId, at),
    clearStopBlock: (expectedEpoch) => settings.clearStopBlock(expectedEpoch),
    isArmAllowed: (capturedEpoch) => settings.isArmAllowed(capturedEpoch),
    armIfAllowed: (capturedEpoch, at) => settings.armIfAllowed(capturedEpoch, at),
};

/** A full Stop's withdrawal of the installation's publication under `epoch`. */
const withdrawInstallation = (epoch: number): Exclude<WithdrawalOutcome, 'no-route'> => {
    const result = settings.withdrawInstallationPublication(epoch);
    if (!result.ok) return 'failed';
    return result.changed ? 'withdrawn' : 'none';
};

/** The explicit user re-arm's lifting of the withdrawal, before the next publication. `failed`: it still stands. */
const reArmInstallation = (): 'restored' | 'none' | 'failed' => {
    const result = settings.restoreInstallationPublication();
    if (!result.ok) return 'failed';
    return result.changed ? 'restored' : 'none';
};

export { nodeStopFence, withdrawInstallation, reArmInstallation };
