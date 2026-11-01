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
