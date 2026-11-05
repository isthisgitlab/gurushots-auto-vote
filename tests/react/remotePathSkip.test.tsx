/**
 * The loader's skip to the page of the version it last reached, end to end across the documents it touches: the
 * real loader and the real peer bridge (the versioned page's side) over the real store in the tab's storage. Each
 * "document" is a fresh load; the tab keeps its storage between them, as it does.
 *
 * - a stale kept version: the loader goes straight to its page, which finds another desktop version, keeps it and
 *   sends the tab back; the loader then goes to the right page, and no second skip happens;
 * - a page that keeps nothing (an older one) sends the tab back with the kept version unchanged: the loader finds
 *   its own mark and runs the whole flow, ending on the right page after one extra connect.
 */

import { TransportStub } from '../helpers/remoteTransport';
import { PAGE_VERSION, PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';
import {
    DESKTOP_VERSION_STORAGE,
    SKIPPED_TO_STORAGE,
    storeDesktopVersion,
} from '../../src/ts/core/remote/desktopVersion';
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

/** A fresh load of a versioned page that keeps the desktop's version, as this build's page does. */
const loadPage = async (hostVersion: string): Promise<void> => {
    const transport = new TransportStub('phone');
    jest.isolateModules(() => {
        const bridge = require('../../src/ts/shells/remote/bridge/peer') as {
            installPeerBridge: typeof installPeerBridge;
        };
        bridge.installPeerBridge(transport, LOADER_TARGET);
    });
    transport.emitJoin('host');
    transport.receiveFromPeer(
        { t: 'hello', version: hostVersion, protocolVersion: PROTOCOL_VERSION, host: true },
        'host',
    );
    await settle();
};

describe("the loader's skip to the kept version, across the documents", () => {
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

    test("a stale kept version's page bounces back, the loader goes to the right page, and there is no second skip", async () => {
        await storeDesktopVersion('1.0.0');

        await loadLoader();
        expect(navigated).toEqual([`./1.0.0/index.html#k=${KEY}`]);
        expect(window.sessionStorage.getItem(SKIPPED_TO_STORAGE)).toBe('1.0.0');

        // The 1.0.0 page finds the desktop runs another version: it keeps that version and sends the tab to the loader.
        await loadPage('9.9.9');
        expect(navigated.at(-1)).toBe(LOADER_TARGET);
        expect(window.localStorage.getItem(DESKTOP_VERSION_STORAGE)).toMatch(/:9\.9\.9$/);

        // The loader goes to 9.9.9 at once (its mark names 1.0.0, not 9.9.9).
        await loadLoader();
        expect(navigated.at(-1)).toBe(`./9.9.9/index.html#k=${KEY}`);
        expect(window.sessionStorage.getItem(SKIPPED_TO_STORAGE)).toBe('9.9.9');

        // That page is the desktop's: it keeps the version and clears the mark. The tab ends there.
        await loadPage(PAGE_VERSION);
        expect(window.localStorage.getItem(DESKTOP_VERSION_STORAGE)).toMatch(new RegExp(`:${PAGE_VERSION}$`));
        expect(window.sessionStorage.getItem(SKIPPED_TO_STORAGE)).toBeNull();
        expect(navigated).toEqual([`./1.0.0/index.html#k=${KEY}`, LOADER_TARGET, `./9.9.9/index.html#k=${KEY}`]);
    });

    test('a page that keeps nothing (an older one) bounces the tab back: the loader finds its own mark and runs the whole flow', async () => {
        await storeDesktopVersion('1.0.0');

        await loadLoader();
        expect(navigated).toEqual([`./1.0.0/index.html#k=${KEY}`]);

        // The old 1.0.0 page writes nothing and sends the tab back to the loader.
        window.location.replace(LOADER_TARGET);
        const connects = jest.mocked(
            (require('../../src/ts/core/remote/trystero') as typeof import('../../src/ts/core/remote/trystero'))
                .createTrysteroTransport,
        );
        const before = connects.mock.calls.length;

        const transport = await loadLoader();
        expect(navigated).toEqual([`./1.0.0/index.html#k=${KEY}`, LOADER_TARGET]); // no second skip
        expect(connects.mock.calls.length).toBe(before + 1); // the one extra connect
        expect(window.localStorage.getItem(DESKTOP_VERSION_STORAGE)).toBeNull(); // the stale value was cleared

        // The whole flow reads the desktop's version, keeps it and goes to its page.
        transport.emitJoin('host');
        transport.receiveFromPeer(
            { t: 'hello', version: '9.9.9', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await settle();
        expect(navigated.at(-1)).toBe(`./9.9.9/index.html#k=${KEY}`);
        expect(window.localStorage.getItem(DESKTOP_VERSION_STORAGE)).toMatch(/:9\.9\.9$/);
    });

    test('a value kept for another pairing is cleared and the whole flow runs', async () => {
        window.location.hash = `#k=${'o'.repeat(43)}`;
        await storeDesktopVersion('1.0.0');
        window.location.hash = `#k=${KEY}`;

        const transport = await loadLoader();
        expect(navigated).toEqual([]);
        expect(window.localStorage.getItem(DESKTOP_VERSION_STORAGE)).toBeNull();
        transport.emitJoin('host');
        transport.receiveFromPeer(
            { t: 'hello', version: '2.0.0', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await settle();
        expect(navigated).toEqual([`./2.0.0/index.html#k=${KEY}`]);
    });

    test('a return visit after the tab accepted the desktop goes straight on again, even in the same tab', async () => {
        await loadLoader().then(async (transport) => {
            transport.emitJoin('host');
            transport.receiveFromPeer(
                { t: 'hello', version: PAGE_VERSION, protocolVersion: PROTOCOL_VERSION, host: true },
                'host',
            );
            await settle();
        });
        expect(navigated).toEqual([`./${PAGE_VERSION}/index.html#k=${KEY}`]);
        await loadPage(PAGE_VERSION); // the page accepts it
        await loadLoader(); // a reload of the loader address in the same tab
        expect(navigated.at(-1)).toBe(`./${PAGE_VERSION}/index.html#k=${KEY}`);
        expect(navigated).toHaveLength(2);
    });
});
