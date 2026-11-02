/**
 * The /remote/ loader: with a key it joins the room, reads the desktop's
 * version from its hello, and moves on to that version's page (the fragment
 * kept); a version the site does not publish says to update; no answer at
 * all says the computer is offline; no key says to scan the QR code.
 */

import { TransportStub } from '../helpers/remoteTransport';

const transportStub: { current: TransportStub | Error | null } = { current: null };

jest.mock('../../src/ts/core/remote/trystero', () => ({
    // A non-Error stub joins; an Error makes the join fail (the entry's catch path).
    createTrysteroTransport: jest.fn(async () => {
        const current = transportStub.current;
        if (current instanceof Error) throw current;
        return current as TransportStub;
    }),
    isConnectionFailureJoinError: (error: string): boolean =>
        error.startsWith('could not connect to peer') && error.includes('after exchanging SDP'),
}));
// The desktop version the loader keeps and the tab's loop guard are the store module's; here an in-memory stand-in
// records what the loader asks of it (the real store has its own tests, and the round trips run in remotePathSkip).
const versionStore = {
    stored: null as string | null,
    skipped: null as string | null,
    storeCalls: [] as string[],
    /** Makes the store's write fail, the way a browser that refuses storage does. */
    storeFails: false,
    cleared: 0,
    asked: 0,
};
jest.mock('../../src/ts/core/remote/desktopVersion', () => ({
    storedDesktopVersion: jest.fn(async () => {
        versionStore.asked += 1;
        return versionStore.stored;
    }),
    storeDesktopVersion: jest.fn(async (version: string) => {
        versionStore.storeCalls.push(version);
        if (versionStore.storeFails) throw new Error('storage refused');
    }),
    clearDesktopVersion: jest.fn(() => {
        versionStore.cleared += 1;
        versionStore.stored = null;
    }),
    skippedTo: jest.fn(() => versionStore.skipped),
    markSkippedTo: jest.fn((version: string) => {
        versionStore.skipped = version;
    }),
}));
const installPhoneDisconnect = jest.fn<void, []>();
const androidApp: { current: boolean } = { current: false };
jest.mock('../../src/ts/shells/remote/phoneMode', () => ({
    // Inside the Android app the real one installs Disconnect; here the flag stands for that.
    installPhoneDisconnect: () => {
        installPhoneDisconnect();
        if (androidApp.current) {
            jest.requireActual<typeof import('../../src/ts/core/remote/phoneMode')>(
                '../../src/ts/core/remote/phoneMode',
            ).installPhoneRemoteMode({ disconnect: async () => undefined });
        }
    },
}));
import { PAGE_VERSION, PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';
import { installPhoneRemoteMode } from '../../src/ts/core/remote/phoneMode';
import { rendererTranslator } from '../../src/ts/core/translations/renderer';
import { HELLO_RETRY_MS, HOST_ANSWER_TIMEOUT_MS } from '../../src/ts/core/remote/helloRepeat';
// The shared React setup mocks the page translator; the loader's notice screen shows real text.
jest.mock('../../src/ts/core/translations/renderer', () => ({
    rendererTranslator: jest.requireActual<typeof import('../../src/ts/core/translations/renderer')>(
        '../../src/ts/core/translations/renderer',
    ).rendererTranslator,
}));

const g = globalThis as { fetch?: unknown };
const navigated: string[] = [];
let fetchCalls: string[];
let replaceSpy: jest.SpiedFunction<(url: string | URL) => void>;

const loadLoader = (): void => {
    jest.isolateModules(() => {
        require('../../src/ts/shells/remote/loader');
    });
};

// Preact schedules the screen's state-driven re-render on a timer, which the fake clock holds back: run what is due now.
const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);
};

describe('the /remote/ loader', () => {
    let headOk: boolean;

    beforeEach(() => {
        jest.useFakeTimers();
        navigated.length = 0;
        fetchCalls = [];
        transportStub.current = TransportStub.pair('host', 'loader')[1];
        // happy-dom owns window.location: set the hash on it and spy on the navigation.
        window.location.hash = '#k=the-key';
        replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation((url: string | URL) => {
            navigated.push(String(url));
        });
        g.fetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>(async (input) => {
            fetchCalls.push(String(input));
            return { ok: headOk } as Response;
        });
        headOk = true;
        document.body.innerHTML = '<div id="root"></div>';
        versionStore.stored = null;
        versionStore.skipped = null;
        versionStore.storeCalls = [];
        versionStore.storeFails = false;
        versionStore.cleared = 0;
        versionStore.asked = 0;
    });

    afterEach(() => {
        jest.useRealTimers();
        replaceSpy.mockRestore();
        delete g.fetch;
        window.sessionStorage.clear();
        window.location.hash = '';
        androidApp.current = false;
        installPhoneRemoteMode({});
        rendererTranslator.setCurrentLanguage('en');
    });

    test('a hello names the version and the loader moves to its page, fragment kept', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        // The loader announces itself to the peer it saw.
        const hello = transport.sent.find(({ message }) => (message as { t: string }).t === 'hello');
        expect(hello?.target).toBe('host');

        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(fetchCalls).toEqual(['./1.2.3/index.html']);
        expect(navigated).toEqual(['./1.2.3/index.html#k=the-key']);
        // The version is kept for the next visit.
        expect(versionStore.storeCalls).toEqual(['1.2.3']);
    });

    test('a store that refuses the write never strands the tab: it still moves on to the version page', async () => {
        versionStore.storeFails = true;
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(versionStore.storeCalls).toEqual(['1.2.3']);
        expect(navigated).toEqual(['./1.2.3/index.html#k=the-key']);
    });

    test('a version whose page the site does not carry is not kept for the next visit', async () => {
        headOk = false;
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(navigated).toEqual([]);
        expect(versionStore.storeCalls).toEqual([]);
    });

    describe('a return visit (a desktop version kept from the last one)', () => {
        const createTransport = () => {
            const trystero =
                require('../../src/ts/core/remote/trystero') as typeof import('../../src/ts/core/remote/trystero');
            return jest.mocked(trystero.createTrysteroTransport);
        };

        test("goes straight to the kept version's page after one HEAD request, with no transport, fragment kept, and marks the tab", async () => {
            versionStore.stored = '2.0.0';
            const before = createTransport().mock.calls.length;
            loadLoader();
            await flush();
            expect(fetchCalls).toEqual(['./2.0.0/index.html']);
            expect(navigated).toEqual(['./2.0.0/index.html#k=the-key']);
            expect(versionStore.skipped).toBe('2.0.0');
            expect(versionStore.cleared).toBe(0);
            expect(createTransport().mock.calls.length).toBe(before); // nothing joined the room
        });

        test('a kept version whose page is not published is cleared, and the whole flow runs (and says what is wrong)', async () => {
            versionStore.stored = '2.0.0';
            headOk = false;
            loadLoader();
            await flush();
            expect(navigated).toEqual([]);
            expect(versionStore.cleared).toBe(1);
            expect(versionStore.skipped).toBeNull();
            // The normal flow joined the room and waits for the desktop's hello.
            const transport = transportStub.current as TransportStub;
            transport.emitJoin('host');
            await flush();
            transport.receiveFromPeer(
                { t: 'hello', version: '2.0.0', protocolVersion: PROTOCOL_VERSION, host: true },
                'host',
            );
            await flush();
            // The desktop (2.0.0) is newer than this page and the site does not carry its page: said, not skipped over.
            expect(document.getElementById('root')?.textContent).toContain('not published yet');
        });

        test('a version this tab already went straight to is not skipped to again: it is cleared and the whole flow runs', async () => {
            versionStore.stored = '2.0.0';
            versionStore.skipped = '2.0.0'; // its page sent the tab back
            loadLoader();
            await flush();
            expect(fetchCalls).toEqual([]);
            expect(navigated).toEqual([]);
            expect(versionStore.cleared).toBe(1);
            const transport = transportStub.current as TransportStub;
            transport.emitJoin('host');
            await flush();
            transport.receiveFromPeer(
                { t: 'hello', version: '3.0.0', protocolVersion: PROTOCOL_VERSION, host: true },
                'host',
            );
            await flush();
            expect(navigated).toEqual(['./3.0.0/index.html#k=the-key']);
            expect(versionStore.storeCalls).toEqual(['3.0.0']);
        });

        test('a kept version differing from the one this tab went to is skipped to (the page it was kept by found a newer desktop)', async () => {
            versionStore.stored = '3.0.0';
            versionStore.skipped = '2.0.0';
            loadLoader();
            await flush();
            expect(navigated).toEqual(['./3.0.0/index.html#k=the-key']);
            expect(versionStore.skipped).toBe('3.0.0');
        });

        test('nothing kept: the whole flow runs, and nothing is cleared', async () => {
            loadLoader();
            await flush();
            expect(versionStore.asked).toBe(1);
            expect(versionStore.cleared).toBe(0);
            expect(fetchCalls).toEqual([]);
        });

        test("inside the Android app the same check runs against the app's local server (the probe is the relative page file)", async () => {
            androidApp.current = true;
            versionStore.stored = '2.0.0';
            loadLoader();
            await flush();
            expect(fetchCalls).toEqual(['./2.0.0/index.html']);
            expect(navigated).toEqual(['./2.0.0/index.html#k=the-key']);
        });

        test('a probe that cannot run goes on to the page, as it does after a hello', async () => {
            versionStore.stored = '2.0.0';
            g.fetch = jest.fn(async () => {
                throw new Error('offline');
            });
            loadLoader();
            await flush();
            expect(navigated).toEqual(['./2.0.0/index.html#k=the-key']);
        });
    });

    test("a version the site does not carry says to update (the probe names the page file, as the app's local server needs)", async () => {
        headOk = false;
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '0.9.0', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(navigated).toEqual([]);
        expect(transport.left).toBe(true);
        expect(document.getElementById('root')?.textContent).toContain('Update the app on your computer');
    });

    test('no desktop answering says the computer is offline, or this link was reset', async () => {
        loadLoader();
        await flush();
        await jest.advanceTimersByTimeAsync(15_000);
        expect(navigated).toEqual([]);
        expect((transportStub.current as TransportStub).left).toBe(true);
        expect(document.getElementById('root')?.textContent).toContain(
            'Your computer is offline, or this link was reset',
        );
    });

    test('a fellow phone hello does not pick the version', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '0.0.1', protocolVersion: PROTOCOL_VERSION, host: false },
            'fellow-phone',
        );
        await flush();
        expect(navigated).toEqual([]);
        expect(fetchCalls).toEqual([]);
    });

    test('a message that is not a hello, and an unparsable one, change nothing', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        // A parseable peer message of another shape, and one that does not parse at all:
        // both are dropped, and the wait for the desktop's hello goes on.
        transport.receiveFromPeer({ t: 'result', id: 0, ok: false, error: 'x' }, 'host');
        transport.receiveFromPeer('not a protocol message', 'host');
        await flush();
        expect(transport.left).toBe(false);
        expect(navigated).toEqual([]);
        expect(fetchCalls).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('Connecting to your computer');
    });

    test('a join failure after the SDP exchange says to try Wi-Fi when the wait runs out', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        // The failing peer never joined, so the desktop may still connect: the wait goes on.
        transport.emitJoinError(
            'could not connect to peer 3b6a after exchanging SDP; configure TURN servers with turnConfig or rtcConfig.iceServers',
            'host',
        );
        await flush();
        expect(transport.left).toBe(false);
        expect(navigated).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('Connecting to your computer');

        await jest.advanceTimersByTimeAsync(HOST_ANSWER_TIMEOUT_MS);
        expect(transport.left).toBe(true);
        expect(document.getElementById('root')?.textContent).toContain('try Wi-Fi');
    });

    test('a browser that cannot run the relay fallback is told to update, not to try Wi-Fi', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        Object.assign(transport, { relayAvailable: () => false });
        transport.emitJoinError('could not connect to peer 3b6a after exchanging SDP', 'host');
        await jest.advanceTimersByTimeAsync(HOST_ANSWER_TIMEOUT_MS);
        expect(document.getElementById('root')?.textContent).toContain('too old');
        expect(document.getElementById('root')?.textContent).not.toContain('try Wi-Fi');
    });

    test('a browser without the relay fallback that heard nobody is told to update when the wait runs out, not that the computer is offline', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        Object.assign(transport, { relayAvailable: () => false });
        transport.emitJoin('host');
        await jest.advanceTimersByTimeAsync(HOST_ANSWER_TIMEOUT_MS - 1);
        expect(document.getElementById('root')?.textContent).toContain('Connecting');
        await jest.advanceTimersByTimeAsync(1);
        expect(document.getElementById('root')?.textContent).toContain('too old');
        expect(document.getElementById('root')?.textContent).not.toContain('offline');
    });

    test('where the relay fallback runs, nobody answering still says offline', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        Object.assign(transport, { relayAvailable: () => true });
        await jest.advanceTimersByTimeAsync(HOST_ANSWER_TIMEOUT_MS);
        expect(document.getElementById('root')?.textContent).not.toContain('too old');
        expect(transport.left).toBe(true);
    });

    test('where the relay fallback runs the same failure still says try Wi-Fi', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        Object.assign(transport, { relayAvailable: () => true });
        transport.emitJoinError('could not connect to peer 3b6a after exchanging SDP', 'host');
        await jest.advanceTimersByTimeAsync(HOST_ANSWER_TIMEOUT_MS);
        expect(document.getElementById('root')?.textContent).toContain('try Wi-Fi');
    });

    test('asks for the transport as a phone, leaves it when the page goes away for good, and keeps it when the page is only cached', async () => {
        const trystero =
            require('../../src/ts/core/remote/trystero') as typeof import('../../src/ts/core/remote/trystero');
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        expect(jest.mocked(trystero.createTrysteroTransport)).toHaveBeenLastCalledWith({
            key: 'the-key',
            role: 'phone',
        });
        const pagehide = (persisted: boolean): void => {
            const event = new Event('pagehide');
            Object.assign(event, { persisted });
            window.dispatchEvent(event);
        };
        window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); // a restore changes nothing here
        pagehide(true);
        expect(transport.left).toBe(false);
        pagehide(false);
        expect(transport.left).toBe(true);
    });

    test('a dropped first hello is repeated, and the second one gets the answer', async () => {
        // The first announce vanishes on the relay path: the send is recorded and rejects quietly.
        const isolated = new TransportStub('loader');
        isolated.failNextSendOnce();
        transportStub.current = isolated;
        loadLoader();
        await flush();
        isolated.emitJoin('host');
        await flush();
        expect(isolated.sent).toHaveLength(1);

        // The loader repeats the hello; this one reaches the desktop, which answers.
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS);
        expect(isolated.sent).toHaveLength(2);
        expect(isolated.sent.map(({ message }) => (message as { t: string }).t)).toEqual(['hello', 'hello']);
        isolated.receiveFromPeer(
            { t: 'hello', version: '9.9.9', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();

        // The loader redirects and never shows offline, and the repeat has stopped.
        expect(navigated).toEqual(['./9.9.9/index.html#k=the-key']);
        expect(document.getElementById('root')?.textContent).not.toContain('offline');
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS * 3);
        expect(isolated.sent).toHaveLength(2);
        expect(isolated.left).toBe(false);
    });

    test('the hello repeats to a waiting peer only until the loader settles on offline', async () => {
        const transport = transportStub.current as TransportStub;
        loadLoader();
        await flush();
        transport.emitJoin('host');
        await flush();
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS * 2);
        expect(transport.sent).toHaveLength(3);

        await jest.advanceTimersByTimeAsync(15_000);
        expect(document.getElementById('root')?.textContent).toContain('offline, or this link was reset');
        const afterSettle = transport.sent.length;
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS * 3);
        expect(transport.sent).toHaveLength(afterSettle);
    });

    test('a peer that left is no longer announced to', async () => {
        const transport = transportStub.current as TransportStub;
        loadLoader();
        await flush();
        transport.emitJoin('gone');
        await flush();
        transport.emitLeave('gone');
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS * 2);
        expect(transport.sent).toHaveLength(1);
    });

    test('another join failure reads as offline-or-reset when the wait runs out', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoinError('handshake timed out after 14000ms', 'host');
        await flush();
        expect(transport.left).toBe(false);
        expect(navigated).toEqual([]);

        await jest.advanceTimersByTimeAsync(HOST_ANSWER_TIMEOUT_MS);
        expect(transport.left).toBe(true);
        expect(document.getElementById('root')?.textContent).toContain('offline, or this link was reset');
    });

    test("the Android app's Disconnect is installed once there is a key, before the connection is tried", async () => {
        installPhoneDisconnect.mockClear();
        loadLoader();
        await flush();
        expect(installPhoneDisconnect).toHaveBeenCalledTimes(1);
    });

    test('no key in the link says to scan the QR code', async () => {
        window.location.hash = '';
        installPhoneDisconnect.mockClear();
        loadLoader();
        await flush();
        expect(installPhoneDisconnect).not.toHaveBeenCalled();
        expect(navigated).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('Scan the QR code on your computer to pair');
    });

    test('a document without the root element renders nothing', async () => {
        document.body.innerHTML = '';
        window.location.hash = '';
        loadLoader();
        await flush();
        expect(document.getElementById('root')).toBeNull();
    });

    test('a second hello after the navigation started changes nothing', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '9.9.9', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(navigated).toEqual(['./1.2.3/index.html#k=the-key']);
    });

    test('a version probe that cannot run navigates anyway; a room that refuses us says offline', async () => {
        g.fetch = async () => {
            throw new Error('no network');
        };
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(navigated).toEqual(['./1.2.3/index.html#k=the-key']);
    });

    test('the wait running out while the version probe is still pending changes nothing', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        // The desktop's answer starts the version probe; this probe never comes back.
        g.fetch = () => new Promise<Response>(() => undefined);
        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(navigated).toEqual([]);

        // The wait runs out mid-probe: the loader has already settled on the hello, so the
        // timeout's settle finds it done and returns without leaving or changing the notice.
        await jest.advanceTimersByTimeAsync(HOST_ANSWER_TIMEOUT_MS);
        expect(transport.left).toBe(false);
        expect(document.getElementById('root')?.textContent).toContain('Connecting to your computer');
        // The dangling probe is dropped with the fetch mock in the harness's afterEach.
    });

    test('a transport that cannot be built says the computer is offline', async () => {
        transportStub.current = new Error('no webrtc');
        loadLoader();
        await flush();
        expect(document.getElementById('root')?.textContent).toContain('offline, or this link was reset');
    });

    test('the notice screen shows from the first moment, before the room is joined', async () => {
        loadLoader();
        // Not even the transport has been awaited yet.
        expect(document.getElementById('root')?.textContent).toContain('Connecting to your computer');
        await flush();
        expect(document.getElementById('root')?.textContent).toContain('Connecting to your computer');
    });

    test('inside the Android app Disconnect shows while connecting, because it is installed before the first render', async () => {
        androidApp.current = true;
        loadLoader();
        expect(document.getElementById('root')?.textContent).toContain('Connecting to your computer');
        expect(document.querySelector('button')?.textContent).toBe('Disconnect');
    });

    test('a browser tab shows no Disconnect while connecting', async () => {
        loadLoader();
        expect(document.querySelector('button')).toBeNull();
    });

    test('the loader announces itself as the loader, so the desktop gives it no phone slot', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        const hello = transport.sent.find(({ message }) => (message as { t: string }).t === 'hello');
        expect(hello?.message).toEqual({
            t: 'hello',
            version: PAGE_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            host: false,
            role: 'loader',
        });
    });

    test.each(['../../etc/passwd', '1.2', '1.2.3/../x', 'latest', '1.2.3 ', '<script>', '1.2.3-'])(
        'a hello whose version %p is not a release version is ignored, and nothing is probed or navigated',
        async (version) => {
            loadLoader();
            await flush();
            const transport = transportStub.current as TransportStub;
            transport.emitJoin('host');
            await flush();
            transport.receiveFromPeer({ t: 'hello', version, protocolVersion: PROTOCOL_VERSION, host: true }, 'host');
            await flush();
            expect(fetchCalls).toEqual([]);
            expect(navigated).toEqual([]);
            // A real answer still gets through afterwards.
            transport.receiveFromPeer(
                { t: 'hello', version: '1.2.3-beta.4', protocolVersion: PROTOCOL_VERSION, host: true },
                'host',
            );
            await flush();
            expect(navigated).toEqual(['./1.2.3-beta.4/index.html#k=the-key']);
        },
    );

    test('a desktop newer than every page the site carries says the page is not published yet', async () => {
        headOk = false;
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '999.0.0', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(navigated).toEqual([]);
        // A browser tab cannot update an app: the site just has not published the version's page yet.
        expect(transport.left).toBe(true);
        expect(document.getElementById('root')?.textContent).toContain('not published yet');
        expect(document.getElementById('root')?.textContent).not.toContain('on your computer');
    });

    test('inside the Android app a desktop newer than every page it carries says to update this app', async () => {
        androidApp.current = true;
        headOk = false;
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '999.0.0', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(navigated).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('Update this app');
    });

    test("a fellow phone's failed connection does not end the wait while the desktop is still pending", async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        // The fellow phone never joined: trystero reports its failed attempt with its id, and it was
        // never a candidate for the desktop.
        transport.emitJoinError('handshake timed out after 14000ms', 'fellow');
        await flush();
        expect(transport.left).toBe(false);
        expect(document.getElementById('root')?.textContent).toContain('Connecting to your computer');

        // The announce to the desktop keeps repeating, and its answer still moves the loader on.
        const before = transport.sent.length;
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS);
        expect(transport.sent.length).toBeGreaterThan(before);
        expect(transport.sent.at(-1)?.target).toBe('host');
        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(navigated).toEqual(['./1.2.3/index.html#k=the-key']);
    });

    test('join errors never settle the loader on their own; the wait running out does', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        // No peer ever joined: neither failure says anything about the desktop, which may still connect.
        transport.emitJoinError('handshake timed out after 14000ms', 'fellow');
        transport.emitJoinError('handshake timed out after 14000ms', 'host');
        await flush();
        expect(transport.left).toBe(false);
        expect(document.getElementById('root')?.textContent).toContain('Connecting to your computer');

        await jest.advanceTimersByTimeAsync(HOST_ANSWER_TIMEOUT_MS);
        expect(transport.left).toBe(true);
        expect(document.getElementById('root')?.textContent).toContain('offline, or this link was reset');
    });

    test("a fellow phone's join error before the desktop's peer has joined keeps the loader waiting", async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoinError('handshake timed out after 14000ms', 'fellow');
        await flush();
        // Nobody has joined, so the failure says nothing about the desktop: the wait goes on.
        expect(transport.left).toBe(false);
        expect(document.getElementById('root')?.textContent).toContain('Connecting to your computer');

        // The desktop then joins, the announce reaches it, and its answer moves the loader on.
        transport.emitJoin('host');
        await flush();
        expect(transport.sent.some(({ target }) => target === 'host')).toBe(true);
        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(navigated).toEqual(['./1.2.3/index.html#k=the-key']);
    });

    test("an announced fellow phone's SDP failure does not say try Wi-Fi when the wait runs out", async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('fellow');
        await flush();
        // The fellow announces itself as no desktop: its own connection trouble on cellular is not
        // the desktop's failing connection, so it must not become the try-Wi-Fi notice.
        transport.receiveFromPeer(
            { t: 'hello', version: PAGE_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'fellow',
        );
        await flush();
        transport.emitJoinError(
            'could not connect to peer 3b6a after exchanging SDP; configure TURN servers with turnConfig or rtcConfig.iceServers',
            'fellow',
        );
        await flush();
        expect(transport.left).toBe(false);

        await jest.advanceTimersByTimeAsync(HOST_ANSWER_TIMEOUT_MS);
        expect(transport.left).toBe(true);
        const text = document.getElementById('root')?.textContent ?? '';
        expect(text).toContain('offline, or this link was reset');
        expect(text).not.toContain('try Wi-Fi');
    });

    test('a Latvian browser gets the Latvian notice', async () => {
        const language = Object.getOwnPropertyDescriptor(window.navigator, 'language');
        Object.defineProperty(window.navigator, 'language', { value: 'lv-LV', configurable: true });
        try {
            loadLoader();
            await flush();
            expect(document.getElementById('root')?.textContent).toContain('Izveido savienojumu ar tavu datoru');
        } finally {
            if (language) Object.defineProperty(window.navigator, 'language', language);
            else delete (window.navigator as { language?: string }).language;
        }
    });
});
