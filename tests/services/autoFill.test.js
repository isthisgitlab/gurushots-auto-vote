/**
 * Tests for autoFill.js — both the staggered scheduler entry point
 * (maybeAutoFillChallenge) and the manual GUI entry point (fillChallengeNow).
 */

const {
    maybeAutoFillChallenge,
    maybeEmergencyFillChallenge,
    fillChallengeNow,
    submitNewEntryForAction,
    reflectNewEntry,
    getSlotsRemaining,
    fetchCandidatesForChallenge,
    describeSubmitFailure,
    resolveScheduleTarget,
    getNextScheduleThresholdSec,
} = require('../../src/js/services/autoFill');

// Mirrors the schema default: "have ≥2 entries at T-30m, ≥3 at T-20m, ≥4 at
// T-10m" — the schedule equivalent of the old 10-minute interval on a 4-slot
// challenge.
const DEFAULT_SCHEDULE = [
    { count: 2, seconds: 1800 },
    { count: 3, seconds: 1200 },
    { count: 4, seconds: 600 },
];

const makeChallenge = ({
    id = 'c1',
    closeIn = 600,
    maxSubmits = 4,
    entries = [],
    title = 'Pink In Nature',
    url = 'pink-in-nature23',
} = {}) => ({
    id,
    title,
    url,
    max_photo_submits: maxSubmits,
    close_time: 1_000_000 + closeIn,
    member: { ranking: { entries } },
});

const NOW = 1_000_000;
const allowedPhoto = (id, labels = ['Pink'], uploadDate = 9000) => ({
    id,
    labels,
    upload_date: uploadDate,
    permission: { allowed: true, message: null },
});

const makeLogger = () => ({
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        warning: jest.fn(),
        success: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
    challengeTag: (c, t) =>
        c && typeof c === 'object'
            ? `[Challenge ${c.id ?? 'unknown'}: ${c.title ?? 'unknown'}]`
            : `[Challenge ${c ?? 'unknown'}: ${t ?? 'unknown'}]`,
});

const makeSettings = ({
    autoFill = false,
    schedule = DEFAULT_SCHEDULE,
    mustIncludeTags = [],
    shouldIncludeTags = [],
    fillWithoutTagMatch = true, // mirrors the schema default
    emergencyFill = 300, // mirrors the schema default (5 minutes in seconds)
} = {}) => ({
    getEffectiveSetting: jest.fn((key) => {
        if (key === 'autoFill') return autoFill;
        if (key === 'autoFillSchedule') return schedule;
        if (key === 'mustIncludeTags') return mustIncludeTags;
        if (key === 'shouldIncludeTags') return shouldIncludeTags;
        if (key === 'fillWithoutTagMatch') return fillWithoutTagMatch;
        if (key === 'emergencyFill') return emergencyFill;
        return null;
    }),
    // Title-aware tag resolver. The default stub carries no title rules, so it
    // resolves to the same tag values as getEffectiveSetting; the merge-by-title
    // behavior is covered in tests/settings/title-tag-rules.test.js.
    getEffectiveTagSetting: jest.fn((key) => {
        if (key === 'mustIncludeTags') return mustIncludeTags;
        if (key === 'shouldIncludeTags') return shouldIncludeTags;
        return null;
    }),
});

describe('maybeAutoFillChallenge — staggered auto-fill', () => {
    test('returns disabled when autoFill setting is false', async () => {
        const challenge = makeChallenge({ entries: [{ id: 'e1' }] });
        const getEligiblePhotos = jest.fn();
        const submitToChallenge = jest.fn();
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('disabled');
        expect(getEligiblePhotos).not.toHaveBeenCalled();
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('returns skipped when challenge already closed', async () => {
        const challenge = makeChallenge({ closeIn: -10 });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
    });

    test('returns skipped when no slots remaining', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }, { id: 'e2' }] });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
    });

    test('schedule: 2 entries at T-25m → target 2 already met → skipped (too early)', async () => {
        // Only the {count:2, seconds:1800} row applies at T-25m; entries=2 satisfies it.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }, { id: 'e2' }], closeIn: 25 * 60 });
        const getEligiblePhotos = jest.fn();
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
        expect(getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('schedule: 2 entries at T-19m → target 3 → submits', async () => {
        // At T-19m the {count:3, seconds:1200} row applies; entries=2 < 3.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }, { id: 'e2' }], closeIn: 19 * 60 });
        const getEligiblePhotos = jest.fn().mockResolvedValue([allowedPhoto('p1', ['Pink'])]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        // Theme-narrowed fetch: the title "Pink In Nature" derives search
        // terms, so the eligible-photo fetch is issued with a `search` filter
        // rather than the bare 2-arg call.
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok', { search: 'pink' });
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['p1'], 'tok');
    });

    test('schedule: single {2 @ T-10m} row, T-11m → not yet due → skipped', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 11 * 60 });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, schedule: [{ count: 2, seconds: 600 }] }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
    });

    test('schedule: single {2 @ T-10m} row, T-9m → due → submits', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 9 * 60 });
        const getEligiblePhotos = jest.fn().mockResolvedValue([allowedPhoto('p1')]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, schedule: [{ count: 2, seconds: 600 }] }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('submitted');
    });

    test('only one photo is submitted per call (the staggering trick)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const getEligiblePhotos = jest
            .fn()
            .mockResolvedValue([allowedPhoto('p1'), allowedPhoto('p2'), allowedPhoto('p3'), allowedPhoto('p4')]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(submitToChallenge).toHaveBeenCalledTimes(1);
        const submittedIds = submitToChallenge.mock.calls[0][1];
        expect(submittedIds).toHaveLength(1);
    });

    test('returns no-eligible-photos when picker returns empty', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }], closeIn: 5 * 60 });
        const getEligiblePhotos = jest.fn().mockResolvedValue([]);
        const submitToChallenge = jest.fn();
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('no-eligible-photos');
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('returns error when getEligiblePhotos throws', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const getEligiblePhotos = jest.fn().mockRejectedValue(new Error('network'));
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('error');
    });

    test('returns error when submit returns ok=false', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: false, raw: null }),
        });
        expect(result).toBe('error');
    });

    test('returns error when submit throws (no crash)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockRejectedValue(new Error('boom')),
        });
        expect(result).toBe('error');
    });

    test('returns skipped when challenge has no id', async () => {
        const result = await maybeAutoFillChallenge({ title: 'orphan' }, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
    });

    test('treats non-array entries as 0 (defensive against malformed API)', async () => {
        const challenge = {
            id: 'c1',
            max_photo_submits: 4,
            close_time: NOW + 5 * 60,
            member: { ranking: { entries: 'oops' } },
        };
        const getEligiblePhotos = jest.fn().mockResolvedValue([allowedPhoto('p1')]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        // slotsRemaining = max(0, 4 - 0) = 4; at T-5m every row applies → target 4 > 0 → submits
        expect(result).toBe('submitted');
    });

    test('treats missing max_photo_submits as 0 (skipped — no slots)', async () => {
        const challenge = {
            id: 'c1',
            close_time: NOW + 5 * 60,
            member: { ranking: { entries: [] } },
        };
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
    });

    test('returns skipped when close_time is not a finite number', async () => {
        const challenge = {
            id: 'c1',
            close_time: 'not-a-number',
            max_photo_submits: 4,
            member: { ranking: { entries: [] } },
        };
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
    });

    test('returns no-schedule when the schedule setting is not an array (null)', async () => {
        // Toggle on but no usable schedule: a deliberate opt-out state,
        // distinct from 'disabled' (toggle off).
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }, { id: 'e2' }], closeIn: 15 * 60 });
        const getEligiblePhotos = jest.fn();
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, schedule: null }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('no-schedule');
        expect(getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('returns no-schedule for an empty-array schedule', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, schedule: [] }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('no-schedule');
    });

    test('returns no-schedule for a non-array (string) schedule', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, schedule: 'garbage' }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('no-schedule');
    });

    test('malformed non-empty schedule rows → skipped (desired 0), never throws', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn();
        await expect(
            maybeAutoFillChallenge(challenge, 'tok', NOW, {
                settings: makeSettings({ autoFill: true, schedule: [{ count: 'x' }] }),
                logger: makeLogger(),
                getEligiblePhotos: jest.fn(),
                submitToChallenge,
            }),
        ).resolves.toBe('skipped');
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('catch-up: entries far below the current target still submit one per call', async () => {
        // T-5m → target 4, but only 1 entry exists (the app was behind
        // schedule). One photo goes in now; the next cycle catches up further.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1'), allowedPhoto('p2')]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(submitToChallenge).toHaveBeenCalledTimes(1);
        expect(submitToChallenge.mock.calls[0][1]).toHaveLength(1);
    });

    test('logs a coverage-gap warning when the schedule tops out below max_photo_submits', async () => {
        // Schedule tops out at 4 but the challenge allows 6: with 4 entries and
        // the schedule satisfied, the remaining 2 slots are left to emergency
        // fill — a WARNING must say so (debug/info are compiled out of packaged
        // builds).
        const warning = jest.fn();
        const logger = {
            withCategory: () => ({ info: jest.fn(), warning, success: jest.fn(), error: jest.fn(), debug: jest.fn() }),
            challengeTag: (c) => `[Challenge ${c.id}]`,
        };
        const challenge = makeChallenge({
            maxSubmits: 6,
            entries: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }, { id: 'e4' }],
            closeIn: 5 * 60, // inside every row's window → desired = 4 (the schedule's top)
        });
        const submitToChallenge = jest.fn();
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger,
            getEligiblePhotos: jest.fn(),
            submitToChallenge,
        });
        expect(result).toBe('skipped');
        expect(submitToChallenge).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('schedule tops out at 4 entries'), null);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('allows 6'), null);
    });

    test('mustIncludeTags hard-filters: with fillWithoutTagMatch off, no-match photo is not submitted', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                mustIncludeTags: ['sunset'],
                fillWithoutTagMatch: false,
            }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Cat'])]),
            submitToChallenge,
        });
        expect(result).toBe('no-eligible-photos');
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('fillWithoutTagMatch default ON: no-match photo IS submitted (fallback)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            // fillWithoutTagMatch defaults to true in makeSettings
            settings: makeSettings({
                autoFill: true,
                mustIncludeTags: ['sunset'],
            }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Cat'])]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['p1'], 'tok');
    });

    test('fillWithoutTagMatch does NOT override an actual match (matching photo still wins)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                mustIncludeTags: ['sunset'],
                fillWithoutTagMatch: true,
            }),
            logger: makeLogger(),
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([allowedPhoto('match', ['Sunset']), allowedPhoto('other', ['Cat'])]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['match'], 'tok');
    });

    test('mustIncludeTags lets matching photo through', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                mustIncludeTags: ['sunset'],
            }),
            logger: makeLogger(),
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([allowedPhoto('keep', ['Sunset']), allowedPhoto('drop', ['Cat'])]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['keep'], 'tok');
    });

    test('multi-tag ALL: photo missing one required tag is not submitted (fillWithoutTagMatch off)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                mustIncludeTags: ['sunset', 'beach'],
                fillWithoutTagMatch: false,
            }),
            logger: makeLogger(),
            // Only carries one of the two required tags → excluded under ALL.
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Sunset'])]),
            submitToChallenge,
        });
        expect(result).toBe('no-eligible-photos');
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('multi-tag ALL: full match wins over partial match', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                mustIncludeTags: ['sunset', 'beach'],
                fillWithoutTagMatch: true,
            }),
            logger: makeLogger(),
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([allowedPhoto('full', ['Sunset', 'Beach']), allowedPhoto('partial', ['Sunset'])]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        // 'partial' is excluded; 'full' matches every tag so the fallback never fires.
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['full'], 'tok');
    });

    test('multi-tag ALL: no photo matches all tags → fallback fires (default on)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            // fillWithoutTagMatch defaults to true in makeSettings
            settings: makeSettings({
                autoFill: true,
                mustIncludeTags: ['sunset', 'beach'],
            }),
            logger: makeLogger(),
            // Each photo carries only one of the two required tags, so the ALL
            // filter empties out and the default-on fallback submits anyway.
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([allowedPhoto('p1', ['Sunset']), allowedPhoto('p2', ['Beach'])]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(submitToChallenge).toHaveBeenCalled();
    });

    test('getEffectiveSetting returning null for tag settings means "no filter"', async () => {
        // Real settings.js can return null when no global default is set;
        // tokeniseTagList handles null/undefined → []. Verify the picker
        // is reached with both photos eligible.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const settings = {
            getEffectiveSetting: jest.fn((key) => {
                if (key === 'autoFill') return true;
                if (key === 'autoFillSchedule') return DEFAULT_SCHEDULE;
                return null;
            }),
            // No title rule + null base → stays null ("no filter").
            getEffectiveTagSetting: jest.fn(() => null),
        };
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings,
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Cat'])]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
    });

    test('tag lists resolve via getEffectiveTagSetting with the full challenge (enables title rules)', async () => {
        // Title-based rules need the challenge title, so the engine must resolve
        // tags through getEffectiveTagSetting(key, challenge), not the id-only
        // getEffectiveSetting(key, id). Guard the wiring against regressions.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const settings = makeSettings({ autoFill: true, mustIncludeTags: ['hat'] });
        await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings,
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Hat'])]),
            submitToChallenge,
        });
        expect(settings.getEffectiveTagSetting).toHaveBeenCalledWith('mustIncludeTags', challenge);
        expect(settings.getEffectiveTagSetting).toHaveBeenCalledWith('shouldIncludeTags', challenge);
    });

    test('shouldIncludeTags re-orders pick within the eligible set', async () => {
        // Without should: 'themed' wins via keyword score (label "Pink" matches challenge "pink").
        // With should=['sunset']: 'preferred' wins despite zero keyword score.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                shouldIncludeTags: ['sunset'],
            }),
            logger: makeLogger(),
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([allowedPhoto('themed', ['Pink']), allowedPhoto('preferred', ['Sunset'])]),
            submitToChallenge,
        });
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['preferred'], 'tok');
    });

    test('error path handles thrown non-Error gracefully (no .message)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const fetchResult = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockRejectedValue('string-not-error'),
            submitToChallenge: jest.fn(),
        });
        expect(fetchResult).toBe('error');

        const submitResult = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockRejectedValue('also-not-error'),
        });
        expect(submitResult).toBe('error');
    });
});

describe('maybeEmergencyFillChallenge — last-resort fill near deadline', () => {
    test('returns disabled when emergencyFill is 0 (off)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const getEligiblePhotos = jest.fn();
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 0 }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('disabled');
        expect(getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('returns disabled when emergencyFill is non-numeric', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: null }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('disabled');
    });

    test('returns skipped outside the emergency window (T-30m, emergencyFill 300s)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 30 * 60 });
        const getEligiblePhotos = jest.fn();
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
        expect(getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('themed search returns nothing → unfiltered fallback + must-relax still fills at the buzzer', async () => {
        // Two fallback layers compose: the Must-tag search ('sunset') returns no
        // photo, so fetchCandidatesForChallenge relaxes to the full library; then
        // the picker's fillWithoutTagMatch:true (forced by emergency fill) relaxes
        // the must-filter so an off-theme photo is submitted rather than no photo.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const getEligiblePhotos = jest.fn(async (_id, _tok, opts) =>
            opts && opts.search ? [] : [allowedPhoto('off', ['Cat'])],
        );
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300, mustIncludeTags: ['sunset'] }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok', { search: 'sunset' });
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok'); // unfiltered fallback
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['off'], 'tok');
    });

    test('resolves tag lists via getEffectiveTagSetting with the full challenge (enables title rules)', async () => {
        // Wiring guard: emergency fill must resolve tags by challenge (title), not id.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const settings = makeSettings({ autoFill: false, emergencyFill: 300 });
        await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings,
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Cat'])]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
        });
        expect(settings.getEffectiveTagSetting).toHaveBeenCalledWith('mustIncludeTags', challenge);
        expect(settings.getEffectiveTagSetting).toHaveBeenCalledWith('shouldIncludeTags', challenge);
    });

    test('returns skipped when challenge already closed', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: -10 });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
    });

    test('auto-fill OFF, in window: fills ALL empty slots in one submission', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const getEligiblePhotos = jest
            .fn()
            .mockResolvedValue([allowedPhoto('p1'), allowedPhoto('p2'), allowedPhoto('p3'), allowedPhoto('p4')]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(submitToChallenge).toHaveBeenCalledTimes(1);
        expect(submitToChallenge.mock.calls[0][1]).toHaveLength(4);
    });

    test('auto-fill OFF, must tags set with a match: prefers the matching photo', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 3 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: false,
                emergencyFill: 300,
                mustIncludeTags: ['sunset'],
                fillWithoutTagMatch: false,
            }),
            logger: makeLogger(),
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([allowedPhoto('match', ['Sunset']), allowedPhoto('other', ['Cat'])]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        // 1 empty slot; the must-include preference is honored when a match exists,
        // even though emergency fill forces fillWithoutTagMatch on as a fallback.
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['match'], 'tok');
    });

    test('auto-fill ON, must tags set with no match and fallback off: relaxes filter and submits', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 3 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                emergencyFill: 300,
                mustIncludeTags: ['sunset'],
                fillWithoutTagMatch: false,
            }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Cat'])]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        // 1 empty slot; the must-include filter is relaxed so the non-matching photo is used.
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['p1'], 'tok');
    });

    test('auto-fill ON, tags match: stands down so it never double-fills', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const submitToChallenge = jest.fn();
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                emergencyFill: 300,
                mustIncludeTags: ['sunset'],
            }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Sunset'])]),
            submitToChallenge,
        });
        expect(result).toBe('skipped');
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('auto-fill ON, no tag filter: stands down without fetching photos', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const getEligiblePhotos = jest.fn();
        const submitToChallenge = jest.fn();
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('skipped');
        // Common config: normal auto-fill owns it, so emergency fill must not
        // burn an API call fetching eligible photos it would only discard.
        expect(getEligiblePhotos).not.toHaveBeenCalled();
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('auto-fill ON, must tags set but fillWithoutTagMatch on: stands down (staggered path has a fallback)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const submitToChallenge = jest.fn();
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                emergencyFill: 300,
                mustIncludeTags: ['sunset'],
                // fillWithoutTagMatch defaults true → the picker relaxes, so the
                // normal staggered path can still fill the slot. Emergency stands down.
            }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Cat'])]),
            submitToChallenge,
        });
        expect(result).toBe('skipped');
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('fires at the exact window boundary (secondsRemaining === emergencyFill)', async () => {
        // Window guard is `secondsRemaining > emergencyFill` → the exact
        // boundary is inside the window, mirroring the staggered fill convention.
        const challenge = makeChallenge({ maxSubmits: 2, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1'), allowedPhoto('p2')]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(submitToChallenge.mock.calls[0][1]).toHaveLength(2);
    });

    test('returns skipped when no slots remaining (does not fetch photos)', async () => {
        const challenge = makeChallenge({ maxSubmits: 1, entries: [{ id: 'e1' }], closeIn: 3 * 60 });
        const getEligiblePhotos = jest.fn();
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
        expect(getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('returns no-eligible-photos when triggered but nothing to submit', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const submitToChallenge = jest.fn();
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([]),
            submitToChallenge,
        });
        expect(result).toBe('no-eligible-photos');
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('returns error when getEligiblePhotos throws', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockRejectedValue(new Error('network')),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('error');
    });

    test('returns error when submit returns ok=false', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: false, raw: null }),
        });
        expect(result).toBe('error');
    });

    test('returns error when submit throws (Error and non-Error are both caught)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const errResult = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockRejectedValue(new Error('boom')),
        });
        expect(errResult).toBe('error');

        const nonErrResult = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockRejectedValue('string-not-error'),
        });
        expect(nonErrResult).toBe('error');
    });

    test('returns skipped when challenge has no id', async () => {
        const result = await maybeEmergencyFillChallenge({ title: 'orphan' }, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
    });
});

describe('fillChallengeNow — manual fill', () => {
    test("mode='one' submits exactly 1 photo regardless of slots remaining", async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await fillChallengeNow(challenge, 'tok', 'one', {
            logger: makeLogger(),
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([allowedPhoto('p1'), allowedPhoto('p2'), allowedPhoto('p3')]),
            submitToChallenge,
        });
        expect(result.success).toBe(true);
        expect(result.submitted).toBe(1);
        expect(result.skipped).toBe(3);
        expect(submitToChallenge).toHaveBeenCalledWith('c1', expect.arrayContaining([expect.any(String)]), 'tok');
        expect(submitToChallenge.mock.calls[0][1]).toHaveLength(1);
    });

    test("mode='all' submits up to slotsRemaining in one batch", async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }], closeIn: 86400 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await fillChallengeNow(challenge, 'tok', 'all', {
            logger: makeLogger(),
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([allowedPhoto('p1'), allowedPhoto('p2'), allowedPhoto('p3'), allowedPhoto('p4')]),
            submitToChallenge,
        });
        expect(result.success).toBe(true);
        expect(result.submitted).toBe(3);
        expect(result.skipped).toBe(0);
        expect(submitToChallenge.mock.calls[0][1]).toHaveLength(3);
    });

    test('manual ignores autoFill toggle (operates on disabled challenges)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const result = await fillChallengeNow(challenge, 'tok', 'one', {
            logger: makeLogger(),
            // No settings module passed — proves manual doesn't read it.
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
        });
        expect(result.success).toBe(true);
        expect(result.submitted).toBe(1);
    });

    test('no slots remaining → success with 0 submissions, no API calls', async () => {
        const challenge = makeChallenge({ maxSubmits: 1, entries: [{ id: 'e1' }], closeIn: 86400 });
        const getEligiblePhotos = jest.fn();
        const submitToChallenge = jest.fn();
        const result = await fillChallengeNow(challenge, 'tok', 'all', {
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result.success).toBe(true);
        expect(result.submitted).toBe(0);
        expect(getEligiblePhotos).not.toHaveBeenCalled();
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('no eligible photos → success=false with skipped count + error', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const result = await fillChallengeNow(challenge, 'tok', 'all', {
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([]),
            submitToChallenge: jest.fn(),
        });
        expect(result.success).toBe(false);
        expect(result.submitted).toBe(0);
        expect(result.skipped).toBe(4);
        expect(result.error).toMatch(/no eligible photos/i);
    });

    test('submit ok=false → success=false', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const result = await fillChallengeNow(challenge, 'tok', 'one', {
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: false, raw: null }),
        });
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    test('submit throws → caught, returns success=false', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const result = await fillChallengeNow(challenge, 'tok', 'one', {
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockRejectedValue(new Error('boom')),
        });
        expect(result.success).toBe(false);
        expect(result.error).toBe('boom');
    });

    test('returns invalid-challenge when challenge has no id', async () => {
        const result = await fillChallengeNow({ title: 'orphan' }, 'tok', 'one', {
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/invalid challenge/i);
    });

    test('getEligiblePhotos throws → returns success=false with skipped count + error', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }], closeIn: 86400 });
        const result = await fillChallengeNow(challenge, 'tok', 'all', {
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockRejectedValue(new Error('network down')),
            submitToChallenge: jest.fn(),
        });
        expect(result.success).toBe(false);
        expect(result.skipped).toBe(3);
        expect(result.error).toBe('network down');
    });

    test('getEligiblePhotos throws non-Error → uses fallback message', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [], closeIn: 86400 });
        const result = await fillChallengeNow(challenge, 'tok', 'one', {
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockRejectedValue({}),
            submitToChallenge: jest.fn(),
        });
        expect(result.success).toBe(false);
        expect(result.error).toBe('Failed to fetch photos');
    });

    test('submitToChallenge throws non-Error → uses fallback "Submit failed"', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [], closeIn: 86400 });
        const result = await fillChallengeNow(challenge, 'tok', 'one', {
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockRejectedValue({}),
        });
        expect(result.success).toBe(false);
        expect(result.error).toBe('Submit failed');
    });

    test('mustIncludeTags gates manual fill when fillWithoutTagMatch is off', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const submitToChallenge = jest.fn();
        const result = await fillChallengeNow(challenge, 'tok', 'all', {
            settings: makeSettings({ mustIncludeTags: ['mountain'], fillWithoutTagMatch: false }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Cat']), allowedPhoto('p2', ['Sky'])]),
            submitToChallenge,
        });
        expect(result.success).toBe(false);
        // Candidates existed but the must-filter removed them all → the error
        // names the filter rather than the generic "no eligible photos".
        expect(result.error).toMatch(/must include tags/i);
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('manual fill falls back (default) when no photo matches the must tags', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await fillChallengeNow(challenge, 'tok', 'one', {
            // fillWithoutTagMatch defaults true
            settings: makeSettings({ mustIncludeTags: ['mountain'] }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Cat']), allowedPhoto('p2', ['Sky'])]),
            submitToChallenge,
        });
        expect(result.success).toBe(true);
        expect(result.submitted).toBe(1);
        expect(submitToChallenge).toHaveBeenCalled();
    });

    test('generic "no eligible photos" message when there were no candidates at all', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const result = await fillChallengeNow(challenge, 'tok', 'all', {
            settings: makeSettings({ mustIncludeTags: ['mountain'], fillWithoutTagMatch: false }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([]),
            submitToChallenge: jest.fn(),
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/no eligible photos/i);
    });

    test('shouldIncludeTags re-orders manual pick', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }], closeIn: 86400 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        await fillChallengeNow(challenge, 'tok', 'one', {
            settings: makeSettings({ shouldIncludeTags: ['sunset'] }),
            logger: makeLogger(),
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([allowedPhoto('themed', ['Pink']), allowedPhoto('preferred', ['Sunset'])]),
            submitToChallenge,
        });
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['preferred'], 'tok');
    });

    test('null tag settings degrade to no-filter (not crash)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        // settings.getEffectiveSetting can legitimately return null when no
        // global default is wired; the picker must treat it as "no filter".
        const settings = {
            getEffectiveSetting: jest.fn((key) => {
                if (key === 'mustIncludeTags') return null;
                if (key === 'shouldIncludeTags') return null;
                return null;
            }),
            getEffectiveTagSetting: jest.fn(() => null),
        };
        const result = await fillChallengeNow(challenge, 'tok', 'one', {
            settings,
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Cat'])]),
            submitToChallenge,
        });
        expect(result.success).toBe(true);
        expect(result.submitted).toBe(1);
    });

    test('omitting settings emits a debug log on the degradation path', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const debug = jest.fn();
        const logger = {
            withCategory: jest.fn(() => ({
                info: jest.fn(),
                warning: jest.fn(),
                success: jest.fn(),
                error: jest.fn(),
                debug,
            })),
            challengeTag: (c) => `[${c.id}]`,
        };
        await fillChallengeNow(challenge, 'tok', 'one', {
            logger,
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
        });
        expect(debug).toHaveBeenCalledWith(expect.stringMatching(/settings module not provided/), null);
    });
});

describe('submitNewEntryForAction — fill-new for boost/turbo', () => {
    test('submits one photo and returns its id on success', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }] });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const getEligiblePhotos = jest.fn().mockResolvedValue([allowedPhoto('p1', ['Pink'])]);
        const result = await submitNewEntryForAction(challenge, 'tok', {
            settings: makeSettings(),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toEqual({ ok: true, imageId: 'p1', reason: 'submitted' });
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['p1'], 'tok');
    });

    test('resolves tag lists via getEffectiveTagSetting with the full challenge (enables title rules)', async () => {
        // Wiring guard: fill-new must resolve tags by challenge (title), not id.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [] });
        const settings = makeSettings();
        await submitNewEntryForAction(challenge, 'tok', {
            settings,
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Pink'])]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
        });
        expect(settings.getEffectiveTagSetting).toHaveBeenCalledWith('mustIncludeTags', challenge);
        expect(settings.getEffectiveTagSetting).toHaveBeenCalledWith('shouldIncludeTags', challenge);
    });

    test('honors Must Include Tags when picking the photo', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [] });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const getEligiblePhotos = jest
            .fn()
            .mockResolvedValue([allowedPhoto('cat', ['Cat']), allowedPhoto('dog', ['Dog'])]);
        const result = await submitNewEntryForAction(challenge, 'tok', {
            settings: makeSettings({ mustIncludeTags: ['dog'], fillWithoutTagMatch: false }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result.ok).toBe(true);
        expect(result.imageId).toBe('dog');
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['dog'], 'tok');
    });

    test('returns no-slots without submitting when the challenge is full', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }, { id: 'e2' }] });
        const submitToChallenge = jest.fn();
        const getEligiblePhotos = jest.fn();
        const result = await submitNewEntryForAction(challenge, 'tok', {
            settings: makeSettings(),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toEqual({ ok: false, imageId: null, reason: 'no-slots' });
        expect(getEligiblePhotos).not.toHaveBeenCalled();
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('returns no-eligible when the picker finds nothing to submit', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [] });
        const submitToChallenge = jest.fn();
        const result = await submitNewEntryForAction(challenge, 'tok', {
            settings: makeSettings(),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([]),
            submitToChallenge,
        });
        expect(result).toEqual({ ok: false, imageId: null, reason: 'no-eligible' });
        expect(submitToChallenge).not.toHaveBeenCalled();
    });

    test('returns fetch-error when eligible-photos lookup throws', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [] });
        const result = await submitNewEntryForAction(challenge, 'tok', {
            settings: makeSettings(),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockRejectedValue(new Error('network down')),
            submitToChallenge: jest.fn(),
        });
        expect(result).toEqual({ ok: false, imageId: null, reason: 'fetch-error' });
    });

    test('returns submit-failed when the submit responds ok=false', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [] });
        const result = await submitNewEntryForAction(challenge, 'tok', {
            settings: makeSettings(),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: false, raw: null }),
        });
        expect(result).toEqual({ ok: false, imageId: null, reason: 'submit-failed' });
    });

    test('returns submit-failed when the submit throws', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [] });
        const result = await submitNewEntryForAction(challenge, 'tok', {
            settings: makeSettings(),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockRejectedValue(new Error('boom')),
        });
        expect(result).toEqual({ ok: false, imageId: null, reason: 'submit-failed' });
    });
});

describe('reflectNewEntry — same-cycle slot accounting', () => {
    test('appends a non-conflicting entry and consumes a slot', () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }] });
        expect(getSlotsRemaining(challenge)).toBe(3);
        reflectNewEntry(challenge, 'new-1');
        expect(getSlotsRemaining(challenge)).toBe(2);
        const added = challenge.member.ranking.entries.at(-1);
        expect(added).toEqual({ id: 'new-1', turbo: false, boosted: false, boost: -1, boosting: false });
    });

    test('coerces a numeric id to a string', () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [] });
        reflectNewEntry(challenge, 12345);
        expect(challenge.member.ranking.entries[0].id).toBe('12345');
    });

    test('creates the entries array when ranking has none', () => {
        const challenge = { id: 'c1', max_photo_submits: 4, member: { ranking: {} } };
        reflectNewEntry(challenge, 'new-1');
        expect(challenge.member.ranking.entries).toEqual([
            { id: 'new-1', turbo: false, boosted: false, boost: -1, boosting: false },
        ]);
    });

    test('is a no-op when ranking is missing or imageId is falsy', () => {
        const noRanking = { id: 'c1', member: {} };
        expect(() => reflectNewEntry(noRanking, 'x')).not.toThrow();
        expect(noRanking.member.ranking).toBeUndefined();

        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }] });
        reflectNewEntry(challenge, null);
        expect(challenge.member.ranking.entries).toHaveLength(1); // unchanged
    });
});

describe('reflect-on-submit — auto-fill consumes the slot it just used', () => {
    test('maybeAutoFillChallenge reflects the submitted entry locally', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 9 * 60 });
        expect(getSlotsRemaining(challenge)).toBe(1);
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
        });
        expect(result).toBe('submitted');
        expect(getSlotsRemaining(challenge)).toBe(0);
        expect(challenge.member.ranking.entries.at(-1)).toEqual({
            id: 'p1',
            turbo: false,
            boosted: false,
            boost: -1,
            boosting: false,
        });
    });

    test('a second same-cycle call returns skipped (no double-submit on stale slots)', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 9 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const deps = {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge,
        };
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('submitted');
        // Slot now consumed locally → the second pass sees 0 slots and stands down.
        expect(await maybeAutoFillChallenge(challenge, 'tok', NOW, deps)).toBe('skipped');
        expect(submitToChallenge).toHaveBeenCalledTimes(1);
    });

    test('does NOT reflect on submit failure (entries untouched)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }], closeIn: 5 * 60 });
        const before = challenge.member.ranking.entries.length;
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: false, raw: null }),
        });
        expect(result).toBe('error');
        expect(challenge.member.ranking.entries).toHaveLength(before);
    });

    test('maybeEmergencyFillChallenge does NOT reflect when a multi-photo submit fails', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1'), allowedPhoto('p2')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: false, raw: null }),
        });
        expect(result).toBe('error');
        expect(challenge.member.ranking.entries).toHaveLength(0);
    });

    test('maybeEmergencyFillChallenge reflects every submitted entry', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 3 * 60 });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([allowedPhoto('p1'), allowedPhoto('p2'), allowedPhoto('p3'), allowedPhoto('p4')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
        });
        expect(result).toBe('submitted');
        expect(getSlotsRemaining(challenge)).toBe(0);
        expect(challenge.member.ranking.entries).toHaveLength(4);
        expect(challenge.member.ranking.entries.map((e) => e.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    });
});

describe('fetchCandidatesForChallenge — theme-narrowed fetch', () => {
    test('searches per derived term and returns the deduped union', async () => {
        const getEligiblePhotos = jest.fn(async (_id, _tok, opts) => {
            if (opts && opts.search === 'cat') return [allowedPhoto('p1', ['Cat']), allowedPhoto('shared', ['Pet'])];
            if (opts && opts.search === 'dog') return [allowedPhoto('p2', ['Dog']), allowedPhoto('shared', ['Pet'])];
            return [];
        });
        const out = await fetchCandidatesForChallenge(
            { id: 'c1' },
            'tok',
            { mustIncludeTags: ['cat', 'dog'] },
            { getEligiblePhotos, logger: makeLogger() },
        );
        expect(out.map((p) => p.id).sort()).toEqual(['p1', 'p2', 'shared']);
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok', { search: 'cat' });
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok', { search: 'dog' });
        // Search produced allowed candidates → the unfiltered fallback is not used.
        expect(getEligiblePhotos).not.toHaveBeenCalledWith('c1', 'tok');
    });

    test('falls back to the unfiltered library when every search is empty', async () => {
        const getEligiblePhotos = jest.fn(async (_id, _tok, opts) =>
            opts && opts.search ? [] : [allowedPhoto('full', ['Misc'])],
        );
        const out = await fetchCandidatesForChallenge(
            { id: 'c1', title: 'Pink In Nature' },
            'tok',
            {},
            { getEligiblePhotos, logger: makeLogger() },
        );
        expect(out.map((p) => p.id)).toEqual(['full']);
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok', { search: 'pink' });
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok'); // unfiltered fallback
    });

    // The themed-search-empty fallback is the path that may submit an off-theme
    // photo. How loudly it logs must depend on WHERE the search terms came from:
    // the user's own tags failing to match is actionable and warrants a warning,
    // but a challenge TITLE failing to match is routine (vision labels are concrete
    // nouns, titles are abstract) and must stay at debug — otherwise every user who
    // never configured tags gets warnings on the common path and learns to ignore
    // them, which would bury the case that actually matters.
    describe('themed-search-empty fallback — log level depends on the term source', () => {
        // makeLogger() returns a fresh object per withCategory() call, so the spies
        // are unreachable. Use a logger with a stable category object instead.
        const makeSpyLogger = () => {
            const category = {
                info: jest.fn(),
                warning: jest.fn(),
                success: jest.fn(),
                error: jest.fn(),
                debug: jest.fn(),
            };
            return { logger: { withCategory: () => category, challengeTag: (c) => `[Challenge ${c.id}]` }, category };
        };
        const emptySearch = () =>
            jest.fn(async (_id, _tok, opts) => (opts && opts.search ? [] : [allowedPhoto('full', ['Misc'])]));

        test('terms from the challenge title → debug, not warning (the common path)', async () => {
            const { logger, category } = makeSpyLogger();
            await fetchCandidatesForChallenge(
                { id: 'c1', title: 'Pink In Nature' },
                'tok',
                {}, // no user tags — terms derive from the title
                { getEligiblePhotos: emptySearch(), logger },
            );
            expect(category.warning).not.toHaveBeenCalled();
            expect(category.debug).toHaveBeenCalledWith(
                expect.stringContaining('falling back to the full library'),
                null,
            );
        });

        test("terms from the user's Must Include Tags → warning (their config matches nothing)", async () => {
            const { logger, category } = makeSpyLogger();
            await fetchCandidatesForChallenge(
                { id: 'c1', title: 'Pink In Nature' },
                'tok',
                { mustIncludeTags: ['sunset'] },
                { getEligiblePhotos: emptySearch(), logger },
            );
            expect(category.warning).toHaveBeenCalledWith(
                expect.stringContaining('Must/Should Include Tags matched none of your photos'),
                null,
            );
        });
    });

    test('falls back when search returns only non-allowed photos', async () => {
        const blockedItem = { id: 'b', labels: ['Cat'], permission: { allowed: false } };
        const getEligiblePhotos = jest.fn(async (_id, _tok, opts) =>
            opts && opts.search ? [blockedItem] : [allowedPhoto('full', ['Misc'])],
        );
        const out = await fetchCandidatesForChallenge(
            { id: 'c1' },
            'tok',
            { mustIncludeTags: ['cat'] },
            { getEligiblePhotos, logger: makeLogger() },
        );
        expect(out.map((p) => p.id)).toEqual(['full']);
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok');
    });

    test('goes straight to the unfiltered fetch when no terms are derivable', async () => {
        const getEligiblePhotos = jest.fn(async () => [allowedPhoto('x')]);
        const out = await fetchCandidatesForChallenge(
            { id: 'c1' }, // no title, no tags → no search terms
            'tok',
            {},
            { getEligiblePhotos, logger: makeLogger() },
        );
        expect(out.map((p) => p.id)).toEqual(['x']);
        expect(getEligiblePhotos).toHaveBeenCalledTimes(1);
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok');
    });

    test('tolerates a single search term throwing (other terms still contribute)', async () => {
        const getEligiblePhotos = jest.fn(async (_id, _tok, opts) => {
            if (opts && opts.search === 'cat') throw new Error('boom');
            if (opts && opts.search === 'dog') return [allowedPhoto('p2', ['Dog'])];
            return [allowedPhoto('full')];
        });
        const out = await fetchCandidatesForChallenge(
            { id: 'c1' },
            'tok',
            { mustIncludeTags: ['cat', 'dog'] },
            { getEligiblePhotos, logger: makeLogger() },
        );
        expect(out.map((p) => p.id)).toEqual(['p2']);
        expect(getEligiblePhotos).not.toHaveBeenCalledWith('c1', 'tok'); // dog matched → no fallback
    });
});

describe('semantic matching wiring (always on)', () => {
    test('always computes semantic scores and threads them into the pick', async () => {
        // p1 wins the lexical tiebreak (newer upload); the semantic map flips
        // the choice to the on-theme p2. No setting required — always on.
        const photos = [allowedPhoto('p1', ['Random'], 9000), allowedPhoto('p2', ['Random'], 8000)];
        const getSemanticScores = jest.fn().mockResolvedValue(
            new Map([
                ['p1', 0.1],
                ['p2', 0.9],
            ]),
        );
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 9 * 60 });
        const res = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue(photos),
            submitToChallenge,
            getSemanticScores,
        });
        expect(res).toBe('submitted');
        expect(getSemanticScores).toHaveBeenCalledTimes(1);
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['p2'], 'tok');
    });

    test('scorer returning null leaves ranking lexical', async () => {
        const photos = [allowedPhoto('p1', ['Random'], 9000), allowedPhoto('p2', ['Random'], 8000)];
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 9 * 60 });
        await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue(photos),
            submitToChallenge,
            getSemanticScores: jest.fn().mockResolvedValue(null),
        });
        // Newer upload wins the lexical tiebreak when there's no semantic signal.
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['p1'], 'tok');
    });

    test('scorer throwing degrades gracefully — fill still proceeds', async () => {
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 9 * 60 });
        const res = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge,
            getSemanticScores: jest.fn().mockRejectedValue(new Error('boom')),
        });
        expect(res).toBe('submitted');
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['p1'], 'tok');
    });
});

describe('describeSubmitFailure — surfacing the server rejection reason', () => {
    test('strips HTML from the GuruShots per-image message', () => {
        const raw = {
            success: false,
            message: "This image <b>has won a challenge</b><br/><span>it can't participate in another</span>",
        };
        expect(describeSubmitFailure(raw)).toBe("This image has won a challenge it can't participate in another");
    });

    test('reads error / errors[] shapes', () => {
        expect(describeSubmitFailure({ error: 'Photo already entered' })).toBe('Photo already entered');
        expect(describeSubmitFailure({ errors: ['Limit reached'] })).toBe('Limit reached');
    });

    test('null / non-object → safe placeholder, never throws', () => {
        expect(describeSubmitFailure(null)).toBe('no response body');
        expect(describeSubmitFailure(undefined)).toBe('no response body');
        expect(describeSubmitFailure('nope')).toBe('no response body');
    });

    test('unknown shape → truncated JSON dump rather than an empty reason', () => {
        const out = describeSubmitFailure({ success: false, code: 7, detail: { a: 1 } });
        expect(out.length).toBeGreaterThan(0);
        expect(out).toContain('success');
    });
});

describe('fillChallengeNow surfaces the rejection reason to the caller', () => {
    test('ok=false with a server message → error carries the reason', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 86400 });
        const result = await fillChallengeNow(challenge, 'tok', 'one', {
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({
                ok: false,
                raw: { success: false, message: 'This image <b>has won a challenge</b>' },
            }),
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('has won a challenge');
    });
});

describe('letter challenges ("Begins With L") — tag-based fill, end to end', () => {
    test('fetchCandidatesForChallenge skips the search and fetches the full library (with a debug breadcrumb)', async () => {
        const debug = jest.fn();
        const logger = {
            withCategory: () => ({ info: jest.fn(), warning: jest.fn(), success: jest.fn(), error: jest.fn(), debug }),
            challengeTag: () => '[Challenge c1: Begins With L]',
        };
        const getEligiblePhotos = jest.fn(async () => [
            allowedPhoto('best', ['Pink'], 9000),
            allowedPhoto('landscape', ['Landscape'], 1000),
        ]);
        const out = await fetchCandidatesForChallenge(
            { id: 'c1', title: 'Begins With L' },
            'tok',
            {},
            { getEligiblePhotos, logger },
        );
        expect(out.map((p) => p.id)).toEqual(['best', 'landscape']);
        expect(getEligiblePhotos).toHaveBeenCalledTimes(1);
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok'); // no { search } term
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('letter challenge "L"'), null);
    });

    test('staggered fill submits the L-tagged photo, not the newer off-theme best performer', async () => {
        // 1 slot, interval 10m, T-9m → due to submit (mirrors the spacing tests).
        const challenge = makeChallenge({
            title: 'Begins With L',
            url: '',
            maxSubmits: 2,
            entries: [{ id: 'e1' }],
            closeIn: 9 * 60,
        });
        const getEligiblePhotos = jest.fn().mockResolvedValue([
            allowedPhoto('best', ['Pink'], 9000), // newer, would win best-performer — but no L label
            allowedPhoto('landscape', ['Landscape'], 1000), // the only L-tagged photo
        ]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(getEligiblePhotos).toHaveBeenCalledTimes(1);
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok'); // no themed search
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['landscape'], 'tok');
    });

    test('emergency fill near the deadline also honors the letter filter', async () => {
        // autoFill off → emergency owns the slot; within the 300s window.
        const challenge = makeChallenge({
            title: 'Begins With L',
            url: '',
            maxSubmits: 2,
            entries: [{ id: 'e1' }],
            closeIn: 100,
        });
        const getEligiblePhotos = jest
            .fn()
            .mockResolvedValue([allowedPhoto('best', ['Pink'], 9000), allowedPhoto('lion', ['Lion'], 1000)]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: false, emergencyFill: 300 }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(getEligiblePhotos).toHaveBeenCalledTimes(1);
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok'); // no themed search
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['lion'], 'tok');
    });

    test('letter challenge WITH must tags uses the themed search and suppresses the breadcrumb', async () => {
        // When a user sets Must Include Tags, buildSearchTerms returns those tags
        // (the letter guard never fires), so the candidate fetch is the themed
        // search — not the full-library path — and the breadcrumb stays quiet. The
        // client-side letter filter still applies later in pickPhotosForChallenge.
        const debug = jest.fn();
        const logger = {
            withCategory: () => ({ info: jest.fn(), warning: jest.fn(), success: jest.fn(), error: jest.fn(), debug }),
            challengeTag: () => '[Challenge c1: Begins With L]',
        };
        const getEligiblePhotos = jest.fn(async (_id, _tok, opts) =>
            opts && opts.search === 'leaf' ? [allowedPhoto('leaf', ['Leaf'], 1000)] : [],
        );
        const out = await fetchCandidatesForChallenge(
            { id: 'c1', title: 'Begins With L' },
            'tok',
            { mustIncludeTags: ['leaf'] },
            { getEligiblePhotos, logger },
        );
        expect(out.map((p) => p.id)).toEqual(['leaf']);
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok', { search: 'leaf' });
        expect(debug).not.toHaveBeenCalled();
    });

    test('"C is for…" staggered fill submits the C-tagged photo, not the newer off-theme best performer', async () => {
        const challenge = makeChallenge({
            title: 'C is for…',
            url: '',
            maxSubmits: 2,
            entries: [{ id: 'e1' }],
            closeIn: 9 * 60,
        });
        const getEligiblePhotos = jest.fn().mockResolvedValue([
            allowedPhoto('best', ['Pink'], 9000), // newer, would win best-performer — but no C label
            allowedPhoto('castle', ['Castle'], 1000), // the only C-tagged photo
        ]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok'); // no themed search
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['castle'], 'tok');
    });

    test('no letter match → off-theme fallback still submits but logs a WARNING (survives packaged builds)', async () => {
        const warning = jest.fn();
        const logger = {
            withCategory: () => ({ info: jest.fn(), warning, success: jest.fn(), error: jest.fn(), debug: jest.fn() }),
            challengeTag: () => '[Challenge c1: C is for…]',
        };
        const challenge = makeChallenge({
            title: 'C is for…',
            url: '',
            maxSubmits: 2,
            entries: [{ id: 'e1' }],
            closeIn: 9 * 60,
        });
        // Library has no C-labelled photo at all → the picker relaxes to the
        // unfiltered set (fillWithoutTagMatch defaults true) and must say so
        // at a level a packaged-build user can actually see.
        const getEligiblePhotos = jest.fn().mockResolvedValue([allowedPhoto('dog', ['Dog'], 9000)]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true }),
            logger,
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['dog'], 'tok');
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining('no eligible photo has a label starting with "C"'),
            null,
        );
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('off-theme photo may be submitted'), null);
    });

    test('the emergency-fill dry-run probe never emits the fallback warning', async () => {
        const warning = jest.fn();
        const logger = {
            withCategory: () => ({ info: jest.fn(), warning, success: jest.fn(), error: jest.fn(), debug: jest.fn() }),
            challengeTag: () => '[Challenge c1: C is for…]',
        };
        // autoFill on + no C-labelled photo: the probe's pick relaxes internally
        // and returns a photo, so emergency fill stands down ('skipped'). A probe
        // never submits, so it must never warn about an off-theme submission.
        const challenge = makeChallenge({
            title: 'C is for…',
            url: '',
            maxSubmits: 2,
            entries: [{ id: 'e1' }],
            closeIn: 100,
        });
        const getEligiblePhotos = jest.fn().mockResolvedValue([allowedPhoto('dog', ['Dog'], 9000)]);
        const submitToChallenge = jest.fn();
        const result = await maybeEmergencyFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, emergencyFill: 300 }),
            logger,
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('skipped');
        expect(submitToChallenge).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
    });
});

describe('resolveScheduleTarget — target entry count for the time remaining', () => {
    test('picks the largest row whose threshold has been reached', () => {
        // T-25m: only the 30m row applies.
        expect(resolveScheduleTarget(DEFAULT_SCHEDULE, 25 * 60, 4)).toBe(2);
        // T-19m: 30m and 20m rows apply → 3.
        expect(resolveScheduleTarget(DEFAULT_SCHEDULE, 19 * 60, 4)).toBe(3);
        // T-5m: every row applies → 4.
        expect(resolveScheduleTarget(DEFAULT_SCHEDULE, 5 * 60, 4)).toBe(4);
    });

    test('no row reached yet → 0', () => {
        expect(resolveScheduleTarget(DEFAULT_SCHEDULE, 31 * 60, 4)).toBe(0);
    });

    test('threshold boundary is inclusive (secondsRemaining === row.seconds)', () => {
        expect(resolveScheduleTarget(DEFAULT_SCHEDULE, 1800, 4)).toBe(2);
        expect(resolveScheduleTarget(DEFAULT_SCHEDULE, 1801, 4)).toBe(0);
    });

    test('row counts clamp to max_photo_submits', () => {
        expect(resolveScheduleTarget(DEFAULT_SCHEDULE, 300, 3)).toBe(3);
        expect(resolveScheduleTarget(DEFAULT_SCHEDULE, 300, 2)).toBe(2);
    });

    test('undefined / NaN max_photo_submits → finite result, never NaN', () => {
        const forUndefined = resolveScheduleTarget(DEFAULT_SCHEDULE, 300, undefined);
        const forNaN = resolveScheduleTarget(DEFAULT_SCHEDULE, 300, NaN);
        expect(forUndefined).toBe(0);
        expect(forNaN).toBe(0);
        expect(Number.isFinite(forUndefined)).toBe(true);
        expect(Number.isFinite(forNaN)).toBe(true);
    });

    test('non-finite secondsRemaining → 0', () => {
        expect(resolveScheduleTarget(DEFAULT_SCHEDULE, NaN, 4)).toBe(0);
        expect(resolveScheduleTarget(DEFAULT_SCHEDULE, Infinity, 4)).toBe(0);
    });

    test('empty or invalid schedule shapes → 0, never throws', () => {
        expect(resolveScheduleTarget([], 300, 4)).toBe(0);
        expect(resolveScheduleTarget('garbage', 300, 4)).toBe(0);
        expect(resolveScheduleTarget({ count: 2, seconds: 600 }, 300, 4)).toBe(0);
        expect(resolveScheduleTarget(null, 300, 4)).toBe(0);
        expect(resolveScheduleTarget(undefined, 300, 4)).toBe(0);
    });

    test('rows missing fields or with non-numeric fields are dropped, not counted', () => {
        expect(resolveScheduleTarget([{ count: 2 }, { seconds: 600 }], 300, 4)).toBe(0);
        expect(resolveScheduleTarget([{ count: '2', seconds: '600' }], 300, 4)).toBe(0);
        expect(resolveScheduleTarget([null, 42, 'row'], 300, 4)).toBe(0);
        // A valid row still wins even when surrounded by junk.
        expect(resolveScheduleTarget([{ count: 'x' }, { count: 3, seconds: 600 }], 300, 4)).toBe(3);
    });

    test('row order is irrelevant', () => {
        const shuffled = [DEFAULT_SCHEDULE[2], DEFAULT_SCHEDULE[0], DEFAULT_SCHEDULE[1]];
        expect(resolveScheduleTarget(shuffled, 19 * 60, 4)).toBe(3);
        expect(resolveScheduleTarget(shuffled, 5 * 60, 4)).toBe(4);
    });
});

describe('getNextScheduleThresholdSec — when the next fill becomes due', () => {
    test('returns the largest threshold among rows above the current entry count', () => {
        expect(getNextScheduleThresholdSec(DEFAULT_SCHEDULE, 0, 4)).toBe(1800);
        expect(getNextScheduleThresholdSec(DEFAULT_SCHEDULE, 2, 4)).toBe(1200);
        expect(getNextScheduleThresholdSec(DEFAULT_SCHEDULE, 3, 4)).toBe(600);
    });

    test('returns 0 when every row is satisfied', () => {
        expect(getNextScheduleThresholdSec(DEFAULT_SCHEDULE, 4, 4)).toBe(0);
    });

    test('returns 0 when the remaining rows are clamped away by max_photo_submits', () => {
        // max 2: rows 3 and 4 clamp to 2, which is not above entryCount 2.
        expect(getNextScheduleThresholdSec(DEFAULT_SCHEDULE, 2, 2)).toBe(0);
    });

    test('unordered rows: still picks the largest applicable threshold', () => {
        const unordered = [
            { count: 4, seconds: 600 },
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
        ];
        expect(getNextScheduleThresholdSec(unordered, 1, 4)).toBe(1800);
    });

    test('empty / invalid schedules → 0, never NaN', () => {
        expect(getNextScheduleThresholdSec([], 0, 4)).toBe(0);
        expect(getNextScheduleThresholdSec('garbage', 0, 4)).toBe(0);
        expect(getNextScheduleThresholdSec(null, 0, 4)).toBe(0);
        expect(getNextScheduleThresholdSec([{ bad: true }], 0, 4)).toBe(0);
        expect(Number.isFinite(getNextScheduleThresholdSec(undefined, 0, 4))).toBe(true);
    });

    test('non-finite entryCount / max are coerced to 0, result stays finite', () => {
        // entryCount NaN → treated as 0 → first row applies.
        expect(getNextScheduleThresholdSec(DEFAULT_SCHEDULE, NaN, 4)).toBe(1800);
        // max undefined → 0 → every row clamps to 0 → nothing is ever due.
        expect(getNextScheduleThresholdSec(DEFAULT_SCHEDULE, 0, undefined)).toBe(0);
        expect(Number.isFinite(getNextScheduleThresholdSec(DEFAULT_SCHEDULE, NaN, NaN))).toBe(true);
    });
});
