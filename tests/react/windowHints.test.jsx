/**
 * Unit tests for deriveWindowHints — the pure derivation behind the settings
 * modal's scheduled-fill and voting-pause hints.
 *
 * Its contract is that it stays in step with `_triggerWindowState` in
 * services/VotingLogic.js: same cap slice, same "active needs a usable entry"
 * rule, same corrupt-value fallbacks. A hint must never promise a window the
 * decision path won't open.
 */
import { deriveWindowHints } from '@/utils/windowHints';

const NOW = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);

const PAUSE_KEYS = {
    enabled: 'useVotingPause',
    times: 'votingPauseTime',
    beforeEnd: 'votingPauseBeforeEnd',
    duration: 'votingPauseDurationMinutes',
};

const derive = (values, { closeTime = NOW + 7200, nowSec = NOW, ...policy } = {}) =>
    deriveWindowHints({
        keys: PAUSE_KEYS,
        defaultDurationMin: 240,
        effectiveOf: (key) => values[key],
        timezone: 'UTC',
        nowSec,
        closeTime,
        ...policy,
    });

describe('deriveWindowHints', () => {
    test('disabled → inactive even with entries configured', () => {
        const state = derive({ useVotingPause: false, votingPauseTime: ['01:30'], votingPauseBeforeEnd: [7200] });
        expect(state.enabled).toBe(false);
        expect(state.active).toBe(false);
    });

    test('enabled with no usable entry → inactive (never claims a window)', () => {
        const state = derive({ useVotingPause: true, votingPauseTime: [], votingPauseBeforeEnd: [] });
        expect(state.active).toBe(false);
        expect(state.next).toBeNull();
        expect(state.openNow).toBe(false);
    });

    test('a daily entry resolves to its currently-open occurrence', () => {
        // 01:30 + 270m == 06:00; at 03:00 the pause is open.
        const at3am = Math.floor(Date.UTC(2026, 0, 15, 3, 0, 0) / 1000);
        const state = derive(
            { useVotingPause: true, votingPauseTime: ['01:30'], votingPauseDurationMinutes: 270 },
            { nowSec: at3am, closeTime: at3am + 86400 },
        );
        expect(state.active).toBe(true);
        expect(state.openNow).toBe(true);
        expect(state.next.start).toBe(Math.floor(Date.UTC(2026, 0, 15, 1, 30, 0) / 1000));
        expect(state.next.source).toEqual({ kind: 'time', value: '01:30' });
    });

    test('a daily entry whose window has closed resolves to TOMORROW, not now', () => {
        const state = derive({ useVotingPause: true, votingPauseTime: ['01:30'], votingPauseDurationMinutes: 270 });
        expect(state.openNow).toBe(false);
        expect(state.next.start).toBe(Math.floor(Date.UTC(2026, 0, 16, 1, 30, 0) / 1000));
    });

    test('before-end entries carry their offset as data, not a rendered string', () => {
        const state = derive({ useVotingPause: true, votingPauseBeforeEnd: [7200] });
        expect(state.next.source).toEqual({ kind: 'beforeEnd', seconds: 7200 });
        expect(state.openNow).toBe(true);
    });

    test('a before-end window entirely in the past is not offered', () => {
        // Close is 2h away; a 10h-before-close window with a 60m duration ended long ago.
        const state = derive({
            useVotingPause: true,
            votingPauseBeforeEnd: [36000],
            votingPauseDurationMinutes: 60,
        });
        expect(state.active).toBe(true);
        expect(state.next).toBeNull();
    });

    test('an already-closed challenge yields no before-end candidates', () => {
        const state = derive({ useVotingPause: true, votingPauseBeforeEnd: [7200] }, { closeTime: NOW - 1 });
        expect(state.next).toBeNull();
    });

    test('the soonest candidate across BOTH lists wins', () => {
        const state = derive({
            useVotingPause: true,
            votingPauseTime: ['23:00'], // later today
            votingPauseBeforeEnd: [7200], // starts right now
            votingPauseDurationMinutes: 60,
        });
        expect(state.next.source).toEqual({ kind: 'beforeEnd', seconds: 7200 });
    });

    describe('duration policy matches the decision path', () => {
        test("onCorruptDuration 'off' disables the feature, as getVotingPauseState does", () => {
            const state = derive(
                { useVotingPause: true, votingPauseTime: ['11:30'], votingPauseDurationMinutes: 'soon' },
                { onCorruptDuration: 'off' },
            );
            expect(state.enabled).toBe(false);
            expect(state.active).toBe(false);
        });

        test("onCorruptDuration 'default' substitutes, as getScheduledFillState does", () => {
            const state = derive({
                useVotingPause: true,
                votingPauseTime: ['11:30'],
                votingPauseDurationMinutes: 'soon',
            });
            expect(state.durationMin).toBe(240);
            expect(state.active).toBe(true);
        });

        test('a NEGATIVE duration is corrupt here too, matching the engine', () => {
            // A `Number(x) || default` shortcut would have honoured -30 and
            // produced a window the decision path never opens.
            const state = derive({
                useVotingPause: true,
                votingPauseTime: ['11:30'],
                votingPauseDurationMinutes: -30,
            });
            expect(state.durationMin).toBe(240);
        });

        test('maxDurationMin clamps, as getVotingPauseState does', () => {
            const state = derive(
                { useVotingPause: true, votingPauseTime: ['11:30'], votingPauseDurationMinutes: 100000 },
                { maxDurationMin: 720 },
            );
            expect(state.durationMin).toBe(720);
        });
    });

    test('duplicate daily starts do not fake whole-day coverage', () => {
        const state = derive({
            useVotingPause: true,
            votingPauseTime: ['01:00', '01:00'],
            votingPauseDurationMinutes: 720,
        });
        expect(state.coversWholeDay).toBe(false);
    });

    test('corrupt values degrade rather than throw', () => {
        const state = derive({
            useVotingPause: true,
            votingPauseTime: 'nonsense',
            votingPauseBeforeEnd: { nope: true },
            votingPauseDurationMinutes: 'soon',
        });
        expect(state.times).toEqual([]);
        expect(state.beforeEnds).toEqual([]);
        expect(state.active).toBe(false);
        // Corrupt duration falls back to the caller's schema default.
        expect(state.durationMin).toBe(240);
    });

    test('unparseable time entries are dropped and never make the feature active', () => {
        const state = derive({ useVotingPause: true, votingPauseTime: ['24:00', '1:30'] });
        expect(state.timeOccs).toEqual([]);
        expect(state.timeSet).toBe(false);
        expect(state.active).toBe(false);
    });

    test('non-positive before-end entries are dropped', () => {
        const state = derive({ useVotingPause: true, votingPauseBeforeEnd: [0, -5, 7200] });
        expect(state.beforeEnds).toEqual([7200]);
    });

    describe('coversWholeDay', () => {
        test('a single window never covers the day (duration is capped well below 24h)', () => {
            const state = derive({
                useVotingPause: true,
                votingPauseTime: ['01:30'],
                votingPauseDurationMinutes: 720,
            });
            expect(state.coversWholeDay).toBe(false);
        });

        test('two 12h windows exactly 12h apart DO cover the day', () => {
            const state = derive({
                useVotingPause: true,
                votingPauseTime: ['00:00', '12:00'],
                votingPauseDurationMinutes: 720,
            });
            expect(state.coversWholeDay).toBe(true);
        });

        test('two 12h windows only 1h apart do NOT cover the day', () => {
            // The case a naive "entries × duration >= 24h" check got wrong:
            // these overlap heavily and leave 11h uncovered.
            const state = derive({
                useVotingPause: true,
                votingPauseTime: ['01:00', '02:00'],
                votingPauseDurationMinutes: 720,
            });
            expect(state.coversWholeDay).toBe(false);
        });

        test('coverage is circular — a gap spanning midnight still counts as covered', () => {
            // 22:00 + 8h reaches 06:00, and 06:00 + 8h reaches 14:00,
            // and 14:00 + 8h reaches 22:00 → no gap anywhere.
            const state = derive({
                useVotingPause: true,
                votingPauseTime: ['22:00', '06:00', '14:00'],
                votingPauseDurationMinutes: 480,
            });
            expect(state.coversWholeDay).toBe(true);
        });

        test('one gap anywhere in the circle is enough to not cover the day', () => {
            // Same three starts, one minute short of meeting.
            const state = derive({
                useVotingPause: true,
                votingPauseTime: ['22:00', '06:00', '14:00'],
                votingPauseDurationMinutes: 479,
            });
            expect(state.coversWholeDay).toBe(false);
        });

        test('the reported 01:30 night pause is nowhere near all-day', () => {
            const state = derive({
                useVotingPause: true,
                votingPauseTime: ['01:30'],
                votingPauseDurationMinutes: 270,
            });
            expect(state.coversWholeDay).toBe(false);
        });

        test('inactive features never report all-day coverage', () => {
            const state = derive({
                useVotingPause: false,
                votingPauseTime: ['00:00', '12:00'],
                votingPauseDurationMinutes: 720,
            });
            expect(state.coversWholeDay).toBe(false);
        });
    });

    test('both lists are capped at the shared entry limit', () => {
        const state = derive({
            useVotingPause: true,
            votingPauseTime: ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00'],
            votingPauseBeforeEnd: [1, 2, 3, 4, 5, 6, 7, 8],
        });
        expect(state.times).toHaveLength(6);
        expect(state.beforeEnds).toHaveLength(6);
    });
});
