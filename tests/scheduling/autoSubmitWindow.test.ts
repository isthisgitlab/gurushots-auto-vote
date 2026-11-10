import type * as autoSubmitWindowModule from '../../src/ts/core/scheduling/autoSubmitWindow';
import type * as autoSubmitClockModule from '../../src/ts/core/scheduling/autoSubmitClock';
import type * as autoSubmitScheduleModule from '../../src/ts/core/scheduling/autoSubmitSchedule';
import type * as wallClockModule from '../../src/ts/core/scheduling/wallClock';
import { invalid } from '../helpers/invalid';

const { getAutoSubmitClockWindowState } =
    require('../../src/ts/core/scheduling/autoSubmitWindow') as typeof autoSubmitWindowModule;
const { soonestAutoSubmitClockBoundary } =
    require('../../src/ts/core/scheduling/autoSubmitClock') as typeof autoSubmitClockModule;
const { soonestAutoSubmitScheduleBoundary } =
    require('../../src/ts/core/scheduling/autoSubmitSchedule') as typeof autoSubmitScheduleModule;
const { epochForWallTime } = require('../../src/ts/core/scheduling/wallClock') as typeof wallClockModule;

const utc = (y: number, m: number, d: number, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm) / 1000;

describe('getAutoSubmitClockWindowState', () => {
    test('opens at the configured instant and closes exclusively at the window end', () => {
        const start = utc(2026, 1, 15, 8, 20);

        expect(getAutoSubmitClockWindowState(['08:20'], 60, 'UTC', start)).toMatchObject({
            active: true,
            activeTimes: ['08:20'],
            activeUntil: start + 3600,
        });
        expect(getAutoSubmitClockWindowState(['08:20'], 60, 'UTC', start + 3600)).toMatchObject({
            active: false,
            activeTimes: [],
        });
    });

    test('uses the app timezone across a UTC date rollover', () => {
        // 00:10 on Jan 16 in Riga is 22:10 UTC on Jan 15 in winter.
        const start = utc(2026, 1, 15, 22, 10);
        expect(getAutoSubmitClockWindowState(['00:10'], 60, 'Europe/Riga', start)).toMatchObject({
            active: true,
            activeTimes: ['00:10'],
        });
    });

    test.each([
        [2026, 3, 29],
        [2026, 10, 25],
    ])('keeps existing wall-clock DST occurrence semantics on %i-%i-%i', (year, month, day) => {
        const start = epochForWallTime(year, month, day, 3, 30, 'Europe/Riga');
        const state = getAutoSubmitClockWindowState(['03:30'], 60, 'Europe/Riga', start);
        expect(state.active).toBe(true);
        expect(state.activeUntil).toBe(start + 3600);
    });

    test('keeps overlapping windows active until the latest end and finds the next daily start', () => {
        const now = utc(2026, 1, 15, 8, 40);
        const state = getAutoSubmitClockWindowState(['08:00', '08:30'], 60, 'UTC', now);
        expect(state).toMatchObject({
            active: true,
            activeTimes: ['08:00', '08:30'],
            activeUntil: utc(2026, 1, 15, 9, 30),
        });
        expect(state.nextStart).toBe(utc(2026, 1, 16, 8));
    });

    test('fails closed for empty or malformed settings', () => {
        expect(getAutoSubmitClockWindowState([], 60, 'UTC', utc(2026, 1, 15, 8))).toEqual({
            active: false,
            activeTimes: [],
            activeUntil: null,
            nextStart: null,
        });
        expect(getAutoSubmitClockWindowState(['08:20'], 'bad', 'UTC', utc(2026, 1, 15, 8, 20))).toMatchObject({
            active: false,
        });
        expect(getAutoSubmitClockWindowState(['08:20'], 0, 'UTC', utc(2026, 1, 15, 8, 20))).toMatchObject({
            active: false,
        });
        expect(getAutoSubmitClockWindowState('08:20', 60, 'UTC', utc(2026, 1, 15, 8, 20))).toMatchObject({
            active: false,
        });
        expect(getAutoSubmitClockWindowState(['08:20'], 60, 'UTC', Number.NaN)).toMatchObject({
            active: false,
        });
        expect(getAutoSubmitClockWindowState(['not-a-time', 20], 60, 'UTC', utc(2026, 1, 15, 8, 20))).toEqual({
            active: false,
            activeTimes: [],
            activeUntil: null,
            nextStart: null,
        });
    });
});

describe('soonestAutoSubmitClockBoundary', () => {
    test('prefers an active usable clock window and ignores ineligible settings and challenges', async () => {
        const now = utc(2026, 1, 15, 11, 30);
        const resolveClock = jest.fn(async (challengeId: string) => {
            switch (challengeId) {
                case '1':
                    return { enabled: true, manualPhotosOnly: false, times: ['12:00'], windowMinutes: 60 };
                case '2':
                case '10':
                    return { enabled: true, manualPhotosOnly: false, times: ['11:00'], windowMinutes: 60 };
                case '3':
                    return { enabled: false, manualPhotosOnly: false, times: ['11:00'], windowMinutes: 60 };
                case '4':
                    return { enabled: true, manualPhotosOnly: true, times: ['11:00'], windowMinutes: 60 };
                case '5':
                    throw new Error('unavailable settings');
                case '6':
                    return invalid<autoSubmitClockModule.AutoSubmitClockConfig>(null);
                default:
                    return { enabled: true, manualPhotosOnly: false, times: ['not-a-time'], windowMinutes: 60 };
            }
        });
        const result = await soonestAutoSubmitClockBoundary(
            invalid([
                {
                    id: 1,
                    title: 'Future',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                { id: 2, title: '', close_time: now + 10, max_photo_submits: 2, member: { ranking: {} } },
                {
                    id: 3,
                    title: 'Disabled',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                {
                    id: 4,
                    title: 'Manual',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                {
                    id: 5,
                    title: 'Unavailable',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                {
                    id: 6,
                    title: 'Missing',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                {
                    id: 7,
                    title: 'Invalid time',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                {
                    id: 8,
                    title: 'Full',
                    close_time: now + 7200,
                    max_photo_submits: 1,
                    member: { ranking: { entries: [{}] } },
                },
                { id: 9, title: 'Closed', close_time: now, max_photo_submits: 2, member: { ranking: { entries: [] } } },
                {
                    id: 10,
                    title: 'Also active',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
            ]),
            now,
            resolveClock,
            'UTC',
        );

        expect(result).toEqual({
            challengeId: 2,
            challengeTitle: 'challenge 2',
            startTime: now,
            endTime: now + 10,
            boundaryTime: now + 10,
            active: true,
            anyActive: true,
        });
        expect(resolveClock).not.toHaveBeenCalledWith('8');
        expect(resolveClock).not.toHaveBeenCalledWith('9');
    });

    test('chooses the earliest future clock window when none is active', async () => {
        const now = utc(2026, 1, 15, 9);
        const result = await soonestAutoSubmitClockBoundary(
            invalid([
                {
                    id: 1,
                    title: 'Later',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                {
                    id: 2,
                    title: 'Sooner',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
            ]),
            now,
            (challengeId) => ({
                enabled: true,
                manualPhotosOnly: false,
                times: [challengeId === '1' ? '12:00' : '10:00'],
                windowMinutes: 60,
            }),
            'UTC',
        );

        expect(result).toMatchObject({ challengeId: 2, challengeTitle: 'Sooner', startTime: utc(2026, 1, 15, 10) });
    });

    test('uses a future opening before an active window ends for one challenge with two times', async () => {
        const now = utc(2026, 1, 15, 12, 4);
        const result = await soonestAutoSubmitClockBoundary(
            invalid([
                {
                    id: 1,
                    title: 'Two windows',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
            ]),
            now,
            () => ({ enabled: true, manualPhotosOnly: false, times: ['12:00', '12:05'], windowMinutes: 60 }),
            'UTC',
        );
        expect(result).toMatchObject({
            challengeId: 1,
            active: false,
            anyActive: true,
            boundaryTime: utc(2026, 1, 15, 12, 5),
        });
    });

    test('uses a future opening from another challenge before an active window ends', async () => {
        const now = utc(2026, 1, 15, 12, 1);
        const result = await soonestAutoSubmitClockBoundary(
            invalid([
                {
                    id: 1,
                    title: 'Active',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                {
                    id: 2,
                    title: 'Upcoming',
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
            ]),
            now,
            (id) => ({
                enabled: true,
                manualPhotosOnly: false,
                times: [id === '1' ? '12:00' : '12:02'],
                windowMinutes: 60,
            }),
            'UTC',
        );
        expect(result).toMatchObject({
            challengeId: 2,
            active: false,
            anyActive: true,
            boundaryTime: utc(2026, 1, 15, 12, 2),
        });
    });

    test.each([
        ['1', '2'],
        ['2', '1'],
    ])('uses the earliest active window end in either input order: %p', async (...ids) => {
        const now = utc(2026, 1, 15, 12, 4);
        const result = await soonestAutoSubmitClockBoundary(
            invalid(
                ids.map((id) => ({
                    id: Number(id),
                    title: `Challenge ${id}`,
                    close_time: now + 7200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                })),
            ),
            now,
            (id) => ({
                enabled: true,
                manualPhotosOnly: false,
                times: [id === '1' ? '12:04' : '12:00'],
                windowMinutes: id === '1' ? 1 : 30,
            }),
            'UTC',
        );
        expect(result).toMatchObject({
            challengeId: 1,
            active: true,
            anyActive: true,
            boundaryTime: utc(2026, 1, 15, 12, 5),
        });
    });
});

describe('soonestAutoSubmitScheduleBoundary', () => {
    test('skips full, missing, invalid, disabled, manual-only, and exhausted schedules', async () => {
        const now = utc(2026, 1, 15, 12);
        const resolveSchedule = jest.fn((id: string) => {
            if (id === '4') return { enabled: false, manualPhotosOnly: false, schedule: [{ count: 2, seconds: 600 }] };
            if (id === '5') return { enabled: true, manualPhotosOnly: true, schedule: [{ count: 2, seconds: 600 }] };
            if (id === '8') return { enabled: true, manualPhotosOnly: false, schedule: [{ count: 2, seconds: 0 }] };
            return { enabled: true, manualPhotosOnly: false, schedule: [{ count: 2, seconds: 600 }] };
        });

        const result = await soonestAutoSubmitScheduleBoundary(
            invalid([
                { id: 1, close_time: now + 1200, max_photo_submits: 2, member: { ranking: { entries: [{}, {}] } } },
                { id: 2, close_time: now + 1200, member: { ranking: { entries: [] } } },
                { id: 3, close_time: now + 1200, max_photo_submits: Number.NaN, member: { ranking: { entries: [] } } },
                { id: 4, close_time: now + 1200, max_photo_submits: 2, member: { ranking: { entries: [] } } },
                { id: 5, close_time: now + 1200, max_photo_submits: 2, member: { ranking: { entries: [] } } },
                { id: 6, close_time: now + 1200, max_photo_submits: 3, member: { ranking: { entries: [{}, {}] } } },
                { id: 7, close_time: now, max_photo_submits: 2, member: { ranking: { entries: [] } } },
                { id: 8, close_time: now + 1200, max_photo_submits: 2, member: { ranking: { entries: [] } } },
            ]),
            now,
            resolveSchedule,
        );

        expect(result).toBeNull();
        expect(resolveSchedule).toHaveBeenCalledTimes(4);
        expect(resolveSchedule).not.toHaveBeenCalledWith('1');
        expect(resolveSchedule).not.toHaveBeenCalledWith('2');
        expect(resolveSchedule).not.toHaveBeenCalledWith('3');
        expect(resolveSchedule).not.toHaveBeenCalledWith('7');
    });

    test('skips a failed resolver and chooses the earliest future threshold with a title fallback', async () => {
        const now = utc(2026, 1, 15, 12);
        const result = await soonestAutoSubmitScheduleBoundary(
            invalid([
                {
                    id: 1,
                    title: 'Unavailable',
                    close_time: now + 1200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                {
                    id: 2,
                    title: 'Later',
                    close_time: now + 1800,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                { id: 3, title: '', close_time: now + 900, max_photo_submits: 2, member: { ranking: { entries: [] } } },
                {
                    id: 4,
                    title: 'Latest',
                    close_time: now + 2100,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
            ]),
            now,
            (id) => {
                if (id === '1') throw new Error('settings unavailable');
                return { enabled: true, manualPhotosOnly: false, schedule: [{ count: 2, seconds: 600 }] };
            },
        );

        expect(result).toEqual({
            challengeId: 3,
            challengeTitle: 'challenge 3',
            thresholdSec: 600,
            boundaryTime: now + 300,
            anyDue: false,
        });
    });

    test('starts eligible reads before either settles and retains another result after a rejection', async () => {
        const now = utc(2026, 1, 15, 12);
        let rejectFirst!: (reason?: unknown) => void;
        let resolveSecond!: (value: autoSubmitScheduleModule.AutoSubmitScheduleConfig) => void;
        const first = new Promise<autoSubmitScheduleModule.AutoSubmitScheduleConfig>((_resolve, reject) => {
            rejectFirst = reject;
        });
        const second = new Promise<autoSubmitScheduleModule.AutoSubmitScheduleConfig>((resolve) => {
            resolveSecond = resolve;
        });
        const resolveSchedule = jest.fn((id: string) => (id === '1' ? first : second));

        const result = soonestAutoSubmitScheduleBoundary(
            invalid([
                {
                    id: 1,
                    title: 'Rejected',
                    close_time: now + 1200,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                {
                    id: 2,
                    title: 'Resolved',
                    close_time: now + 900,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
            ]),
            now,
            resolveSchedule,
        );

        expect(resolveSchedule).toHaveBeenNthCalledWith(1, '1');
        expect(resolveSchedule).toHaveBeenNthCalledWith(2, '2');
        rejectFirst(new Error('settings unavailable'));
        resolveSecond({ enabled: true, manualPhotosOnly: false, schedule: [{ count: 2, seconds: 600 }] });

        await expect(result).resolves.toEqual({
            challengeId: 2,
            challengeTitle: 'Resolved',
            thresholdSec: 600,
            boundaryTime: now + 300,
            anyDue: false,
        });
    });

    test('reports due work while retaining the earliest future threshold', async () => {
        const now = utc(2026, 1, 15, 12);
        const result = await soonestAutoSubmitScheduleBoundary(
            invalid([
                {
                    id: 1,
                    title: 'Due',
                    close_time: now + 600,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
                {
                    id: 2,
                    title: 'Future',
                    close_time: now + 900,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
            ]),
            now,
            () => ({ enabled: true, manualPhotosOnly: false, schedule: [{ count: 2, seconds: 600 }] }),
        );

        expect(result).toEqual({
            challengeId: 2,
            challengeTitle: 'Future',
            thresholdSec: 600,
            boundaryTime: now + 300,
            anyDue: true,
        });
    });

    test('reports an only-due threshold without a synthetic future boundary', async () => {
        const now = utc(2026, 1, 15, 12);
        const result = await soonestAutoSubmitScheduleBoundary(
            invalid([
                {
                    id: 1,
                    title: 'Due',
                    close_time: now + 600,
                    max_photo_submits: 2,
                    member: { ranking: { entries: [] } },
                },
            ]),
            now,
            () => ({ enabled: true, manualPhotosOnly: false, schedule: [{ count: 2, seconds: 600 }] }),
        );

        expect(result).toEqual({
            challengeId: 1,
            challengeTitle: 'Due',
            thresholdSec: 600,
            boundaryTime: null,
            anyDue: true,
        });
    });
});
