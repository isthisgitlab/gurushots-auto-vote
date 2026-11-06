/**
 * The loader's skip to the page of the link version it last reached, end to end across the documents it touches:
 * the real loader and the real peer bridge (the versioned page's side) over the real store in the tab's storage.
 * Each "document" is a fresh load; the tab keeps its storage between them, as it does.
 *
 * - a stale kept link version: the loader goes straight to its page, which finds another desktop link version, keeps
 *   it and sends the tab back; the loader then goes to the right page, and no second skip happens;
 * - a v1 page whose write the browser refused: it keeps nothing and sends the tab back with the kept version
 *   unchanged: the loader finds its own mark and runs the whole flow, ending on the desktop's page after one
 *   extra connect, without looping.
 */

import { TransportStub } from '../helpers/remoteTransport';
import { LINK_VERSION, PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';
import { LINK_VERSION_STORAGE, SKIPPED_TO_STORAGE, storeLinkVersion } from '../../src/ts/core/remote/linkVersion';
import { installPeerBridge } from '../../src/ts/shells/remote/bridge/peer';
import { setRemoteConnectionState, setRemoteHostPeerId } from '../../src/ts/core/remote/connectionState';

const transportStub: { current: TransportStub | null } = { current: null };
jest.mock('../../src/ts/core/remote/trystero', () => ({
    createTrysteroTransport: jest.fn(async () => transportStub.current),
    isConnectionFailureJoinError: (error: string): boolean =>
        error.startsWith('could not connect to peer') && error.includes('after exchanging SDP'),
}));
jest.mock('../../src/ts/shells/remote/phoneMode', () => ({ installPhoneDisconnect: () => undefined }));

const KEY = 'k'.repeat(43);
const LOADER_TARGET = `https://site.test/remote/index.html#k=${KEY}`;

const navigated: string[] = [];
let replaceSpy: jest.SpiedFunction<(url: string | URL) => void>;
const g = globalThis as { fetch?: unknown };

/** Lets the real store (it hashes the key off the microtask queue) and the loader's chains finish. */
const settle = async (ms = 60): Promise<void> => {
    for (let waited = 0; waited < ms; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
};

/** A fresh load of the loader document. */
const loadLoader = async (): Promise<TransportStub> => {
    transportStub.current = TransportStub.pair('host', 'loader')[1];
    jest.isolateModules(() => {
        require('../../src/ts/shells/remote/loader');
    });
    await settle();
    return transportStub.current;
};

/** A fresh load of a v1 page: the desktop's hello names its link version. */
const loadPage = async (linkVersion: number): Promise<void> => {
    const transport = new TransportStub('phone');
    jest.isolateModules(() => {
        const bridge = require('../../src/ts/shells/remote/bridge/peer') as {
            installPeerBridge: typeof installPeerBridge;
        };
        bridge.installPeerBridge(transport, LOADER_TARGET);
    });
    transport.emitJoin('host');
    transport.receiveFromPeer(
        {
            t: 'hello',
            version: '9.9.9',
            protocolVersion: PROTOCOL_VERSION,
            linkVersion,
            host: true,
        },
        'host',
    );
    await settle();
};

describe("the loader's skip to the kept link version, across the documents", () => {
    beforeEach(() => {
        navigated.length = 0;
        window.location.hash = `#k=${KEY}`;
        window.localStorage.clear();
        window.sessionStorage.clear();
        document.body.innerHTML = '<div id="root"></div>';
        replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation((url: string | URL) => {
            navigated.push(String(url));
        });
        g.fetch = jest.fn(async () => ({ ok: true }) as Response);
        setRemoteConnectionState('connecting');
    });

    afterEach(() => {
        replaceSpy.mockRestore();
        delete g.fetch;
        window.location.hash = '';
        window.localStorage.clear();
        window.sessionStorage.clear();
        setRemoteHostPeerId(null);
        delete (globalThis as { api?: unknown }).api;
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
    });

    test("a stale kept link version's page bounces back, the loader goes to the right page, and there is no second skip", async () => {
        await storeLinkVersion(LINK_VERSION);

        await loadLoader();
        expect(navigated).toEqual([`./v${LINK_VERSION}/index.html#k=${KEY}`]);
        expect(window.sessionStorage.getItem(SKIPPED_TO_STORAGE)).toBe(String(LINK_VERSION));

        // The v1 page finds the desktop speaks link version 2: it keeps that and sends the tab to the loader.
        await loadPage(2);
        expect(navigated.at(-1)).toBe(LOADER_TARGET);
        expect(window.localStorage.getItem(LINK_VERSION_STORAGE)).toMatch(/:2$/);

        // The loader goes to v2 at once (its mark names 1, not 2).
        await loadLoader();
        expect(navigated.at(-1)).toBe(`./v2/index.html#k=${KEY}`);
        expect(window.sessionStorage.getItem(SKIPPED_TO_STORAGE)).toBe('2');
        expect(navigated).toEqual([`./v1/index.html#k=${KEY}`, LOADER_TARGET, `./v2/index.html#k=${KEY}`]);
    });

    test("a page that could not keep the link version (the browser refused the write) bounces the tab back: the loader finds its own mark, runs the whole flow and lands on the desktop's page", async () => {
        await storeLinkVersion(LINK_VERSION);

        await loadLoader();
        expect(navigated).toEqual([`./v1/index.html#k=${KEY}`]);

        // The v1 page hears a desktop of link version 2 but its write is refused: it keeps nothing and sends the tab
        // back to the loader.
        const kept = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                setItem: () => {
                    throw new Error('storage refused');
                },
            },
        });
        try {
            await loadPage(2);
        } finally {
            if (kept === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
            else Object.defineProperty(globalThis, 'localStorage', kept);
        }
        expect(navigated.at(-1)).toBe(LOADER_TARGET);
        expect(window.localStorage.getItem(LINK_VERSION_STORAGE)).toMatch(/:1$/); // unchanged
        const connects = jest.mocked(
            (require('../../src/ts/core/remote/trystero') as typeof import('../../src/ts/core/remote/trystero'))
                .createTrysteroTransport,
        );
        const before = connects.mock.calls.length;

        const transport = await loadLoader();
        expect(navigated).toEqual([`./v1/index.html#k=${KEY}`, LOADER_TARGET]); // no second skip
        expect(connects.mock.calls.length).toBe(before + 1); // the one extra connect
        expect(window.localStorage.getItem(LINK_VERSION_STORAGE)).toBeNull(); // the stale value was cleared

        // The whole flow reads the desktop's hello and goes to its page, keeping the link version it reached.
        transport.emitJoin('host');
        transport.receiveFromPeer(
            { t: 'hello', version: '9.9.9', protocolVersion: PROTOCOL_VERSION, linkVersion: 2, host: true },
            'host',
        );
        await settle();
        expect(navigated.at(-1)).toBe(`./v2/index.html#k=${KEY}`);
        expect(navigated).toHaveLength(3);
        expect(window.localStorage.getItem(LINK_VERSION_STORAGE)).toMatch(/:2$/);
    });

    test('a value kept for another pairing is cleared and the whole flow runs', async () => {
        window.location.hash = `#k=${'o'.repeat(43)}`;
        await storeLinkVersion(LINK_VERSION);
        window.location.hash = `#k=${KEY}`;

        const transport = await loadLoader();
        expect(navigated).toEqual([]);
        expect(window.localStorage.getItem(LINK_VERSION_STORAGE)).toBeNull();
        transport.emitJoin('host');
        transport.receiveFromPeer(
            { t: 'hello', version: '2.0.0', protocolVersion: PROTOCOL_VERSION, linkVersion: 2, host: true },
            'host',
        );
        await settle();
        expect(navigated).toEqual([`./v2/index.html#k=${KEY}`]);
    });

    test('a return visit after the tab accepted the desktop goes straight on again, even in the same tab', async () => {
        await loadLoader().then(async (transport) => {
            transport.emitJoin('host');
            transport.receiveFromPeer(
                {
                    t: 'hello',
                    version: '5.0.0',
                    protocolVersion: PROTOCOL_VERSION,
                    linkVersion: LINK_VERSION,
                    host: true,
                },
                'host',
            );
            await settle();
        });
        expect(navigated).toEqual([`./v1/index.html#k=${KEY}`]);
        await loadPage(LINK_VERSION); // the page accepts it
        await loadLoader(); // a reload of the loader address in the same tab
        expect(navigated.at(-1)).toBe(`./v1/index.html#k=${KEY}`);
        expect(navigated).toHaveLength(2);
    });
});
