const {
    formatSettingDefault,
    formatTimeRemaining,
    formatEndTime,
    getBoostStatus,
    getTurboStatus,
    getLevelStatus,
    getEntryStatus,
} = require('../../src/js/react/utils/formatters');
const { interp } = require('../../src/js/react/utils/interp');

const t = (key) => ({ 'app.none': '(none)', 'app.hours': 'h', 'app.minutes': 'm' })[key] ?? key;

const NOW_SEC = 1_700_000_000;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW_SEC * 1000);
});

afterEach(() => {
    jest.useRealTimers();
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
    test('returns Ended at or past the close time', () => {
        expect(formatTimeRemaining(NOW_SEC)).toBe('Ended');
        expect(formatTimeRemaining(NOW_SEC - 10)).toBe('Ended');
    });

    test('formats a future close time with seconds', () => {
        expect(formatTimeRemaining(NOW_SEC + 90)).toBe('1m 30s');
    });
});

describe('formatEndTime', () => {
    const end = NOW_SEC;

    test('local timezone (default) uses the runtime zone', () => {
        const expected = new Date(end * 1000).toLocaleString('lv-LV', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        expect(formatEndTime(end)).toBe(expected);
    });

    test('a named timezone is honoured', () => {
        const out = formatEndTime(end, 'UTC');
        // 1700000000 = 2023-11-14 22:13 UTC
        expect(out).toContain('14.11.2023');
        expect(out).toContain('22:13');
    });

    test('an invalid timezone falls back to local instead of throwing', () => {
        expect(() => formatEndTime(end, 'Not/AZone')).not.toThrow();
        expect(formatEndTime(end, 'Not/AZone')).toBe(formatEndTime(end, 'local'));
    });
});

describe('getBoostStatus', () => {
    test.each([
        [null, 'Unknown', 'text-purple-500'],
        [{}, 'Unknown', 'text-purple-500'],
        [{ state: 'USED' }, 'Used', 'text-green-500'],
        [{ state: 'UNAVAILABLE' }, 'Unavailable', 'text-red-500'],
        [{ state: 'LOCKED' }, 'Locked', 'text-red-500'],
        [{ state: 'WEIRD' }, 'WEIRD', 'text-purple-500'],
    ])('%j → %s', (boost, text, colorClass) => {
        expect(getBoostStatus(boost)).toEqual({ text, colorClass });
    });

    test('available with time left shows minutes remaining', () => {
        expect(getBoostStatus({ state: 'AVAILABLE_KEY', timeout: NOW_SEC + 125 })).toEqual({
            text: 'Available (2m left)',
            colorClass: 'text-blue-500',
        });
    });

    test('available with an expired timeout shows plain Available', () => {
        expect(getBoostStatus({ state: 'AVAILABLE', timeout: NOW_SEC - 1 }).text).toBe('Available');
    });
});

describe('getTurboStatus', () => {
    test.each([
        [undefined, 'Unavailable', 'text-red-500'],
        [{ state: '' }, 'Unavailable', 'text-red-500'],
        [{ state: 'FREE' }, 'Free', 'text-blue-400'],
        [{ state: 'TIMER' }, 'Timer', 'text-red-500'],
        [{ state: 'IN_PROGRESS' }, 'In Progress', 'text-orange-500'],
        [{ state: 'WON' }, 'Won', 'text-lime-800'],
        [{ state: 'USED' }, 'Used', 'text-green-500'],
        [{ state: 'UNAVAILABLE' }, 'Unavailable', 'text-red-500'],
        [{ state: 'LOCKED' }, 'Locked', 'text-latvian'],
        [{ state: 'NEW_STATE' }, 'NEW_STATE', 'text-purple-500'],
    ])('%j → %s', (turbo, text, colorClass) => {
        expect(getTurboStatus(turbo)).toEqual({ text, colorClass });
    });
});

describe('getLevelStatus', () => {
    test('missing level or name is Unknown', () => {
        expect(getLevelStatus(0, 'POPULAR')).toEqual({ text: 'Unknown', colorClass: 'badge-success' });
        expect(getLevelStatus(3, '')).toEqual({ text: 'Unknown', colorClass: 'badge-success' });
    });

    test.each([
        ['Popular', 'badge-popular'],
        ['SKILLED', 'badge-skilled'],
        ['premier', 'badge-premier'],
        ['ELITE', 'badge-elite'],
        ['All Star', 'badge-allstar'],
        ['Newbie', 'badge-warning'],
    ])('%s → %s (case-insensitive)', (name, colorClass) => {
        expect(getLevelStatus(2, name)).toEqual({ text: `${name} 2`, colorClass });
    });
});

describe('getEntryStatus', () => {
    test('guru pick and plain entries', () => {
        expect(getEntryStatus({ guru_pick: true }).icon).toBe('⭐');
        expect(getEntryStatus(undefined)).toMatchObject({ isBoosted: false, isTurboed: false, icon: '📷' });
    });
});

describe('re-exports from the shared core', () => {
    test('formatters exposes the same functions the core modules define', () => {
        const fm = require('../../src/js/react/utils/formatters');
        expect(fm.formatDuration).toBe(require('../../src/js/format/duration').formatDuration);
        expect(fm.entryPhotoUrl).toBe(require('../../src/js/format/photoUrl').entryPhotoUrl);
        expect(fm.isBoostWindowOpen).toBe(require('../../src/js/voting/boostWindow').isBoostWindowOpen);
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
