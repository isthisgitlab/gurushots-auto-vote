/**
 * Tests for autoFill.js — both the staggered scheduler entry point
 * (maybeAutoFillChallenge) and the manual GUI entry point (fillChallengeNow).
 */

const { maybeAutoFillChallenge, fillChallengeNow } = require('../../src/js/services/autoFill');

const makeChallenge = ({ id = 'c1', closeIn = 600, maxSubmits = 4, entries = [] } = {}) => ({
    id,
    title: 'Pink In Nature',
    url: 'pink-in-nature23',
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
    intervalMinutes = 10,
    mustIncludeTags = [],
    shouldIncludeTags = [],
    fillWithoutTagMatch = true, // mirrors the schema default
} = {}) => ({
    getEffectiveSetting: jest.fn((key) => {
        if (key === 'autoFill') return autoFill;
        if (key === 'autoFillIntervalMinutes') return intervalMinutes;
        if (key === 'mustIncludeTags') return mustIncludeTags;
        if (key === 'shouldIncludeTags') return shouldIncludeTags;
        if (key === 'fillWithoutTagMatch') return fillWithoutTagMatch;
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

    test('spacing: 2 slots, interval 10m, T-25m → skipped (too early)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }, { id: 'e2' }], closeIn: 25 * 60 });
        const getEligiblePhotos = jest.fn();
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
        expect(getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('spacing: 2 slots, interval 10m, T-19m → submits', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }, { id: 'e2' }], closeIn: 19 * 60 });
        const getEligiblePhotos = jest.fn().mockResolvedValue([allowedPhoto('p1', ['Pink'])]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        expect(result).toBe('submitted');
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok');
        expect(submitToChallenge).toHaveBeenCalledWith('c1', ['p1'], 'tok');
    });

    test('spacing: 1 slot, interval 10m, T-11m → skipped', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 11 * 60 });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn(),
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('skipped');
    });

    test('spacing: 1 slot, interval 10m, T-9m → submits', async () => {
        const challenge = makeChallenge({ maxSubmits: 2, entries: [{ id: 'e1' }], closeIn: 9 * 60 });
        const getEligiblePhotos = jest.fn().mockResolvedValue([allowedPhoto('p1')]);
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
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
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
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
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
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
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge: jest.fn(),
        });
        expect(result).toBe('error');
    });

    test('returns error when submit returns ok=false', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: false, raw: null }),
        });
        expect(result).toBe('error');
    });

    test('returns error when submit throws (no crash)', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
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
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
            logger: makeLogger(),
            getEligiblePhotos,
            submitToChallenge,
        });
        // slotsRemaining = max(0, 4 - 0) = 4; 5 min ≤ 4 * 10 min → submits
        expect(result).toBe('submitted');
    });

    test('treats missing max_photo_submits as 0 (skipped — no slots)', async () => {
        const challenge = {
            id: 'c1',
            close_time: NOW + 5 * 60,
            member: { ranking: { entries: [] } },
        };
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
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

    test('falls back to 10-minute interval when setting is non-numeric', async () => {
        // intervalMinutes returns null → fallback 10. With slotsRemaining=2 and
        // secondsRemaining=15min, 15 ≤ 2*10 fires.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }, { id: 'e2' }], closeIn: 15 * 60 });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, intervalMinutes: null }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
        });
        expect(result).toBe('submitted');
    });

    test('mustIncludeTags hard-filters: with fillWithoutTagMatch off, no-match photo is not submitted', async () => {
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                intervalMinutes: 10,
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
                intervalMinutes: 10,
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
                intervalMinutes: 10,
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
                intervalMinutes: 10,
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

    test('getEffectiveSetting returning null for tag settings means "no filter"', async () => {
        // Real settings.js can return null when no global default is set;
        // tokeniseTagList handles null/undefined → []. Verify the picker
        // is reached with both photos eligible.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const settings = {
            getEffectiveSetting: jest.fn((key) => {
                if (key === 'autoFill') return true;
                if (key === 'autoFillIntervalMinutes') return 10;
                return null;
            }),
        };
        const result = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings,
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1', ['Cat'])]),
            submitToChallenge,
        });
        expect(result).toBe('submitted');
    });

    test('shouldIncludeTags re-orders pick within the eligible set', async () => {
        // Without should: 'themed' wins via keyword score (label "Pink" matches challenge "pink").
        // With should=['sunset']: 'preferred' wins despite zero keyword score.
        const challenge = makeChallenge({ maxSubmits: 4, entries: [], closeIn: 5 * 60 });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({
                autoFill: true,
                intervalMinutes: 10,
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
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockRejectedValue('string-not-error'),
            submitToChallenge: jest.fn(),
        });
        expect(fetchResult).toBe('error');

        const submitResult = await maybeAutoFillChallenge(challenge, 'tok', NOW, {
            settings: makeSettings({ autoFill: true, intervalMinutes: 10 }),
            logger: makeLogger(),
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockRejectedValue('also-not-error'),
        });
        expect(submitResult).toBe('error');
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
