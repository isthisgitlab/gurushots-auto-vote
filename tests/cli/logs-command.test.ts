/**
 * Unit tests for the CLI `logs` command. It tails one of the on-disk log
 * files (paths owned by the logger) so CLI users get the after-the-fact log
 * access the Electron Logs page provides. fs and the logger are mocked.
 */

jest.mock('fs');
jest.mock('../../src/ts/services/semantic/diagnostics', () => ({ diagnostics: { read: jest.fn() } }));

jest.mock('../../src/ts/logger', () => {
    const infoMock = jest.fn();
    const errorMock = jest.fn();
    const printMock = jest.fn();
    return {
        __infoMock: infoMock,
        __printMock: printMock,
        printLine: printMock,
        __errorMock: errorMock,
        withCategory: jest.fn(() => ({ info: infoMock, error: errorMock })),
        getLogFile: jest.fn(() => '/logs/app.log'),
        getErrorLogFile: jest.fn(() => '/logs/error.log'),
        getApiLogFile: jest.fn(() => '/logs/api.log'),
        getSettingsLogFile: jest.fn(() => '/logs/settings.log'),
    };
});

import { invalid } from '../helpers/invalid';
import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(
    invalid<typeof loggerModule & { __infoMock: jest.Mock<void, [string]>; __printMock: jest.Mock<void, [string]> }>(
        loggerModule,
    ),
);
import type * as diagnosticsModule from '../../src/ts/services/semantic/diagnostics';
import type * as logsModule from '../../src/ts/cli/commands/logs';
const { diagnostics } = jest.mocked(require('../../src/ts/services/semantic/diagnostics') as typeof diagnosticsModule);
const { showLogs } = require('../../src/ts/cli/commands/logs') as typeof logsModule;

describe('CLI logs command', () => {
    beforeEach(() => jest.clearAllMocks());

    test('prints the last N lines of the app log by default', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('line1\nline2\nline3\nline4');

        showLogs({ lines: 2 });

        expect(logger.getLogFile).toHaveBeenCalled();
        // The tail is printed whole, one line per log line, on the console only.
        expect(logger.__printMock.mock.calls).toEqual([['line3\nline4']]);
        expect(logger.__infoMock.mock.calls.map((c) => c[0]).join('\n')).not.toContain('line3');
    });

    test('terminal control sequences in the file never reach the terminal, line by line', () => {
        const ESC = String.fromCharCode(27);
        const BEL = String.fromCharCode(7);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            `ok line\nbad ${ESC}[31mred${ESC}[0m line\ntitle ${ESC}]0;pwned${BEL}set\nrtl \u202Eevil\nlast`,
        );
        showLogs({ lines: 10 });
        const [[printed]] = logger.__printMock.mock.calls;
        expect(printed).toBe('ok line\nbad red line\ntitle set\nrtl evil\nlast');
        // The line breaks between the log lines survive.
        expect(printed.split('\n')).toHaveLength(5);
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

    test('prints a ranked local lexicon report without reading a log file', () => {
        diagnostics.read.mockReturnValue(
            invalid({
                since: '2026-09-24',
                updatedAt: '2026-09-25',
                challenges: 2,
                noThemeVector: 1,
                noLabelVectors: 0,
                noOnThemeScore: 1,
                themeWords: { zebra: 1, apple: 2, blue: 1 },
                labelWords: { moss: 1 },
            }),
        );

        showLogs({ category: 'lexicon' });

        expect(fs.readFileSync).not.toHaveBeenCalled();
        const printed = logger.__infoMock.mock.calls.map(([line]) => line);
        expect(printed).toContain('Challenge observations: 2');
        expect(printed).toContain('No theme vector: 1');
        expect(printed).toContain('Missing challenge words: apple: 2, blue: 1, zebra: 1');
        expect(printed).toContain('Missing photo-label words: moss: 1');
    });

    test('reports empty counters and an unobserved timestamp', () => {
        diagnostics.read.mockReturnValue(
            invalid({
                since: '2026-09-24',
                updatedAt: null,
                challenges: 0,
                noThemeVector: 0,
                noLabelVectors: 0,
                noOnThemeScore: 0,
                themeWords: {},
                labelWords: {},
            }),
        );

        showLogs({ category: 'lexicon' });

        const printed = logger.__infoMock.mock.calls.map(([line]) => line);
        expect(printed[0]).toContain('last updated never');
        expect(printed).toContain('Missing challenge words: (none)');
        expect(printed).toContain('Missing photo-label words: (none)');
    });
});
