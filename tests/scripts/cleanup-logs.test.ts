/**
 * Tests for scripts/cleanup-logs.ts — deletes api-debug-* files from
 * the userData logs dir. Hermetic: the platform resolves user data into a
 * temp dir, and all fs work happens under os.tmpdir(); the real logs/ is
 * never touched.
 */

// tests/setup.ts mocks fs/path globally; this suite needs the real modules
// to exercise real deletion in a temp dir.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import os = require('node:os');
import pathModule = require('node:path');
const path = jest.mocked(pathModule);
import type * as cleanup_logsModule from '../../scripts/cleanup-logs';
import { platform } from '../../src/ts/platform/port';
import { clearInstalledPlatform, installTestPlatform } from '../helpers/platform';

let mockUserDataPath = '';

clearInstalledPlatform();
const { cleanupLogs } = require('../../scripts/cleanup-logs') as typeof cleanup_logsModule;

describe('cleanup-logs', () => {
    let tmp: string;
    let logSpy: jest.SpiedFunction<typeof console.log>;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-logs-'));
        mockUserDataPath = tmp;
        // The script resolves the logs dir from the platform: point it at this test's temp dir.
        installTestPlatform({ paths: { ...platform().paths, userData: () => mockUserDataPath } });
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('reports a missing logs directory and deletes nothing', () => {
        const missing = path.join(tmp, 'nope');

        cleanupLogs(missing);

        expect(logSpy).toHaveBeenCalledWith(`No logs directory at ${missing}`);
    });

    test('deletes only api-debug-* files from the userData logs dir by default', () => {
        const logsDir = path.join(tmp, 'logs');
        fs.mkdirSync(logsDir);
        fs.writeFileSync(path.join(logsDir, 'api-debug-1.log'), 'x'.repeat(1024));
        fs.writeFileSync(path.join(logsDir, 'api-debug-2.log'), 'y');
        fs.writeFileSync(path.join(logsDir, 'app.log'), 'keep');

        cleanupLogs();

        expect(fs.readdirSync(logsDir)).toEqual(['app.log']);
        expect(logSpy).toHaveBeenCalledWith(`Deleted 2 api-debug-* file(s) (0.00 MB) from ${logsDir}.`);
    });
});
