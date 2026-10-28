/**
 * scripts/web-server.ts — the `pnpm web` entry: parses --port and starts the
 * web shell on the built dist/. startWebServer is mocked; requiring the script
 * never starts anything (runIfMain). Signal behavior is tested by handler
 * capture (the process.once spy passes through, the captured handler is
 * invoked) — a real SIGINT would kill the Jest runner.
 */

import type * as scriptModule from '../../scripts/web-server';
import type * as serverModule from '../../src/ts/web/server';

jest.mock('../../src/ts/web/server', () => ({ startWebServer: jest.fn() }));

const { main, parsePort } = require('../../scripts/web-server') as typeof scriptModule;
const server = jest.mocked(require('../../src/ts/web/server') as typeof serverModule);

type Started = Awaited<ReturnType<typeof serverModule.startWebServer>>;

describe('scripts/web-server.ts', () => {
    let logSpy: jest.SpiedFunction<typeof console.log>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;
    let onceSpy: jest.SpiedFunction<typeof process.once>;
    let exitSpy: jest.SpiedFunction<typeof process.exit>;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        onceSpy = jest.spyOn(process, 'once');
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        server.startWebServer.mockReset();
    });

    afterEach(() => {
        // The signal handlers main() registered really are attached (the spy passes through): take
        // them off again, or a later test's exit assertions collide with them.
        for (const [event, listener] of onceSpy.mock.calls) process.removeListener(event, listener);
        jest.restoreAllMocks();
        process.exitCode = undefined;
    });

    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    /** The handler main() gave process.once for a signal. */
    const signalHandler = (signal: NodeJS.Signals): (() => void) => {
        const call = onceSpy.mock.calls.find(([event]) => event === signal);
        if (!call) throw new Error(`main registered no ${signal} handler`);
        return call[1] as () => void;
    };

    /** A started-server answer for the startWebServer mock, its close chain gated for the test. */
    const startedStub = (
        stop: () => Promise<void> = async () => undefined,
        whenClosed: () => Promise<void> = async () => undefined,
    ): Started => ({
        server: jest.requireActual<typeof import('node:http')>('node:http').createServer(),
        token: 'abc123',
        url: 'http://localhost:4400/#t=abc123',
        stop,
        whenClosed,
    });

    test('parsePort: default, explicit, and out-of-range or non-numeric values', () => {
        expect(parsePort([])).toBe(4400);
        expect(parsePort(['--port=8080'])).toBe(8080);
        expect(parsePort(['--port=0'])).toBe(0);
        expect(parsePort(['--port=70000'])).toBeNull();
        expect(parsePort(['--port=-1'])).toBeNull();
        expect(parsePort(['--port=abc'])).toBeNull();
    });

    test('main starts the server on dist/ and prints its URL, token fragment included, to stdout', async () => {
        server.startWebServer.mockResolvedValue(startedStub());
        await main(['--port=4400']);
        expect(server.startWebServer).toHaveBeenCalledWith({ port: 4400, distDir: expect.stringMatching(/dist$/) });
        expect(logSpy).toHaveBeenCalledWith('GuruShots Auto Vote web UI: http://localhost:4400/#t=abc123');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test.each(['SIGINT', 'SIGTERM'] as const)(
        '%s stops the server and exits only after its close chain has settled',
        async (signal) => {
            let releaseClosed: () => void = () => undefined;
            const whenClosed = jest.fn(() => new Promise<void>((resolve) => (releaseClosed = resolve)));
            const stop = jest.fn(whenClosed);
            server.startWebServer.mockResolvedValue(startedStub(stop, whenClosed));
            await main(['--port=4400']);
            expect(exitSpy).not.toHaveBeenCalled();

            signalHandler(signal)();
            await tick();
            expect(stop).toHaveBeenCalledTimes(1);
            expect(exitSpy).not.toHaveBeenCalled();

            releaseClosed();
            await tick();
            await tick();
            expect(exitSpy).toHaveBeenCalledWith(0);
        },
    );

    test('a stop of the server itself (after a local-data wipe) also exits only after the close chain', async () => {
        let releaseClosed: () => void = () => undefined;
        const whenClosed = jest.fn(() => new Promise<void>((resolve) => (releaseClosed = resolve)));
        const stub = startedStub(async () => undefined, whenClosed);
        server.startWebServer.mockResolvedValue(stub);
        await main(['--port=4400']);
        expect(exitSpy).not.toHaveBeenCalled();

        stub.server.emit('close');
        await tick();
        expect(exitSpy).not.toHaveBeenCalled();

        releaseClosed();
        await tick();
        await tick();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('a signal arriving before startWebServer resolves exits directly, with nothing to stop', async () => {
        const stop = jest.fn(async () => undefined);
        let answerStart: (started: Started) => void = () => undefined;
        server.startWebServer.mockImplementationOnce(() => new Promise<Started>((resolve) => (answerStart = resolve)));

        const running = main(['--port=4400']);
        await tick();
        signalHandler('SIGINT')();
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(stop).not.toHaveBeenCalled();

        answerStart(startedStub(stop));
        await running;
    });

    test('the signal handlers are registered with process.once, so a second signal during the settle wait terminates at once', async () => {
        let releaseClosed: () => void = () => undefined;
        const whenClosed = jest.fn(() => new Promise<void>((resolve) => (releaseClosed = resolve)));
        server.startWebServer.mockResolvedValue(startedStub(whenClosed, whenClosed));
        await main(['--port=4400']);

        // The first Ctrl-C enters the close chain's settle wait and stays there.
        signalHandler('SIGINT')();
        await tick();
        expect(exitSpy).not.toHaveBeenCalled();
        // Each signal's handler went through process.once exactly once (the runner itself also
        // registers SIGINT handlers — that is why the launcher's registration mode is read off the
        // spy's calls, not off process.listeners). Node consumes a once handler on delivery, so a
        // second signal takes the default path and ends the process, giving up the pending clear.
        expect(onceSpy.mock.calls.filter(([event]) => event === 'SIGINT')).toHaveLength(1);
        expect(onceSpy.mock.calls.filter(([event]) => event === 'SIGTERM')).toHaveLength(1);

        releaseClosed();
        await tick();
        await tick();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('main explains a taken port, and reports any other start failure — the signal handlers come off', async () => {
        const removeListenerSpy = jest.spyOn(process, 'removeListener');
        server.startWebServer.mockRejectedValueOnce(
            Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }),
        );
        await main(['--port=4400']);
        expect(errorSpy).toHaveBeenLastCalledWith(
            'Port 4400 is already in use. Pick another with --port=<n> (0 = any free port).',
        );
        expect(process.exitCode).toBe(1);

        server.startWebServer.mockRejectedValueOnce(new Error('EACCES'));
        await main(['--port=80']);
        expect(errorSpy).toHaveBeenLastCalledWith('Could not start the web UI: EACCES');

        server.startWebServer.mockRejectedValueOnce('boom');
        await main([]);
        expect(errorSpy).toHaveBeenLastCalledWith('Could not start the web UI: boom');

        expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', signalHandler('SIGINT'));
        expect(removeListenerSpy).toHaveBeenCalledWith('SIGTERM', signalHandler('SIGTERM'));
    });

    test('main refuses a bad --port with a usage line and a failing exit code', async () => {
        await main(['--port=nope']);
        expect(server.startWebServer).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith('Usage: pnpm web [--port=<0-65535>]');
        expect(process.exitCode).toBe(1);
    });

    test('main defaults to the process arguments', async () => {
        const argv = process.argv;
        process.argv = ['node', 'scripts/web-server.ts', '--port=x'];
        try {
            await main();
        } finally {
            process.argv = argv;
        }
        expect(process.exitCode).toBe(1);
    });
});
