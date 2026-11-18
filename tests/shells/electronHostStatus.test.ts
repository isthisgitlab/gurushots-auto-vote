/**
 * What the Electron shell tells the scenario facts about the remote-access pairing (electron/remote/hostStatus.ts): only
 * whether the feature is on, with the connection unknown, and nothing of the pairing store but that flag.
 */

import { readHostStatus, setHostStatusSource } from '../../src/ts/shells/electron/remote/hostStatus';

afterEach(() => setHostStatusSource(null));

describe('the Electron remote-access host status', () => {
    test('a failed read while no pairing store is registered, never an absent one', async () => {
        await expect(readHostStatus()).rejects.toThrow('The remote pairing is not ready');
    });

    test('reports whether the feature is on, and that a connection is not known here', async () => {
        setHostStatusSource(() => ({ enabled: false }));
        await expect(readHostStatus()).resolves.toEqual({
            supported: true,
            remoteEnabled: false,
            remoteConnected: null,
        });
        setHostStatusSource(() => ({ enabled: true }));
        await expect(readHostStatus()).resolves.toEqual({
            supported: true,
            remoteEnabled: true,
            remoteConnected: null,
        });
    });

    test('carries nothing of the pairing store but the flag', async () => {
        setHostStatusSource(
            () => ({ enabled: true, key: 'KEY-MATERIAL', link: 'https://x/#k=KEY' }) as { enabled: boolean },
        );
        const status = await readHostStatus();
        expect(JSON.stringify(status)).not.toContain('KEY');
        expect(Object.keys(status).sort()).toEqual(['remoteConnected', 'remoteEnabled', 'supported']);
    });

    test('a source that throws is a failed read', async () => {
        setHostStatusSource(() => {
            throw new Error('unreadable store');
        });
        await expect(readHostStatus()).rejects.toThrow('unreadable store');
    });
});
