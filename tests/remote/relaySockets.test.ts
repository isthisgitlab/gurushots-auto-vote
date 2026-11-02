/**
 * The relay link's own WebSockets: one per relay, the same signed event to every open one, a
 * listening set of at most three that moves on when a listening relay closes, reconnects with a
 * capped backoff, and only its own subscription's frames.
 */

import { RELAY_CONTENT_MAX_BYTES } from '../../src/ts/core/remote/relayWire';
import {
    COOLDOWN_BASE_MS,
    COPY_MEMORY_MS,
    MAX_PENDING_DIGESTS,
    MAX_REMEMBERED_COPIES,
    COOLDOWN_MAX_MS,
    MAX_SUBSCRIBED_RELAYS,
    listeningLimit,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS,
    RELAY_SUB_ID,
    createRelaySockets,
} from '../../src/ts/core/remote/relaySockets';

import type { SocketLike } from '../../src/ts/core/remote/relaySockets';

class FakeSocket implements SocketLike {
    readyState = 0;
    sent: string[] = [];
    closeCalled = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {}
    send(data: string): void {
        this.sent.push(data);
    }
    close(): void {
        this.closeCalled = true;
    }
    open(): void {
        this.readyState = 1;
        this.onopen?.();
    }
    receive(data: unknown): void {
        this.onmessage?.({ data });
    }
    serverClose(): void {
        this.readyState = 3;
        this.onclose?.();
    }
}

const URLS = ['wss://a', 'wss://b', 'wss://c', 'wss://d', 'wss://e'] as const;
const TOPIC = 'the-topic';
const REQ = `REQ|${RELAY_SUB_ID}|${TOPIC}`;

describe('createRelaySockets', () => {
    let sockets: FakeSocket[];
    let refusals: Array<[string, string]>;
    let io: ReturnType<typeof createRelaySockets>;
    // The signed frame carries our pubkey, as trystero's createEvent output does.
    const OWN_PUBKEY = 'a'.repeat(64);
    const FOREIGN_PUBKEY = 'b'.repeat(64);
    const signed = (topic: string, content: string): string => `EVENT|${topic}|${content}|"pubkey":"${OWN_PUBKEY}"`;
    const createEvent = jest.fn(async (topic: string, content: string) => signed(topic, content));

    const latest = (url: string): FakeSocket => sockets.filter((socket) => socket.url === url).at(-1) as FakeSocket;
    const openAll = (): void => {
        for (const url of URLS) latest(url).open();
    };
    const reqs = (socket: FakeSocket): number => socket.sent.filter((frame) => frame === REQ).length;

    beforeEach(() => {
        jest.useFakeTimers();
        sockets = [];
        refusals = [];
        createEvent.mockClear();
        io = createRelaySockets({
            now: () => Date.now(),
            hash: async (text) => text,
            urls: URLS,
            createSocket: (url) => {
                const socket = new FakeSocket(url);
                sockets.push(socket);
                return socket;
            },
            createEvent,
            subscribeFrame: (subId, topic) => `REQ|${subId}|${topic}`,
            onRefused: (url, reason) => refusals.push([url, reason]),
        });
    });
    afterEach(() => {
        io.close();
        jest.useRealTimers();
    });

    test('a host listens on every relay and a phone on up to three', () => {
        expect(listeningLimit('host', URLS.length)).toBe(URLS.length);
        expect(listeningLimit('host', 9)).toBe(9);
        expect(listeningLimit('phone', URLS.length)).toBe(MAX_SUBSCRIBED_RELAYS);
        expect(listeningLimit('phone', 2)).toBe(2); // never more than there are relays
        expect(listeningLimit('phone', 1)).toBe(1);
    });

    test('opens one socket per relay, in list order', () => {
        expect(sockets.map((socket) => socket.url)).toEqual([...URLS]);
    });

    describe('listening', () => {
        test(`listens on the first ${MAX_SUBSCRIBED_RELAYS} open relays and publishes to all`, () => {
            io.subscribe(TOPIC);
            openAll();
            expect(URLS.map((url) => reqs(latest(url)))).toEqual([1, 1, 1, 0, 0]);
        });

        test('a host listens on every open relay when it asks to', () => {
            io.close();
            sockets.length = 0;
            io = createRelaySockets({
                urls: URLS,
                maxListening: URLS.length,
                createSocket: (url) => {
                    const socket = new FakeSocket(url);
                    sockets.push(socket);
                    return socket;
                },
                createEvent,
                subscribeFrame: (subId, topic) => `REQ|${subId}|${topic}`,
            });
            io.subscribe(TOPIC);
            openAll();
            expect(URLS.map((url) => reqs(latest(url)))).toEqual([1, 1, 1, 1, 1]);
        });

        test('subscribing after the sockets are open sends the requests then', () => {
            openAll();
            expect(sockets.every((socket) => socket.sent.length === 0)).toBe(true);
            io.subscribe(TOPIC);
            expect(URLS.map((url) => reqs(latest(url)))).toEqual([1, 1, 1, 0, 0]);
        });

        test('the places go to the first three relays that open; a relay that is not open takes none', () => {
            io.subscribe(TOPIC);
            latest('wss://c').open();
            latest('wss://e').open();
            latest('wss://a').open();
            latest('wss://d').open(); // the set already holds c, e and a
            expect(URLS.map((url) => reqs(latest(url)))).toEqual([1, 0, 1, 0, 1]);
        });

        test('when a listening relay closes the next open one takes over', () => {
            io.subscribe(TOPIC);
            openAll();
            latest('wss://b').serverClose();
            expect(reqs(latest('wss://d'))).toBe(1);
            expect(reqs(latest('wss://e'))).toBe(0);
        });

        test('a relay that reconnects while the set is full is not listened on; one that finds a free place is', () => {
            io.subscribe(TOPIC);
            openAll();
            latest('wss://b').serverClose(); // d takes over
            jest.advanceTimersByTime(RECONNECT_BASE_MS);
            latest('wss://b').open(); // a, c, d listen: b stays out
            expect(reqs(latest('wss://b'))).toBe(0);
            latest('wss://a').serverClose(); // a's place goes to the first open relay left: b
            expect(reqs(latest('wss://b'))).toBe(1);
        });

        test('a reconnected relay is asked to listen again on its new socket', () => {
            io.subscribe(TOPIC);
            latest('wss://a').open();
            latest('wss://a').serverClose();
            jest.advanceTimersByTime(RECONNECT_BASE_MS);
            latest('wss://a').open();
            expect(reqs(latest('wss://a'))).toBe(1);
        });
    });

    describe('opening', () => {
        test('tells the listeners each time a socket opens, until they unsubscribe', () => {
            const opened: string[] = [];
            const off = io.onOpen(() => opened.push('one'));
            io.onOpen(() => opened.push('two'));
            latest('wss://a').open();
            off();
            latest('wss://b').open();
            expect(opened).toEqual(['one', 'two', 'two']);
        });

        test('the listeners hear of a socket only after it has taken its place in the listening set', () => {
            io.subscribe(TOPIC);
            let reqsAtOpen = -1;
            io.onOpen(() => {
                reqsAtOpen = reqs(latest('wss://a'));
            });
            latest('wss://a').open();
            expect(reqsAtOpen).toBe(1);
        });
    });

    describe('publishing', () => {
        test('signs once and sends the same string to every open relay and no other', async () => {
            io.subscribe(TOPIC);
            latest('wss://a').open();
            latest('wss://c').open();
            await io.publish(TOPIC, 'payload');
            expect(createEvent).toHaveBeenCalledTimes(1);
            expect(createEvent).toHaveBeenCalledWith(TOPIC, 'payload');
            const event = signed(TOPIC, 'payload');
            expect(URLS.map((url) => latest(url).sent.includes(event))).toEqual([true, false, true, false, false]);
        });

        test('with no relay open, publishing fails', async () => {
            await expect(io.publish(TOPIC, 'payload')).rejects.toThrow('No relay is connected.');
        });

        test('after close, publishing fails even if a socket still looks open', async () => {
            latest('wss://a').open();
            io.close();
            await expect(io.publish(TOPIC, 'payload')).rejects.toThrow('No relay is connected.');
        });
    });

    describe('a relay that refuses our events', () => {
        const refuse = (url: string, reason: string): void =>
            latest(url).receive(JSON.stringify(['OK', 'id', false, reason]));
        const publishedTo = (url: string, marker: string): boolean =>
            latest(url).sent.some((f) => f.includes(`|${marker}|`));
        const publish = async (marker: string): Promise<void> => {
            await io.publish(TOPIC, marker);
        };

        test.each([
            'rate-limited: slow down',
            'blocked: no',
            'banned: too many',
            'restricted: x',
            'pow: x',
            'auth-required: x',
        ])(
            'a "%s" refusal stops events to that relay, not to the others, and keeps its socket and subscription',
            async (reason) => {
                io.subscribe(TOPIC);
                openAll();
                refuse('wss://a', reason);
                await publish('one');
                expect(publishedTo('wss://a', 'one')).toBe(false);
                expect(publishedTo('wss://b', 'one')).toBe(true);
                expect(latest('wss://a').closeCalled).toBe(false);
                expect(reqs(latest('wss://a'))).toBe(1);
            },
        );

        test('the cooldown is 60 s, then the relay gets events again', async () => {
            openAll();
            refuse('wss://a', 'rate-limited: x');
            jest.advanceTimersByTime(COOLDOWN_BASE_MS - 1);
            await publish('early');
            expect(publishedTo('wss://a', 'early')).toBe(false);
            jest.advanceTimersByTime(1);
            await publish('later');
            expect(publishedTo('wss://a', 'later')).toBe(true);
        });

        test('each new refusal doubles the cooldown up to 15 minutes', async () => {
            openAll();
            let expected = COOLDOWN_BASE_MS;
            for (let round = 0; round < 7; round++) {
                refuse('wss://a', 'banned: try again later');
                jest.advanceTimersByTime(expected - 1);
                await publish(`early-${round}`);
                expect(publishedTo('wss://a', `early-${round}`)).toBe(false);
                jest.advanceTimersByTime(1);
                await publish(`later-${round}`);
                expect(publishedTo('wss://a', `later-${round}`)).toBe(true);
                expected = Math.min(expected * 2, COOLDOWN_MAX_MS);
            }
            expect(expected).toBe(COOLDOWN_MAX_MS);
        });

        test('a reply that arrives during the cooldown is the same refusal: it does not double it', async () => {
            openAll();
            refuse('wss://a', 'rate-limited: x');
            jest.advanceTimersByTime(1_000);
            refuse('wss://a', 'rate-limited: x'); // an event sent before the cooldown began
            jest.advanceTimersByTime(COOLDOWN_BASE_MS - 1_000);
            await publish('after-60s');
            expect(publishedTo('wss://a', 'after-60s')).toBe(true);
        });

        test('an OK true from that relay resets the cooldown to its start', async () => {
            openAll();
            refuse('wss://a', 'rate-limited: x'); // 60 s, next 120 s
            jest.advanceTimersByTime(COOLDOWN_BASE_MS);
            latest('wss://a').receive(JSON.stringify(['OK', 'id', true, '']));
            refuse('wss://a', 'rate-limited: x'); // back to 60 s, not 120 s
            jest.advanceTimersByTime(COOLDOWN_BASE_MS);
            await publish('reset');
            expect(publishedTo('wss://a', 'reset')).toBe(true);
        });

        test('an OK true ends a cooldown that is still running', async () => {
            openAll();
            refuse('wss://a', 'rate-limited: x');
            latest('wss://a').receive(JSON.stringify(['OK', 'id', true, '']));
            await publish('now');
            expect(publishedTo('wss://a', 'now')).toBe(true);
        });

        test.each(['duplicate: have this event', 'invalid: bad signature', 'error: oops', ''])(
            'a "%s" refusal starts no cooldown',
            async (reason) => {
                openAll();
                refuse('wss://a', reason);
                await publish('still');
                expect(publishedTo('wss://a', 'still')).toBe(true);
                expect(refusals).toEqual([['wss://a', reason]]);
            },
        );

        test('publishing fails when every open relay is in cooldown, and works again after it', async () => {
            latest('wss://a').open();
            latest('wss://b').open();
            refuse('wss://a', 'banned: x');
            refuse('wss://b', 'rate-limited: x');
            await expect(publish('none')).rejects.toThrow('No relay is connected.');
            jest.advanceTimersByTime(COOLDOWN_BASE_MS);
            await publish('back');
            expect(publishedTo('wss://a', 'back') && publishedTo('wss://b', 'back')).toBe(true);
        });

        test('the real clock is used when none is given', async () => {
            const own = createRelaySockets({
                urls: ['wss://own'],
                createSocket: (url) => {
                    const socket = new FakeSocket(url);
                    sockets.push(socket);
                    return socket;
                },
                createEvent,
                subscribeFrame: (subId, topic) => `REQ|${subId}|${topic}`,
            });
            const socket = latest('wss://own');
            socket.open();
            socket.receive(JSON.stringify(['OK', 'id', false, 'banned: x']));
            await expect(own.publish(TOPIC, 'x')).rejects.toThrow('No relay is connected.');
            jest.advanceTimersByTime(COOLDOWN_BASE_MS);
            await own.publish(TOPIC, 'y');
            expect(socket.sent.some((f) => f.includes('|y|'))).toBe(true);
            own.close();
        });
    });

    describe('reconnecting', () => {
        test('a closed relay is reconnected after 1 s, then 2 s, 4 s … up to 30 s, and an open resets the wait', () => {
            const waits: number[] = [];
            let expected = RECONNECT_BASE_MS;
            for (let attempt = 0; attempt < 8; attempt++) {
                const before = sockets.length;
                latest('wss://a').serverClose();
                jest.advanceTimersByTime(expected - 1);
                expect(sockets).toHaveLength(before);
                jest.advanceTimersByTime(1);
                expect(sockets).toHaveLength(before + 1);
                waits.push(expected);
                expected = Math.min(expected * 2, RECONNECT_MAX_MS);
            }
            expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
            latest('wss://a').open();
            latest('wss://a').serverClose();
            const before = sockets.length;
            jest.advanceTimersByTime(RECONNECT_BASE_MS);
            expect(sockets).toHaveLength(before + 1);
        });

        test('close stops the reconnects and closes every socket', () => {
            openAll();
            io.close();
            expect(sockets.every((socket) => socket.closeCalled)).toBe(true);
            latest('wss://a').serverClose();
            jest.advanceTimersByTime(RECONNECT_MAX_MS * 2);
            expect(sockets).toHaveLength(URLS.length);
        });

        test('close cancels a reconnect that is already waiting', () => {
            latest('wss://a').serverClose();
            io.close();
            jest.advanceTimersByTime(RECONNECT_MAX_MS);
            expect(sockets).toHaveLength(URLS.length);
        });
    });

    describe('receiving', () => {
        let nextId = 0;
        const event = (
            content: unknown,
            subId: unknown = RELAY_SUB_ID,
            fields: Record<string, unknown> = { id: `id-${nextId++}`, pubkey: FOREIGN_PUBKEY },
        ): string => JSON.stringify(['EVENT', subId, { content, ...fields }]);

        /** Lets the content digest settle: the tests hash with an async identity, so a few microtasks do. */
        const settle = async (): Promise<void> => {
            for (let i = 0; i < 10; i++) await Promise.resolve();
        };

        test('hands the content of an event on its own subscription to every listener', async () => {
            const seen: string[] = [];
            const off = io.onEvent((content) => seen.push(`one:${content}`));
            io.onEvent((content) => seen.push(`two:${content}`));
            latest('wss://a').receive(event('abc'));
            await settle();
            off();
            latest('wss://b').receive(event('def'));
            await settle();
            expect(seen).toEqual(['one:abc', 'two:abc', 'two:def']);
        });

        test('ignores what is not ours: another subscription, a non-text frame, bad JSON, a non-array, a bad event', async () => {
            const seen: string[] = [];
            io.onEvent((content) => seen.push(content));
            const socket = latest('wss://a');
            socket.receive(event('x', 'someone-else'));
            socket.receive(new Uint8Array(3));
            socket.receive('not json');
            socket.receive('{"a":1}');
            socket.receive(JSON.stringify(['EVENT', RELAY_SUB_ID, 'not an object']));
            socket.receive(event(42));
            socket.receive(event('x'.repeat(RELAY_CONTENT_MAX_BYTES + 1)));
            socket.receive(JSON.stringify(['NOTICE', 'hello']));
            socket.receive(JSON.stringify(['EOSE', RELAY_SUB_ID]));
            await settle();
            expect(seen).toEqual([]);
            socket.receive(event('x'.repeat(RELAY_CONTENT_MAX_BYTES)));
            await settle();
            expect(seen).toHaveLength(1);
        });

        test("an exact duplicate of a delivered content (a second relay's copy) is dropped before anything decrypts it, until it is forgotten", async () => {
            const seen: string[] = [];
            io.onEvent((content) => seen.push(content));
            // Three relays deliver the same event, each under the id it chooses to give it.
            latest('wss://a').receive(event('x'));
            latest('wss://b').receive(event('x'));
            latest('wss://c').receive(event('x'));
            await settle();
            expect(seen).toEqual(['x']);
            jest.advanceTimersByTime(COPY_MEMORY_MS);
            latest('wss://a').receive(event('x'));
            await settle();
            expect(seen).toEqual(['x', 'x']);
        });

        test('a forged event that borrows the id of a real one does not block the real one', async () => {
            const seen: string[] = [];
            io.onEvent((content) => seen.push(content));
            latest('wss://e').receive(event('forged', RELAY_SUB_ID, { id: 'real-id', pubkey: FOREIGN_PUBKEY }));
            latest('wss://a').receive(event('real', RELAY_SUB_ID, { id: 'real-id', pubkey: FOREIGN_PUBKEY }));
            await settle();
            expect(seen).toEqual(['forged', 'real']);
        });

        test("the relay's event id plays no part: an event without one is delivered like any other", async () => {
            const seen: string[] = [];
            io.onEvent((content) => seen.push(content));
            latest('wss://a').receive(event('no-id', RELAY_SUB_ID, { pubkey: FOREIGN_PUBKEY }));
            await settle();
            expect(seen).toEqual(['no-id']);
        });

        test('our own events, echoed back by a relay, are dropped before anything decrypts them', async () => {
            const seen: string[] = [];
            io.onEvent((content) => seen.push(content));
            openAll();
            // Before we have signed anything we do not know our pubkey: an event from anybody is passed on.
            latest('wss://a').receive(event('early'));
            await io.publish(TOPIC, 'payload');
            latest('wss://a').receive(event('echo', RELAY_SUB_ID, { id: 'e1', pubkey: OWN_PUBKEY }));
            latest('wss://b').receive(event('echo', RELAY_SUB_ID, { id: 'e2', pubkey: OWN_PUBKEY }));
            latest('wss://a').receive(event('foreign'));
            await settle();
            expect(seen).toEqual(['early', 'foreign']);
        });

        test('a forged event that carries our pubkey is dropped and remembers nothing: the same content from a real sender still arrives', async () => {
            const seen: string[] = [];
            io.onEvent((content) => seen.push(content));
            openAll();
            await io.publish(TOPIC, 'payload');
            latest('wss://e').receive(event('target', RELAY_SUB_ID, { id: 'f', pubkey: OWN_PUBKEY }));
            await settle();
            expect(seen).toEqual([]);
            latest('wss://a').receive(event('target'));
            await settle();
            expect(seen).toEqual(['target']);
        });

        test(`remembers at most ${MAX_REMEMBERED_COPIES} contents: the oldest is forgotten, the newest is still held back`, async () => {
            const seen: string[] = [];
            io.onEvent((content) => seen.push(content));
            const socket = latest('wss://a');
            // In batches under the cap on digests in flight.
            for (let n = 0; n <= MAX_REMEMBERED_COPIES; n++) {
                socket.receive(event(`content-${n}`));
                if (n % MAX_PENDING_DIGESTS === MAX_PENDING_DIGESTS - 1) await settle();
            }
            await settle();
            expect(seen).toHaveLength(MAX_REMEMBERED_COPIES + 1);
            socket.receive(event('content-0')); // forgotten: delivered again
            socket.receive(event(`content-${MAX_REMEMBERED_COPIES}`)); // still remembered: dropped
            await settle();
            expect(seen).toHaveLength(MAX_REMEMBERED_COPIES + 2);
            expect(seen.at(-1)).toBe('content-0');
        });

        test(`computes at most ${MAX_PENDING_DIGESTS} digests at a time: the events beyond are dropped unread, and the cap frees as digests finish`, async () => {
            const hashed: string[] = [];
            const releases: Array<() => void> = [];
            const slow = createRelaySockets({
                urls: ['wss://slow'],
                hash: (text) =>
                    new Promise((resolve) => {
                        hashed.push(text);
                        releases.push(() => resolve(text));
                    }),
                createSocket: (url) => {
                    const socket = new FakeSocket(url);
                    sockets.push(socket);
                    return socket;
                },
                createEvent,
                subscribeFrame: (subId, topic) => `REQ|${subId}|${topic}`,
            });
            const seen: string[] = [];
            slow.onEvent((content) => seen.push(content));
            const socket = latest('wss://slow');
            for (let n = 0; n < MAX_PENDING_DIGESTS + 10; n++) socket.receive(event(`slow-${n}`));
            expect(hashed).toHaveLength(MAX_PENDING_DIGESTS);
            for (const release of releases.splice(0)) release();
            await settle();
            expect(seen).toHaveLength(MAX_PENDING_DIGESTS);
            socket.receive(event('after'));
            expect(hashed).toHaveLength(MAX_PENDING_DIGESTS + 1); // room again
            releases[0]();
            await settle();
            expect(seen.at(-1)).toBe('after');
            slow.close();
        });

        test('a digest that fails drops the event, delivers nothing, frees the cap and leaves no unhandled rejection', async () => {
            jest.useRealTimers(); // an unhandled rejection is reported on a real process tick
            let failing = true;
            const seen: string[] = [];
            const flaky = createRelaySockets({
                urls: ['wss://flaky'],
                hash: async (text) => {
                    if (failing) throw new Error('no crypto.subtle here');
                    return text;
                },
                createSocket: (url) => {
                    const socket = new FakeSocket(url);
                    sockets.push(socket);
                    return socket;
                },
                createEvent,
                subscribeFrame: (subId, topic) => `REQ|${subId}|${topic}`,
            });
            flaky.onEvent((content) => seen.push(content));
            const unhandled = jest.fn();
            process.on('unhandledRejection', unhandled);
            try {
                const socket = latest('wss://flaky');
                // More failures than the cap allows in flight: each one frees its place.
                for (let round = 0; round < 3; round++) {
                    for (let n = 0; n < MAX_PENDING_DIGESTS; n++) socket.receive(event(`bad-${round}-${n}`));
                    await settle();
                }
                expect(seen).toEqual([]);
                failing = false;
                socket.receive(event('good'));
                await settle();
                expect(seen).toEqual(['good']); // the cap was freed every time
                await new Promise((resolve) => setImmediate(resolve));
                expect(unhandled).not.toHaveBeenCalled();
            } finally {
                process.off('unhandledRejection', unhandled);
                flaky.close();
            }
        });

        test('by default the content is told by its SHA-256 digest', async () => {
            jest.useRealTimers();
            const seen: string[] = [];
            const plain = createRelaySockets({
                urls: ['wss://plain'],
                createSocket: (url) => {
                    const socket = new FakeSocket(url);
                    sockets.push(socket);
                    return socket;
                },
                createEvent,
                subscribeFrame: (subId, topic) => `REQ|${subId}|${topic}`,
            });
            plain.onEvent((content) => seen.push(content));
            const socket = latest('wss://plain');
            socket.receive(event('same'));
            socket.receive(event('same'));
            socket.receive(event('other'));
            const deadline = Date.now() + 2_000;
            while (seen.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
            expect([...seen].sort()).toEqual(['other', 'same']);
            plain.close();
        });

        test('a signed frame without a readable pubkey publishes all the same, and drops no echo', async () => {
            const seen: string[] = [];
            const odd = createRelaySockets({
                urls: ['wss://odd'],
                hash: async (text) => text,
                createSocket: (url) => {
                    const socket = new FakeSocket(url);
                    sockets.push(socket);
                    return socket;
                },
                createEvent: async (topic, content) => `EVENT|${topic}|${content}`,
                subscribeFrame: (subId, topic) => `REQ|${subId}|${topic}`,
            });
            odd.onEvent((content) => seen.push(content));
            latest('wss://odd').open();
            await odd.publish(TOPIC, 'x');
            latest('wss://odd').receive(event('echo?', RELAY_SUB_ID, { id: 'o1', pubkey: undefined }));
            await settle();
            expect(seen).toEqual(['echo?']);
            odd.close();
        });

        test('reports a refused event (OK false) with the relay and its reason; OK true is silent', () => {
            latest('wss://a').receive(JSON.stringify(['OK', 'id', false, 'rate-limited: slow down']));
            latest('wss://b').receive(JSON.stringify(['OK', 'id', false]));
            latest('wss://c').receive(JSON.stringify(['OK', 'id', true, '']));
            expect(refusals).toEqual([
                ['wss://a', 'rate-limited: slow down'],
                ['wss://b', ''],
            ]);
        });

        test('a relay that closes our subscription is reported, not asked again on that socket, and replaced', () => {
            io.subscribe(TOPIC);
            openAll();
            latest('wss://a').receive(JSON.stringify(['CLOSED', 'other-sub', 'ignored']));
            expect(refusals).toEqual([]);
            latest('wss://a').receive(JSON.stringify(['CLOSED', RELAY_SUB_ID, 'blocked: no']));
            expect(refusals).toEqual([['wss://a', 'blocked: no']]);
            expect(reqs(latest('wss://a'))).toBe(1);
            expect(reqs(latest('wss://d'))).toBe(1); // the replacement
            latest('wss://b').receive(JSON.stringify(['CLOSED', RELAY_SUB_ID, 5]));
            expect(refusals[1]).toEqual(['wss://b', '']);
            expect(reqs(latest('wss://e'))).toBe(1);
        });

        test('a refusal reports nothing when nobody listens for them, and a new socket may listen again', () => {
            const quiet = createRelaySockets({
                urls: ['wss://q'],
                createSocket: (url) => {
                    const socket = new FakeSocket(url);
                    sockets.push(socket);
                    return socket;
                },
                createEvent,
                subscribeFrame: (subId, topic) => `REQ|${subId}|${topic}`,
            });
            quiet.subscribe(TOPIC);
            const socket = latest('wss://q');
            socket.open();
            socket.receive(JSON.stringify(['OK', 'id', false, 'blocked: x']));
            socket.receive(JSON.stringify(['CLOSED', RELAY_SUB_ID, 'blocked: x']));
            socket.serverClose();
            jest.advanceTimersByTime(RECONNECT_BASE_MS);
            latest('wss://q').open();
            expect(reqs(latest('wss://q'))).toBe(1);
            quiet.close();
        });
    });
});
