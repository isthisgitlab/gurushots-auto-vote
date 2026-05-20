/**
 * Unit tests for the CLI `logs` command. It tails one of the on-disk log
 * files (paths owned by the logger) so CLI users get the after-the-fact log
 * access the Electron Logs page provides. fs and the logger are mocked.
 */

jest.mock('fs');

jest.mock('../../src/js/logger.js', () => {
    const infoMock = jest.fn();
    const errorMock = jest.fn();
    return {
        __infoMock: infoMock,
        __errorMock: errorMock,
        withCategory: jest.fn(() => ({ info: infoMock, error: errorMock })),
        getLogFile: jest.fn(() => '/logs/app.log'),
        getErrorLogFile: jest.fn(() => '/logs/error.log'),
        getApiLogFile: jest.fn(() => '/logs/api.log'),
        getSettingsLogFile: jest.fn(() => '/logs/settings.log'),
    };
});

const fs = require('fs');
const logger = require('../../src/js/logger.js');
const { showLogs } = require('../../src/js/cli/commands/logs');

describe('CLI logs command', () => {
    beforeEach(() => jest.clearAllMocks());

    test('prints the last N lines of the app log by default', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('line1\nline2\nline3\nline4');

        showLogs({ lines: 2 });

        expect(logger.getLogFile).toHaveBeenCalled();
        const printed = logger.__infoMock.mock.calls.map((c) => c[0]).join('\n');
        expect(printed).toContain('line3');
        expect(printed).toContain('line4');
        expect(printed).not.toContain('line1');
    });

    test('reads the error log when category is error', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('err');

        showLogs({ category: 'error', lines: 10 });

        expect(logger.getErrorLogFile).toHaveBeenCalled();
        expect(fs.readFileSync).toHaveBeenCalledWith('/logs/error.log', 'utf8');
    });

    test('handles a missing log file without throwing or reading', () => {
        fs.existsSync.mockReturnValue(false);

        expect(() => showLogs({})).not.toThrow();
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });
});
