/**
 * The shared hello repeat (core/remote/helloRepeat.ts): a joined peer is announced to at once and
 * again every interval while the owner still waits for the desktop; a left peer, a stopped repeat
 * and an owner that stopped waiting end it; a lost send never throws.
 */

import { createHelloRepeater, HELLO_RETRY_MS } from '../../src/ts/core/remote/helloRepeat';
import { PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';

import type { HelloMessage } from '../../src/ts/core/remote/protocol';

const announce: HelloMessage = { t: 'hello', version: '1.0.0', protocolVersion: PROTOCOL_VERSION, host: false };

describe('createHelloRepeater', () => {
    let sent: Array<{ message: unknown; target?: string }>;
    let waiting: boolean;
    let sendFails: boolean;
    const transport = {
        send: (message: unknown, target?: string): Promise<void> => {
            sent.push({ message, target });
            return sendFails ? Promise.reject(new Error('lost on the relay')) : Promise.resolve();
        },
    };
    const make = () => createHelloRepeater({ transport, announce, active: () => waiting });

    beforeEach(() => {
        jest.useFakeTimers();
        sent = [];
        waiting = true;
        sendFails = false;
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('announces to a joined peer at once, then every interval to each peer still waiting', () => {
        const hello = make();
        hello.join('a');
        expect(sent).toEqual([{ message: announce, target: 'a' }]);
        hello.join('b');
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        expect(sent.map(({ target }) => target)).toEqual(['a', 'b', 'a', 'b']);
        hello.stop();
    });

    test('one timer serves every peer: a second join starts no second repeat', () => {
        const hello = make();
        hello.join('a');
        hello.join('b');
        sent.length = 0;
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        expect(sent).toHaveLength(2);
        hello.stop();
    });

    test('a peer that left is dropped from the repeat', () => {
        const hello = make();
        hello.join('a');
        hello.join('b');
        hello.leave('a');
        sent.length = 0;
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        expect(sent.map(({ target }) => target)).toEqual(['b']);
        hello.stop();
    });

    test('stop ends the repeat; a later join starts it again while the owner still waits', () => {
        const hello = make();
        hello.join('a');
        hello.stop();
        hello.stop(); // nothing to stop is fine
        sent.length = 0;
        jest.advanceTimersByTime(HELLO_RETRY_MS * 3);
        expect(sent).toEqual([]);

        hello.join('b');
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        // 'a' is still waiting: stop leaves the peers alone, clear forgets them.
        expect(sent.map(({ target }) => target)).toEqual(['b', 'a', 'b']);
        hello.stop();
    });

    test('clear forgets every waiting peer', () => {
        const hello = make();
        hello.join('a');
        hello.clear();
        hello.join('b');
        sent.length = 0;
        jest.advanceTimersByTime(HELLO_RETRY_MS);
        expect(sent.map(({ target }) => target)).toEqual(['b']);
        hello.stop();
    });

    test('an owner that no longer waits gets the one announce and no repeat', () => {
        waiting = false;
        const hello = make();
        hello.join('a');
        jest.advanceTimersByTime(HELLO_RETRY_MS * 3);
        expect(sent).toEqual([{ message: announce, target: 'a' }]);
    });

    test('announceOnce says hello to one peer, with no repeat and no waiting set; a lost send is swallowed', async () => {
        const repeater = make();
        repeater.announceOnce('p1');
        expect(sent).toEqual([{ message: announce, target: 'p1' }]);
        jest.advanceTimersByTime(HELLO_RETRY_MS * 3);
        expect(sent).toHaveLength(1);
        sendFails = true;
        repeater.announceOnce('p1');
        await Promise.resolve();
        expect(sent).toHaveLength(2);
    });

    test('a send the relay lost is swallowed, and the repeat goes on', async () => {
        sendFails = true;
        const hello = make();
        hello.join('a');
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS);
        expect(sent).toHaveLength(2);
        hello.stop();
    });
});
