import { invalid } from '../helpers/invalid';
import type * as formattersModule from '../../src/ts/react/utils/formatters';
import type * as wallClockModule from '../../src/ts/scheduling/wallClock';
import type * as interpModule from '../../src/ts/react/utils/interp';
import type * as rendererModule from '../../src/ts/translations/renderer';
import type * as levelBadgeModule from '../../src/ts/react/utils/levelBadge';
const {
    formatSettingDefault,
    formatTimeRemaining,
    formatEndTime,
    getBoostStatus,
    getTurboStatus,
    getLevelStatus,
    getEntryStatus,
    isBoostAvailable,
    statusText,
    dateLocale,
} = require('../../src/ts/react/utils/formatters') as typeof formattersModule;
const { timeOfDayIn } = require('../../src/ts/scheduling/wallClock') as typeof wallClockModule;
const { interp } = require('../../src/ts/react/utils/interp') as typeof interpModule;
const { rendererTranslator } = require('../../src/ts/translations/renderer') as typeof rendererModule;
const { LEVEL_BADGE_CLASS, LEVEL_PROGRESS_CLASS } =
    require('../../src/ts/react/utils/levelBadge') as typeof levelBadgeModule;

const t = (key: string) =>
    (({ 'app.none': '(none)', 'app.hours': 'h', 'app.minutes': 'm' }) as Record<string, string>)[key] ?? key;

const NOW_SEC = 1_700_000_000;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW_SEC * 1000);
});

afterEach(() => {
    jest.useRealTimers();
    jest.mocked(rendererTranslator.getCurrentLanguage).mockReturnValue('en');
});

describe('formatSettingDefault edge shapes', () => {
    test('schedule rows sort by count, tolerating null rows and missing counts', () => {
        const rows = [{ count: 5, seconds: 3600 }, null, { seconds: 60 }];
        const out = formatSettingDefault(rows, { type: 'schedule' }, t);
        // null row and count-less row both sort as 0 (stable), before count 5
        expect(out).toBe('undefined ≤ 0 h, 0 m, undefined ≤ 0 h, 1 m, 5 ≤ 1 h, 0 m');
    });

    test('an empty text default renders the none label', () => {
        expect(formatSettingDefault('', { type: 'scenario' }, t)).toBe('(none)');
    });

    test('schedule with a non-array value renders the none label', () => {
        expect(formatSettingDefault('bogus', { type: 'schedule' }, t)).toBe('(none)');
    });

    test('timeList renders each entry as hours/minutes, or none when empty / not an array', () => {
        expect(formatSettingDefault([60, 3600], { type: 'timeList' }, t)).toBe('0 h, 1 m, 1 h, 0 m');
        expect(formatSettingDefault([], { type: 'timeList' }, t)).toBe('(none)');
        expect(formatSettingDefault(null, { type: 'timeList' }, t)).toBe('(none)');
    });

    test('number without a unit falls back to String(value)', () => {
        expect(formatSettingDefault(7, { type: 'number' }, t)).toBe('7');
        expect(formatSettingDefault(true, undefined, t)).toBe('true');
    });
});

describe('formatTimeRemaining', () => {
    test('returns null (ended) at or past the close time', () => {
        expect(formatTimeRemaining(NOW_SEC)).toBeNull();
        expect(formatTimeRemaining(NOW_SEC - 10)).toBeNull();
    });

    test('formats a future close time with seconds', () => {
        expect(formatTimeRemaining(NOW_SEC + 90)).toBe('1m 30s');
    });
});

describe('formatEndTime', () => {
    const end = NOW_SEC;

    test.each([
        ['en', 'en-GB'],
        ['lv', 'lv-LV'],
    ])('local timezone (default) uses the runtime zone, written for the UI language (%s)', (language, locale) => {
        jest.mocked(rendererTranslator.getCurrentLanguage).mockReturnValue(language);
        const expected = new Date(end * 1000).toLocaleString(locale, {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        expect(dateLocale()).toBe(locale);
        expect(formatEndTime(end)).toBe(expected);
    });

    test("a named timezone is honoured, in the UI language's date layout", () => {
        // 1700000000 = 2023-11-14 22:13 UTC
        const english = formatEndTime(end, 'UTC');
        expect(english).toContain('14/11/2023');
        expect(english).toContain('22:13');
        jest.mocked(rendererTranslator.getCurrentLanguage).mockReturnValue('lv');
        const latvian = formatEndTime(end, 'UTC');
        expect(latvian).toContain('14.11.2023');
        expect(latvian).toContain('22:13');
    });

    // The "closes at" rule condition must read the same HH:MM the card shows.
    test.each([
        ['an afternoon instant', Date.UTC(2026, 5, 15, 14, 10, 59) / 1000],
        ['just after midnight (00:xx, not 24:xx)', Date.UTC(2026, 5, 14, 21, 5, 30) / 1000],
        ['winter time, after midnight', Date.UTC(2026, 0, 14, 22, 7, 0) / 1000],
    ])('timeOfDayIn agrees with the HH:MM on the card: %s', (_label, sec) => {
        const card = /\b(\d{2}:\d{2})\b/.exec(formatEndTime(sec, 'Europe/Riga'));
        expect(card?.[1]).toBeDefined();
        expect(timeOfDayIn(sec, 'Europe/Riga')).toBe(card?.[1]);
    });

    // 'local' reads the device clock on each side, so this holds on any host.
    test('timeOfDayIn agrees with the card on the device clock (local)', () => {
        for (const sec of [Date.UTC(2026, 5, 15, 14, 10, 59) / 1000, Date.UTC(2026, 5, 14, 21, 5, 30) / 1000]) {
            const card = /\b(\d{2}:\d{2})\b/.exec(formatEndTime(sec, 'local'));
            expect(card?.[1]).toBeDefined();
            expect(timeOfDayIn(sec, 'local')).toBe(card?.[1]);
        }
    });

    // An unknown zone reads as UTC on each side; the device clock is pinned to a sentinel so UTC and the
    // device cannot coincide on a UTC runner.
    describe('an unknown timezone', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        const pinDeviceClock = (): void => {
            const real = Date.prototype.toLocaleString;
            jest.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (
                this: Date,
                locales?: Intl.LocalesArgument,
                options?: Intl.DateTimeFormatOptions,
            ) {
                return options?.timeZone ? real.call(this, locales, options) : 'DEVICE';
            });
            jest.spyOn(Date.prototype, 'getHours').mockReturnValue(5);
            jest.spyOn(Date.prototype, 'getMinutes').mockReturnValue(37);
        };

        test('timeOfDayIn agrees with the card, both reading UTC', () => {
            pinDeviceClock();
            const sec = Date.UTC(2026, 5, 15, 14, 10, 59) / 1000;
            const card = /\b(\d{2}:\d{2})\b/.exec(formatEndTime(sec, 'Not/AZone'));
            expect(card?.[1]).toBe('14:10');
            expect(timeOfDayIn(sec, 'Not/AZone')).toBe('14:10');
        });

        test('formatEndTime reads as UTC instead of throwing', () => {
            pinDeviceClock();
            expect(() => formatEndTime(end, 'Not/AZone')).not.toThrow();
            expect(formatEndTime(end, 'Not/AZone')).toBe(formatEndTime(end, 'UTC'));
            expect(formatEndTime(end, 'Not/AZone')).not.toBe('DEVICE');
        });
    });
});

describe('getBoostStatus', () => {
    test.each([
        [null, { code: 'unknown', colorClass: 'text-base-content/70' }],
        [{}, { code: 'unknown', colorClass: 'text-base-content/70' }],
        [{ state: 'USED' }, { code: 'used', colorClass: 'text-success' }],
        [{ state: 'UNAVAILABLE' }, { code: 'unavailable', colorClass: 'text-base-content/70' }],
        [{ state: 'LOCKED' }, { code: 'locked', colorClass: 'text-base-content/70' }],
        [{ state: 'WEIRD' }, { code: 'other', colorClass: 'text-base-content/70', raw: 'WEIRD' }],
    ])('%j → %j', (boost, status) => {
        expect(getBoostStatus(boost)).toEqual(status);
    });

    test('available with time left carries the whole minutes remaining', () => {
        expect(getBoostStatus({ state: 'AVAILABLE_KEY', timeout: NOW_SEC + 125 })).toEqual({
            code: 'availableMinutes',
            colorClass: 'text-info',
            minutes: 2,
        });
    });

    test('available with an expired timeout is plain available', () => {
        expect(getBoostStatus({ state: 'AVAILABLE', timeout: NOW_SEC - 1 }).code).toBe('available');
    });

    test('isBoostAvailable is true for both available codes only', () => {
        expect(isBoostAvailable(getBoostStatus({ state: 'AVAILABLE', timeout: NOW_SEC + 600 }))).toBe(true);
        expect(isBoostAvailable(getBoostStatus({ state: 'AVAILABLE', timeout: NOW_SEC - 1 }))).toBe(true);
        expect(isBoostAvailable(getBoostStatus({ state: 'USED' }))).toBe(false);
        expect(isBoostAvailable(getBoostStatus(null))).toBe(false);
    });
});

describe('statusText', () => {
    const keyT = (key: string) => key;

    test('words each code through its translation key; minutes fill the placeholder', () => {
        const words = (status: Parameters<typeof statusText>[0]) => statusText(status, keyT);
        expect(words({ code: 'unknown', colorClass: '' })).toBe('app.stateUnknown');
        expect(words({ code: 'available', colorClass: '' })).toBe('app.available');
        expect(words({ code: 'used', colorClass: '' })).toBe('app.used');
        expect(words({ code: 'unavailable', colorClass: '' })).toBe('app.unavailable');
        expect(words({ code: 'locked', colorClass: '' })).toBe('app.stateLocked');
        expect(words({ code: 'free', colorClass: '' })).toBe('app.stateFree');
        expect(words({ code: 'timer', colorClass: '' })).toBe('app.stateTimer');
        expect(words({ code: 'inProgress', colorClass: '' })).toBe('app.stateInProgress');
        expect(words({ code: 'won', colorClass: '' })).toBe('app.stateWon');
        expect(statusText({ code: 'availableMinutes', colorClass: '', minutes: 446 }, () => 'Left: {time}')).toBe(
            'Left: 7h 26m',
        );
        expect(statusText({ code: 'availableMinutes', colorClass: '' }, () => '{time} left')).toBe('<1m left');
    });

    test("an 'other' state is the API's own text, untranslated", () => {
        expect(statusText({ code: 'other', colorClass: '', raw: 'NEW_STATE' }, keyT)).toBe('NEW_STATE');
        expect(statusText({ code: 'other', colorClass: '' }, keyT)).toBe('');
    });
});

describe('getTurboStatus', () => {
    test.each([
        [undefined, { code: 'unavailable', colorClass: 'text-base-content/70' }],
        [{ state: '' }, { code: 'unavailable', colorClass: 'text-base-content/70' }],
        [{ state: 'FREE' }, { code: 'free', colorClass: 'text-info' }],
        [{ state: 'TIMER' }, { code: 'timer', colorClass: 'text-base-content/70' }],
        [{ state: 'IN_PROGRESS' }, { code: 'inProgress', colorClass: 'text-warning' }],
        [{ state: 'WON' }, { code: 'won', colorClass: 'text-success' }],
        [{ state: 'USED' }, { code: 'used', colorClass: 'text-success' }],
        [{ state: 'UNAVAILABLE' }, { code: 'unavailable', colorClass: 'text-base-content/70' }],
        [{ state: 'LOCKED' }, { code: 'locked', colorClass: 'text-base-content/70' }],
        [{ state: 'NEW_STATE' }, { code: 'other', colorClass: 'text-base-content/70', raw: 'NEW_STATE' }],
    ])('%j → %j', (turbo, status) => {
        expect(getTurboStatus(turbo)).toEqual(status);
    });
});

describe('getLevelStatus', () => {
    test('missing level or name is Unknown', () => {
        const unknown = { text: 'Unknown', colorClass: 'badge-success', progressClass: 'progress-latvian' };
        expect(getLevelStatus(0, 'POPULAR')).toEqual(unknown);
        expect(getLevelStatus(3, '')).toEqual(unknown);
    });

    test.each([
        ['Popular', LEVEL_BADGE_CLASS.popular, LEVEL_PROGRESS_CLASS.popular],
        ['SKILLED', LEVEL_BADGE_CLASS.skilled, LEVEL_PROGRESS_CLASS.skilled],
        ['premier', LEVEL_BADGE_CLASS.premier, LEVEL_PROGRESS_CLASS.premier],
        ['ELITE', LEVEL_BADGE_CLASS.elite, LEVEL_PROGRESS_CLASS.elite],
        ['All Star', LEVEL_BADGE_CLASS.allstar, LEVEL_PROGRESS_CLASS.allstar],
        ['Newbie', 'badge-warning', 'progress-latvian'],
    ])('%s → %s / %s (case-insensitive)', (name, colorClass, progressClass) => {
        expect(getLevelStatus(2, name)).toEqual({ text: `${name} 2`, colorClass, progressClass });
    });
});

describe('getEntryStatus', () => {
    test('every state is told by its icon alone, with no colour fields', () => {
        const states = [{ boosted: true }, { turbo: true }, { guru_pick: true }, {}].map((entry) =>
            getEntryStatus(invalid(entry)),
        );
        expect(states.map((state) => state.icon)).toEqual(['🚀', '⚡', '⭐', '📷']);
        for (const state of states) {
            expect(Object.keys(state).sort()).toEqual(['icon', 'isBoosted', 'isGuruPick', 'isTurboed']);
        }
    });

    test('guru pick and plain entries', () => {
        expect(getEntryStatus(invalid({ guru_pick: true })).icon).toBe('⭐');
        expect(getEntryStatus(undefined)).toMatchObject({
            isBoosted: false,
            isTurboed: false,
            isGuruPick: false,
            icon: '📷',
        });
    });

    test('isGuruPick rides on a boosted or turboed entry, whose icon stays theirs', () => {
        expect(getEntryStatus(invalid({ boosted: true, guru_pick: true }))).toMatchObject({
            isBoosted: true,
            isGuruPick: true,
            icon: '🚀',
        });
        expect(getEntryStatus(invalid({ turbo: true, guru_pick: true }))).toMatchObject({
            isTurboed: true,
            isGuruPick: true,
            icon: '⚡',
        });
    });

    test('a truthy non-boolean guru_pick is no pick', () => {
        expect(getEntryStatus(invalid({ guru_pick: 1 })).isGuruPick).toBe(false);
        expect(getEntryStatus(invalid({ guru_pick: 'yes' })).icon).toBe('📷');
    });
});

describe('re-exports from the shared core', () => {
    test('formatters exposes the same functions the core modules define', () => {
        const fm = require('../../src/ts/react/utils/formatters') as typeof formattersModule;
        // formatDuration is the shared one in the UI's language (see formatDuration.test.ts): same text in English.
        const core = (require('../../src/ts/format/duration') as typeof import('../../src/ts/format/duration'))
            .formatDuration;
        expect([0, 59, 630, 3700, 90_000].map((seconds) => fm.formatDuration(seconds))).toEqual(
            [0, 59, 630, 3700, 90_000].map((seconds) => core(seconds)),
        );
        expect(fm.entryPhotoUrl).toBe(
            (require('../../src/ts/format/photoUrl') as typeof import('../../src/ts/format/photoUrl')).entryPhotoUrl,
        );
        expect(fm.isBoostWindowOpen).toBe(
            (require('../../src/ts/voting/boostWindow') as typeof import('../../src/ts/voting/boostWindow'))
                .isBoostWindowOpen,
        );
    });
});

describe('interp', () => {
    test('fills placeholders and blanks missing / null values', () => {
        expect(interp('{a}-{b}-{c}', { a: 1, b: null })).toBe('1--');
    });

    test('works without a vars object', () => {
        expect(interp('x {a} y')).toBe('x  y');
    });
});
