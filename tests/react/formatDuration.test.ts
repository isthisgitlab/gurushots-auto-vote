/**
 * Unit tests for formatDuration — the remaining-time formatter shared (in
 * spirit) by the GUI boost-window banner. It must use real time units rather
 * than raw minutes: a 10¾-hour window reads "10h 45m", not "645m".
 */

import type * as formattersModule from '../../src/ts/react/utils/formatters';

import type * as rendererModule from '../../src/ts/translations/renderer';

const { formatDuration } = require('../../src/ts/react/utils/formatters') as typeof formattersModule;
const { rendererTranslator } = require('../../src/ts/translations/renderer') as typeof rendererModule;

describe('formatDuration', () => {
    test('sub-minute (and zero / negative) reads "<1m", never "0m"', () => {
        expect(formatDuration(0)).toBe('<1m');
        expect(formatDuration(1)).toBe('<1m');
        expect(formatDuration(59)).toBe('<1m');
        expect(formatDuration(-100)).toBe('<1m');
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

describe('formatDuration in the UI language', () => {
    afterEach(() => jest.restoreAllMocks());

    test('Latvian writes minutes "min" (not "m", metres), English keeps "m"', () => {
        const language = jest.spyOn(rendererTranslator, 'getCurrentLanguage').mockReturnValue('lv');
        expect(formatDuration(3700)).toBe('1h 1min');
        expect(formatDuration(30)).toBe('<1min');
        expect(formatDuration(90, { includeSeconds: true })).toBe('1min 30s');
        language.mockReturnValue('en');
        expect(formatDuration(3700)).toBe('1h 1m');
    });
});
