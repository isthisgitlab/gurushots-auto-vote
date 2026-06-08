/**
 * Unit tests for the canonical duration formatter (src/js/format/duration.js)
 * shared by the CLI status, the renderer boost-window banner + challenge
 * countdown, and api/main boost logging. The default mode locks the
 * CLI/GUI parity the old per-shell copies promised; the includeSeconds mode
 * reproduces the former formatTimeRemaining body.
 */

const { formatDuration } = require('../../src/js/format/duration');

describe('formatDuration (default — minute granularity, "<1m" floor)', () => {
    test('sub-minute, zero, negative, and non-numeric all read "<1m"', () => {
        expect(formatDuration(0)).toBe('<1m');
        expect(formatDuration(1)).toBe('<1m');
        expect(formatDuration(59)).toBe('<1m');
        expect(formatDuration(-100)).toBe('<1m');
        expect(formatDuration(undefined)).toBe('<1m');
        expect(formatDuration(NaN)).toBe('<1m');
    });

    test('minutes only under an hour', () => {
        expect(formatDuration(60)).toBe('1m');
        expect(formatDuration(630)).toBe('10m');
        expect(formatDuration(3599)).toBe('59m');
    });

    test('hours + minutes, never raw minutes (the 645m bug)', () => {
        expect(formatDuration(3600)).toBe('1h 0m');
        expect(formatDuration(3700)).toBe('1h 1m');
        expect(formatDuration(645 * 60)).toBe('10h 45m');
    });

    test('days + hours for multi-day windows', () => {
        expect(formatDuration(86400)).toBe('1d 0h');
        expect(formatDuration(2 * 86400 + 3 * 3600 + 1800)).toBe('2d 3h');
    });
});

describe('formatDuration (includeSeconds — live countdown)', () => {
    test('seconds only under a minute (no "<1m" here)', () => {
        expect(formatDuration(0, { includeSeconds: true })).toBe('0s');
        expect(formatDuration(45, { includeSeconds: true })).toBe('45s');
    });

    test('minutes + seconds under an hour', () => {
        expect(formatDuration(90, { includeSeconds: true })).toBe('1m 30s');
        expect(formatDuration(3599, { includeSeconds: true })).toBe('59m 59s');
    });

    test('hours + minutes (seconds dropped once an hour is reached)', () => {
        expect(formatDuration(3600, { includeSeconds: true })).toBe('1h 0m');
        expect(formatDuration(3 * 3600 + 5 * 60 + 12, { includeSeconds: true })).toBe('3h 5m');
    });

    test('days + hours + minutes for multi-day windows', () => {
        expect(formatDuration(2 * 86400 + 3 * 3600 + 5 * 60, { includeSeconds: true })).toBe('2d 3h 5m');
    });
});
