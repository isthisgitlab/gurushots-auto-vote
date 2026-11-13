/** The direct current-v2 remote entry validates its key before it creates a transport. */

import { installPhoneRemoteMode } from '../../src/ts/core/remote/phoneMode';

import type { RendererGlobals } from '../../src/ts/core/types/capacitor';

const SRC = '../../src/ts';
const KEY = 'a'.repeat(43);

const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('Remote entry', () => {
    let saved: boolean | undefined;

    beforeEach(() => {
        saved = (globalThis as RendererGlobals).__capacitorBootstrap;
        document.body.innerHTML = '<div id="root"></div>';
        window.location.hash = `#k=${KEY}`;
    });

    afterEach(() => {
        if (saved === undefined) delete (globalThis as RendererGlobals).__capacitorBootstrap;
        else (globalThis as RendererGlobals).__capacitorBootstrap = saved;
        document.body.innerHTML = '';
        window.location.hash = '';
        delete (globalThis as { api?: unknown }).api;
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
        jest.resetModules();
    });

    const load = (transport: object | Error, android = false) => {
        const m = {
            transport: { marker: 'remote-transport' },
            installed: jest.fn(),
            installDisconnect: jest.fn(),
            mounted: [] as unknown[],
            created: [] as unknown[],
        };
        jest.doMock(`${SRC}/core/remote/trystero`, () => ({
            createTrysteroTransport: jest.fn(async (options: unknown) => {
                m.created.push(options);
                if (transport instanceof Error) throw transport;
                return m.transport;
            }),
        }));
        jest.doMock(`${SRC}/shells/remote/bridge/peer`, () => ({ installPeerBridge: m.installed }));
        jest.doMock(`${SRC}/shells/remote/phoneMode`, () => ({
            installPhoneDisconnect: () => {
                m.installDisconnect();
                if (android) {
                    jest.requireActual<typeof import('../../src/ts/core/remote/phoneMode')>(
                        '../../src/ts/core/remote/phoneMode',
                    ).installPhoneRemoteMode({ disconnect: async () => undefined });
                }
            },
        }));
        jest.doMock(`${SRC}/react/pages/App`, () => ({
            mountApp: jest.fn((_host: unknown, remoteTransport?: unknown) => {
                m.mounted.push(remoteTransport);
                return null;
            }),
        }));
        jest.doMock(`${SRC}/react/contexts/noopBackgroundHost`, () => ({ noopBackgroundHost: { marker: 'noop' } }));
        jest.isolateModules(() => {
            require(`${SRC}/shells/remote/page`);
        });
        return m;
    };

    test('with a valid key it joins the room, installs the bridge, and mounts the app over the transport', async () => {
        const m = load({ marker: 'remote-transport' });
        await flush();
        expect(m.created).toEqual([{ key: KEY, role: 'phone' }]);
        expect(m.installed).toHaveBeenCalledWith(m.transport);
        expect(m.mounted).toEqual([m.transport]);
        expect(m.installDisconnect).toHaveBeenCalledTimes(1);
        expect(m.installDisconnect.mock.invocationCallOrder[0]).toBeLessThan(m.installed.mock.invocationCallOrder[0]);
        expect((globalThis as RendererGlobals).__capacitorBootstrap).toBe(true);
    });

    test('inside the Android app it keeps the direct current page unchanged', async () => {
        const replaceState = jest.spyOn(window.history, 'replaceState');
        try {
            installPhoneRemoteMode({ disconnect: async () => undefined });
            const m = load({ marker: 'remote-transport' }, true);
            await flush();
            expect(replaceState).not.toHaveBeenCalled();
            expect(m.installed).toHaveBeenCalledWith(m.transport);
        } finally {
            replaceState.mockRestore();
            installPhoneRemoteMode({});
        }
    });

    test.each(['', '#k=bad', `#k=${KEY}&k=${KEY}`])('a %s fragment creates no transport', async (hash) => {
        window.location.hash = hash;
        const m = load({ marker: 'remote-transport' });
        await flush();
        expect(m.created).toEqual([]);
        expect(m.installed).not.toHaveBeenCalled();
        expect(m.mounted).toEqual([]);
        expect(document.getElementById('root')?.textContent).toBe('app.remoteNoKey');
    });

    test('a transport that cannot be built leaves the offline-or-reset state', async () => {
        const m = load(new Error('no webrtc'));
        await flush();
        expect(m.installed).not.toHaveBeenCalled();
        expect(m.mounted).toEqual([]);
        expect(document.getElementById('root')?.textContent).toBe('app.remoteOfflineDetail');
    });
});
