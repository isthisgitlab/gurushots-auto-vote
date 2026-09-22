/**
 * Edge-case coverage for autoFill.js helpers that the main suite exercises
 * only on the happy path: identity-lookup failure logging and the bounded
 * member-id cache, stale-refresh warnings without a cause, flag carry-over
 * across id-less fresh entries, rankCandidatesForChallenge's fetch-error
 * pass-through, and the invalid-challenge / refreshed-with-room paths.
 */

jest.mock('../../src/js/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => null,
        writeRaw: () => {},
        getFilePath: () => '/tmp/photo-stats-edges.json',
        initializeAsync: async () => {},
    }),
}));

const {
    resolveIgnoreWords,
    resolveMemberId,
    __resetMemberIdCache,
    refreshChallengeState,
    rankCandidatesForChallenge,
    maybeEmergencyFillChallenge,
    submitNewEntryForAction,
} = require('../../src/js/services/autoFill');
const { buildChallenge } = require('../helpers/challengeFixtures');

const NOW = 1_000_000;

const makeCapturingLogger = () => {
    const lines = { info: [], warning: [], success: [], error: [], debug: [] };
    const categories = [];
    const cat = Object.fromEntries(Object.keys(lines).map((level) => [level, (m) => lines[level].push(m)]));
    const logger = {
        withCategory: (name) => {
            categories.push(name);
            return cat;
        },
        challengeTag: (c) => `[Challenge ${c && typeof c === 'object' ? c.id : c}]`,
    };
    return { logger, lines, categories };
};

const makeSettings = ({ emergencyFill = 300 } = {}) => ({
    getEffectiveSetting: jest.fn((key) => {
        if (key === 'emergencyFill') return emergencyFill;
        if (key === 'fillWithoutTagMatch') return true;
        if (key === 'autoFillSchedule') return [];
        return null;
    }),
    getEffectiveTagSetting: jest.fn(() => []),
    getEffectiveIgnoreTitleWords: jest.fn(() => null),
});

const allowedPhoto = (id) => ({
    id,
    labels: ['Pink'],
    upload_date: 9000,
    permission: { allowed: true, message: null },
});

const makeChallenge = ({ id = 'c1', closeIn = 600, maxSubmits = 4, entries = [] } = {}) =>
    buildChallenge({
        id,
        title: 'Pink In Nature',
        url: 'pink-in-nature23',
        max_photo_submits: maxSubmits,
        close_time: NOW + closeIn,
        member: { ranking: { entries } },
    });

const freshList = (id, entries) => ({
    challenges: [
        {
            id,
            member: {
                boost: { state: 'LOCKED', timeout: 0 },
                ranking: { entries, exposure: { exposure_factor: 100 } },
            },
        },
    ],
});

describe('resolveIgnoreWords', () => {
    test('returns null when the settings read throws (a settings read never fails a fill)', () => {
        const settings = {
            getEffectiveIgnoreTitleWords: () => {
                throw new Error('corrupt');
            },
        };
        expect(resolveIgnoreWords(settings, { id: 'c1' })).toBeNull();
    });

    test('returns null when the facade lacks the reader', () => {
        expect(resolveIgnoreWords({}, { id: 'c1' })).toBeNull();
        expect(resolveIgnoreWords(null, { id: 'c1' })).toBeNull();
    });
});

describe('resolveMemberId', () => {
    beforeEach(() => __resetMemberIdCache());
    afterEach(() => jest.useRealTimers());

    test('a thrown non-Error is logged at debug under the default autoFill label', async () => {
        const { logger, lines, categories } = makeCapturingLogger();
        const getProfile = jest.fn().mockRejectedValue('offline');
        await expect(resolveMemberId('tok-a', getProfile, logger)).resolves.toBeNull();
        expect(categories).toContain('autoFill');
        expect(lines.debug).toEqual(['autoFill: identity lookup failed: offline']);
    });

    test('a thrown Error uses its message and the caller label', async () => {
        const { logger, lines, categories } = makeCapturingLogger();
        const getProfile = jest.fn().mockRejectedValue(new Error('401'));
        await expect(resolveMemberId('tok-b', getProfile, logger, 'fillNew')).resolves.toBeNull();
        expect(categories).toContain('fillNew');
        expect(lines.debug).toEqual(['fillNew: identity lookup failed: 401']);
    });

    test('a failure without a logger still resolves to null', async () => {
        const getProfile = jest.fn().mockRejectedValue(new Error('x'));
        await expect(resolveMemberId('tok-c', getProfile, null)).resolves.toBeNull();
    });

    test('a cached negative result is reused inside its TTL and re-fetched after it', async () => {
        jest.useFakeTimers({ now: 5_000_000 });
        const getProfile = jest.fn().mockResolvedValue({ id: '' }); // no usable id → null
        await expect(resolveMemberId('tok-neg', getProfile)).resolves.toBeNull();
        await Promise.resolve(); // let the expiry stamp land
        await expect(resolveMemberId('tok-neg', getProfile)).resolves.toBeNull();
        expect(getProfile).toHaveBeenCalledTimes(1);

        jest.setSystemTime(5_000_000 + 60_001);
        await resolveMemberId('tok-neg', getProfile);
        expect(getProfile).toHaveBeenCalledTimes(2);
    });

    test('the cache is bounded: filling it past its cap evicts earlier tokens', async () => {
        const getProfile = jest.fn(async (token) => ({ id: `m-${token}` }));
        for (const token of ['t1', 't2', 't3', 't4']) {
            await expect(resolveMemberId(token, getProfile)).resolves.toBe(`m-${token}`);
        }
        await resolveMemberId('t1', getProfile); // still cached
        expect(getProfile).toHaveBeenCalledTimes(4);

        await resolveMemberId('t5', getProfile); // size 4 → cleared, t5 inserted
        await resolveMemberId('t1', getProfile); // evicted → fetched again
        expect(getProfile).toHaveBeenCalledTimes(6);
    });
});

describe('refreshChallengeState — warnings and flag carry-over', () => {
    test('a rejection with no value warns without a parenthesised cause', async () => {
        const { logger, lines } = makeCapturingLogger();
        const result = await refreshChallengeState(
            makeChallenge(),
            'tok',
            { getActiveChallenges: jest.fn().mockRejectedValue(undefined), logger },
            'autoFill',
        );
        expect(result).toBe('unavailable');
        expect(lines.warning).toHaveLength(1);
        expect(lines.warning[0]).toMatch(/^autoFill: could not refresh live challenge state for \[Challenge c1\]; /);
    });

    test('a rejection with a bare string reports that string as the cause', async () => {
        const { logger, lines } = makeCapturingLogger();
        await refreshChallengeState(
            makeChallenge(),
            'tok',
            { getActiveChallenges: jest.fn().mockRejectedValue('socket\nhang up'), logger },
            'fillNew',
        );
        expect(lines.warning[0]).toContain('(socket hang up)');
    });

    test('carries local turbo/boost flags onto matching fresh entries and skips id-less ones', async () => {
        const { logger } = makeCapturingLogger();
        const challenge = makeChallenge({
            entries: [
                { id: 'e1', turbo: true },
                { id: 'e2', boosted: true },
            ],
        });
        const idless = { votes: 3 };
        const response = freshList('c1', [idless, { id: 'e1' }, { id: 'e2' }]);
        const result = await refreshChallengeState(
            challenge,
            'tok',
            { getActiveChallenges: jest.fn().mockResolvedValue(response), logger },
            'autoFill',
        );
        expect(result).toBe('refreshed');
        const entries = challenge.member.ranking.entries;
        expect(entries[0]).toEqual({ votes: 3 });
        expect(entries.find((e) => e.id === 'e1')).toEqual({ id: 'e1', turbo: true });
        expect(entries.find((e) => e.id === 'e2')).toEqual({ id: 'e2', boosted: true });
    });
});

describe('rankCandidatesForChallenge', () => {
    test('passes a fetch-error through untouched (default options)', async () => {
        const { logger } = makeCapturingLogger();
        const error = new Error('network down');
        const result = await rankCandidatesForChallenge(makeChallenge(), 'tok', {
            settings: makeSettings(),
            logger,
            getEligiblePhotos: jest.fn().mockRejectedValue(error),
        });
        expect(result.status).toBe('fetch-error');
        expect(result.error).toBe(error);
    });
});

describe('maybeEmergencyFillChallenge', () => {
    test('skips a challenge whose close_time is unreadable', async () => {
        const { logger } = makeCapturingLogger();
        const challenge = makeChallenge();
        challenge.close_time = 'soon';
        const deps = { settings: makeSettings(), logger, getEligiblePhotos: jest.fn(), submitToChallenge: jest.fn() };
        await expect(maybeEmergencyFillChallenge(challenge, 'tok', NOW, deps)).resolves.toBe('skipped');
        expect(deps.getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('a refresh that still shows room submits the whole pick', async () => {
        const { logger } = makeCapturingLogger();
        const challenge = makeChallenge({ maxSubmits: 3, entries: [], closeIn: 200 });
        const deps = {
            settings: makeSettings({ emergencyFill: 300 }),
            logger,
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1'), allowedPhoto('p2')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
            getActiveChallenges: jest.fn().mockResolvedValue(freshList('c1', [])),
        };
        await maybeEmergencyFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.submitToChallenge).toHaveBeenCalledTimes(1);
        expect(deps.submitToChallenge.mock.calls[0][1].sort()).toEqual(['p1', 'p2']);
    });
});

describe('submitNewEntryForAction', () => {
    test('refuses a challenge without an id before touching settings or the API', async () => {
        const settings = makeSettings();
        const getEligiblePhotos = jest.fn();
        const result = await submitNewEntryForAction({ id: null }, 'tok', {
            settings,
            logger: makeCapturingLogger().logger,
            getEligiblePhotos,
            submitToChallenge: jest.fn(),
        });
        expect(result).toEqual({ ok: false, imageId: null, reason: 'invalid-challenge' });
        expect(settings.getEffectiveTagSetting).not.toHaveBeenCalled();
        expect(getEligiblePhotos).not.toHaveBeenCalled();
    });

    test('a live re-check that still shows a free slot proceeds to submit', async () => {
        const deps = {
            settings: makeSettings(),
            logger: makeCapturingLogger().logger,
            getEligiblePhotos: jest.fn().mockResolvedValue([allowedPhoto('p1')]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
            getActiveChallenges: jest.fn().mockResolvedValue(freshList('c1', [])),
        };
        const result = await submitNewEntryForAction(makeChallenge({ maxSubmits: 2 }), 'tok', deps);
        expect(result).toEqual({ ok: true, imageId: 'p1', reason: 'submitted' });
        expect(deps.getActiveChallenges).toHaveBeenCalledWith('tok');
    });
});

describe('negated-title fallback warning', () => {
    const { fillChallengeNow } = require('../../src/js/services/autoFill');

    test('when every eligible photo shows the excluded subject, the fill warns before going off-theme', async () => {
        const { logger, lines } = makeCapturingLogger();
        const challenge = buildChallenge({
            id: 'c-neg',
            title: 'No People',
            url: 'no-people',
            max_photo_submits: 4,
            close_time: NOW + 86400,
            member: { ranking: { entries: [] } },
        });
        const person = (id) => ({ ...allowedPhoto(id), labels: ['People', 'Portrait'] });
        const submitToChallenge = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
        const result = await fillChallengeNow(challenge, 'tok', 'one', {
            logger,
            getEligiblePhotos: jest.fn().mockResolvedValue([person('p1'), person('p2')]),
            submitToChallenge,
        });
        expect(result.success).toBe(true);
        const warning = lines.warning.find((m) => m.includes('every eligible photo shows what the title excludes'));
        expect(warning).toBeDefined();
        expect(warning).toContain('falling back to the full library');
    });
});

describe('popularity-pick explanation after a refresh truncates the batch', () => {
    test('no popularity line when the truncated pick kept only the theme-matched photo', async () => {
        const { logger, lines } = makeCapturingLogger();
        // 3 free slots at pass start → wantCount 3: the on-theme photo takes slot 1
        // and two of the three tied off-theme photos (the contested group) take the
        // rest. The live re-check then shows only 1 free slot, so the batch is cut
        // to the on-theme photo alone — nothing chosen on popularity was submitted.
        const challenge = makeChallenge({ maxSubmits: 3, entries: [], closeIn: 200 });
        const photo = (id, labels) => ({ ...allowedPhoto(id), labels });
        const deps = {
            settings: makeSettings({ emergencyFill: 300 }),
            logger,
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([
                    photo('on', ['Pink']),
                    photo('x1', ['Misc']),
                    photo('x2', ['Misc']),
                    photo('x3', ['Misc']),
                ]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
            getActiveChallenges: jest.fn().mockResolvedValue(freshList('c1', [{ id: 'm1' }, { id: 'm2' }])),
        };
        await maybeEmergencyFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.submitToChallenge).toHaveBeenCalledWith('c1', ['on'], 'tok');
        const all = [...lines.info, ...lines.warning];
        expect(all.some((m) => m.includes('chosen on past performance'))).toBe(false);
    });

    test('without truncation the tied off-theme picks ARE explained', async () => {
        const { logger, lines } = makeCapturingLogger();
        const challenge = makeChallenge({ maxSubmits: 3, entries: [], closeIn: 200 });
        const photo = (id, labels) => ({ ...allowedPhoto(id), labels });
        const deps = {
            settings: makeSettings({ emergencyFill: 300 }),
            logger,
            getEligiblePhotos: jest
                .fn()
                .mockResolvedValue([
                    photo('on', ['Pink']),
                    photo('x1', ['Misc']),
                    photo('x2', ['Misc']),
                    photo('x3', ['Misc']),
                ]),
            submitToChallenge: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
            getActiveChallenges: jest.fn().mockResolvedValue(freshList('c1', [])),
        };
        await maybeEmergencyFillChallenge(challenge, 'tok', NOW, deps);
        expect(deps.submitToChallenge.mock.calls[0][1]).toHaveLength(3);
        expect(lines.warning.some((m) => m.includes('chosen on past performance'))).toBe(true);
    });
});

describe('themed search edge shapes', () => {
    const { fetchCandidatesForChallenge } = require('../../src/js/services/autoFill');
    const LIB = [allowedPhoto('lib1'), allowedPhoto('lib2')];

    test('a search that answers with a non-array is treated as no hits', async () => {
        const { logger } = makeCapturingLogger();
        const getEligiblePhotos = jest.fn(async (_id, _tok, opts = {}) => (opts.search ? { oops: true } : LIB));
        const result = await fetchCandidatesForChallenge(
            { id: 'c1', title: 'Pink' },
            'tok',
            {},
            { getEligiblePhotos, logger },
        );
        expect(result).toEqual(LIB);
    });

    test('resolved tags whose search finds nothing eligible still fall back to the library', async () => {
        __resetMemberIdCache();
        const { logger, lines } = makeCapturingLogger();
        // Every themed search (the original term and the resolved tag alike)
        // only surfaces a photo the challenge does not allow.
        const getEligiblePhotos = jest.fn(async (_id, _tok, opts = {}) =>
            opts.search ? [{ id: 'blocked', permission: { allowed: false } }] : LIB,
        );
        const result = await fetchCandidatesForChallenge(
            { id: 'c1', title: 'Pink' },
            'tok',
            {},
            {
                getEligiblePhotos,
                logger,
                searchTagAutocomplete: jest.fn(async () => ['pinks']),
                getCurrentMemberProfile: jest.fn(async () => ({ id: 'member-hash' })),
            },
        );
        expect(getEligiblePhotos).toHaveBeenCalledWith('c1', 'tok', expect.objectContaining({ search: 'pinks' }));
        expect(result).toEqual(LIB);
        expect(lines.info.some((m) => m.includes('resolved theme'))).toBe(false);
    });
});
