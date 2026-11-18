/**
 * A request identity: 32 random hex characters, drawn where the request is made (the phone's bridge and controller). It
 * matches what the host's control inbox accepts as an identity (settings/scenarioControls.ts) and what a message field
 * bounds (protocol.ts). Dependency-free.
 */

export const newRequestId = (): string =>
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
