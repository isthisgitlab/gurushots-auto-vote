/**
 * scripts/web-server.ts — the `pnpm web` entry: parses --port and starts the
 * web shell on the built dist/. startWebServer is mocked; requiring the script
 * never starts anything (runIfMain).
 */

import type * as scriptModule from '../../scripts/web-server';
import type * as serverModule from '../../src/js/web/server';

jest.mock('../../src/js/web/server', () => ({ startWebServer: jest.fn() }));

const { main, parsePort } = require('../../scripts/web-server') as typeof scriptModule;
const server = jest.mocked(require('../../src/js/web/server') as typeof serverModule);

describe('scripts/web-server.ts', () => {
    let logSpy: jest.SpiedFunction<typeof console.log>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        server.startWebServer.mockReset();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        process.exitCode = undefined;
    });

    test('parsePort: default, explicit, and out-of-range or non-numeric values', () => {
        expect(parsePort([])).toBe(4400);
        expect(parsePort(['--port=8080'])).toBe(8080);
        expect(parsePort(['--port=0'])).toBe(0);
        expect(parsePort(['--port=70000'])).toBeNull();
        expect(parsePort(['--port=-1'])).toBeNull();
        expect(parsePort(['--port=abc'])).toBeNull();
    });

    test('main starts the server on dist/ and prints its URL', async () => {
        server.startWebServer.mockResolvedValue({
            server: jest.requireActual<typeof import('node:http')>('node:http').createServer(),
            url: 'http://localhost:4400/',
        });
        await main(['--port=4400']);
        expect(server.startWebServer).toHaveBeenCalledWith({ port: 4400, distDir: expect.stringMatching(/dist$/) });
        expect(logSpy).toHaveBeenCalledWith('GuruShots Auto Vote web UI: http://localhost:4400/');
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
