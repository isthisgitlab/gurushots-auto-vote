/**
 * Tests for scripts/cleanup-logs.js — deletes legacy api-debug-* files from
 * the userData logs dir. Hermetic: runtime is mocked to a temp dir, and all
 * fs work happens under os.tmpdir(); the real logs/ is never touched.
 */

// tests/setup.js mocks fs/path globally; this suite needs the real modules
// to exercise real deletion in a temp dir.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let mockUserDataPath = '';
jest.mock('../../src/js/runtime', () => ({
    getAppUserDataPath: () => mockUserDataPath,
}));

const { cleanupLogs } = require('../../scripts/cleanup-logs.js');

describe('cleanup-logs', () => {
    let tmp;
    let logSpy;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-logs-'));
        mockUserDataPath = tmp;
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
        expect(logSpy).toHaveBeenCalledWith(`Deleted 2 legacy api-debug-* file(s) (0.00 MB) from ${logsDir}.`);
    });
});
