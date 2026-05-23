/**
 * Unit tests for the CLI `status` command's "Boost Window Open" section — the
 * CLI parity of the GUI BoostWindowBanner (informational list, no anchors).
 * It best-effort fetches active challenges and lists those whose boost window
 * is open, reusing the engine's own isBoostWindowOpen predicate. logger,
 * settings, the middleware, and the scheduler are mocked.
 */

jest.mock('../../src/js/logger.js', () => {
    const infoMock = jest.fn();
    return {
        __infoMock: infoMock,
        withCategory: jest.fn(() => ({
            info: infoMock,
            error: infoMock,
            success: infoMock,
            warning: infoMock,
            startOperation: jest.fn(),
            endOperation: jest.fn(),
        })),
    };
});

jest.mock('../../src/js/settings.js', () => ({
    loadSettings: jest.fn(() => ({
        mock: true,
        token: 'tok',
        theme: 'latvian',
        language: 'english',
        timezone: 'Europe/Riga',
        apiTimeout: 30,
        checkFrequencyMin: 1,
        checkFrequencyMax: 1,
        challengeSettings: {},
    })),
    getEffectiveSetting: jest.fn(() => 1),
}));

jest.mock('../../src/js/scheduling/runScheduler', () => ({ createScheduler: jest.fn() }));

jest.mock('../../src/js/apiFactory', () => {
    const mockGetActiveChallenges = jest.fn();
    const mockIsAuthenticated = jest.fn(() => true);
    return {
        __getActiveChallenges: mockGetActiveChallenges,
        __isAuthenticated: mockIsAuthenticated,
        getMiddleware: jest.fn(() => ({
            isAuthenticated: mockIsAuthenticated,
            getActiveChallenges: mockGetActiveChallenges,
        })),
    };
});

const logger = require('../../src/js/logger.js');
const apiFactory = require('../../src/js/apiFactory');
const { showStatus } = require('../../src/js/cli/commands/voting');

const challenge = (title, boost) => ({ id: title, title, member: { boost } });

const printedLines = () => logger.__infoMock.mock.calls.map((c) => c[0]).filter((s) => typeof s === 'string');
const bulletLines = () => printedLines().filter((s) => s.startsWith('  • '));

describe('CLI status — Boost Window Open section', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        apiFactory.__isAuthenticated.mockReturnValue(true);
    });

    test('lists open windows soonest-first, key-unlocked last, with formatted remaining', async () => {
        const now = Math.floor(Date.now() / 1000);
        apiFactory.__getActiveChallenges.mockResolvedValue({
            challenges: [
                challenge('TenMin', { state: 'AVAILABLE', timeout: now + 630 }),
                challenge('KeyOne', { state: 'AVAILABLE_KEY' }),
                challenge('TwoMin', { state: 'AVAILABLE', timeout: now + 150 }),
                challenge('HourPlus', { state: 'AVAILABLE', timeout: now + 3700 }),
                challenge('Closed', { state: 'USED' }),
            ],
        });

        await showStatus();

        expect(printedLines()).toContain('\nBoost Window Open:');
        expect(bulletLines()).toEqual([
            '  • TwoMin — 2m',
            '  • TenMin — 10m',
            '  • HourPlus — 1h 1m',
            '  • KeyOne — no expiry',
        ]);
    });

    test('multi-day window uses d/h units (not raw hours/minutes)', async () => {
        const now = Math.floor(Date.now() / 1000);
        apiFactory.__getActiveChallenges.mockResolvedValue({
            challenges: [challenge('LongOne', { state: 'AVAILABLE', timeout: now + 2 * 86400 + 3 * 3600 + 1800 })],
        });

        await showStatus();

        expect(bulletLines()).toEqual(['  • LongOne — 2d 3h']);
    });

    test('sub-minute window prints "<1m", not "0m"', async () => {
        const now = Math.floor(Date.now() / 1000);
        apiFactory.__getActiveChallenges.mockResolvedValue({
            challenges: [challenge('AlmostGone', { state: 'AVAILABLE', timeout: now + 30 })],
        });

        await showStatus();

        expect(bulletLines()).toEqual(['  • AlmostGone — <1m']);
    });

    test('a non-array challenges payload is treated as empty (prints "None")', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: null });

        await showStatus();

        expect(printedLines()).toContain('  None');
        expect(bulletLines()).toEqual([]);
    });

    test('prints "None" when no boost window is open', async () => {
        apiFactory.__getActiveChallenges.mockResolvedValue({
            challenges: [challenge('Closed', { state: 'USED' })],
        });

        await showStatus();

        expect(printedLines()).toContain('  None');
        expect(bulletLines()).toEqual([]);
    });

    test('best-effort: a failed fetch prints a note instead of throwing', async () => {
        apiFactory.__getActiveChallenges.mockRejectedValue(new Error('network down'));

        await expect(showStatus()).resolves.toBeUndefined();
        expect(printedLines().some((s) => s.includes('unavailable') && s.includes('network down'))).toBe(true);
    });

    test('skips the section entirely when not authenticated', async () => {
        apiFactory.__isAuthenticated.mockReturnValue(false);

        await showStatus();

        expect(printedLines()).not.toContain('\nBoost Window Open:');
        expect(apiFactory.__getActiveChallenges).not.toHaveBeenCalled();
    });
});
