/**
 * Tests for metadata.js — local per-challenge state used to track when
 * we last voted on each challenge and what the exposure was at that time.
 *
 * Highest-value coverage targets the cleanupStaleMetadata function:
 *   - The "no active challenges" early-return guard, which prevents an
 *     empty-fetch from wiping out a user's voting history.
 *   - The recent-vote preservation rule (1-hour window): a challenge
 *     missing from the active list but voted on within the last hour
 *     is kept, because the absence is more likely a transient API
 *     glitch than a real challenge ending.
 *
 * loadMetadata/saveMetadata round-trip and validation are also covered
 * here at boundary level — invalid entries get dropped, missing
 * updateCheck gets defaulted.
 */

const fs = require('node:fs');

jest.mock('../src/js/settings', () => ({
    getUserDataPath: jest.fn(() => '/fake/userdata'),
}));

const metadata = require('../src/js/metadata');

const setStoredMetadata = (obj) => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify(obj));
};

const setNoStoredFile = () => {
    fs.existsSync.mockReturnValue(false);
};

const captureWrites = () => {
    const writes = [];
    fs.writeFileSync.mockImplementation((p, data) => writes.push(JSON.parse(data)));
    return writes;
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('loadMetadata', () => {
    test('returns default metadata when file does not exist', () => {
        setNoStoredFile();
        expect(metadata.loadMetadata()).toEqual({
            updateCheck: { lastCheck: null, skipVersion: null },
        });
    });

    test('returns valid stored metadata as-is', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: 123456, skipVersion: '1.2.3' },
            777: { lastVoteTime: '2026-05-09T12:00:00Z', exposureBump: 75 },
        });
        const result = metadata.loadMetadata();
        expect(result.updateCheck).toEqual({ lastCheck: 123456, skipVersion: '1.2.3' });
        expect(result['777']).toEqual({ lastVoteTime: '2026-05-09T12:00:00Z', exposureBump: 75 });
    });

    test('drops invalid challenge entry and rewrites file', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            777: { lastVoteTime: 'not a real date', exposureBump: 75 },
            888: { lastVoteTime: '2026-05-09T12:00:00Z', exposureBump: 50 },
        });
        const writes = captureWrites();
        const result = metadata.loadMetadata();
        // Invalid entry dropped; valid entry kept.
        expect(result['777']).toBeUndefined();
        expect(result['888']).toEqual({ lastVoteTime: '2026-05-09T12:00:00Z', exposureBump: 50 });
        // Validation triggered a rewrite of the corrected file.
        expect(writes).toHaveLength(1);
        expect(writes[0]['777']).toBeUndefined();
    });

    test('drops negative exposureBump but keeps oversized values (>100% is legitimate)', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            777: { exposureBump: -5 },
            888: { exposureBump: 150 }, // legitimate when fewer images than expected
        });
        captureWrites();
        const result = metadata.loadMetadata();
        expect(result['777']).toBeUndefined();
        expect(result['888']).toEqual({ exposureBump: 150 });
    });

    test('falls back to default metadata if JSON is malformed', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('not json {');
        const result = metadata.loadMetadata();
        expect(result).toEqual({ updateCheck: { lastCheck: null, skipVersion: null } });
    });
});

describe('saveMetadata', () => {
    test('writes JSON to the metadata file path', () => {
        const writes = captureWrites();
        metadata.saveMetadata({ updateCheck: { lastCheck: 999, skipVersion: null } });
        expect(fs.writeFileSync).toHaveBeenCalled();
        expect(writes[0].updateCheck).toEqual({ lastCheck: 999, skipVersion: null });
    });

    test('returns false when fs.writeFileSync throws', () => {
        fs.writeFileSync.mockImplementation(() => {
            throw new Error('disk full');
        });
        const result = metadata.saveMetadata({ updateCheck: { lastCheck: null, skipVersion: null } });
        expect(result).toBe(false);
    });
});

describe('cleanupStaleMetadata', () => {
    test('returns true and writes nothing when activeChallengeIds is empty (safety guard)', () => {
        const writes = captureWrites();
        const result = metadata.cleanupStaleMetadata([]);
        expect(result).toBe(true);
        expect(writes).toHaveLength(0);
        // Critically: never reads or writes the metadata file.
        expect(fs.readFileSync).not.toHaveBeenCalled();
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('returns true and writes nothing when activeChallengeIds is null/undefined', () => {
        const writes = captureWrites();
        expect(metadata.cleanupStaleMetadata(null)).toBe(true);
        expect(metadata.cleanupStaleMetadata(undefined)).toBe(true);
        expect(writes).toHaveLength(0);
    });

    test('removes stored entries that are not in active list', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            'gone-1': { lastVoteTime: '2020-01-01T00:00:00Z', exposureBump: 50 },
            'gone-2': { lastVoteTime: '2020-01-01T00:00:00Z', exposureBump: 50 },
            'still-here': { lastVoteTime: '2020-01-01T00:00:00Z', exposureBump: 50 },
        });
        const writes = captureWrites();
        const result = metadata.cleanupStaleMetadata(['still-here']);
        expect(result).toBe(true);
        const written = writes[writes.length - 1];
        expect(written['gone-1']).toBeUndefined();
        expect(written['gone-2']).toBeUndefined();
        expect(written['still-here']).toBeDefined();
    });

    test('preserves stored entry voted within the last hour even if absent from active list', () => {
        const recentVote = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            'recent-but-missing': { lastVoteTime: recentVote, exposureBump: 60 },
        });
        const writes = captureWrites();
        const result = metadata.cleanupStaleMetadata(['unrelated']);
        expect(result).toBe(true);
        // No stale-cleanup write should occur — entry preserved.
        // (The validate-on-load path may have written once; the cleanup path
        // should not have written a second time after that.)
        const lastWrite = writes[writes.length - 1];
        if (lastWrite) {
            expect(lastWrite['recent-but-missing']).toBeDefined();
        }
    });

    test('removes stored entry voted more than an hour ago when absent from active list', () => {
        const oldVote = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            'old-and-missing': { lastVoteTime: oldVote, exposureBump: 60 },
        });
        const writes = captureWrites();
        metadata.cleanupStaleMetadata(['unrelated']);
        const lastWrite = writes[writes.length - 1];
        expect(lastWrite['old-and-missing']).toBeUndefined();
    });

    test('returns true without writing when nothing real is stale', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            777: { exposureBump: 50 },
        });
        const writes = captureWrites();
        metadata.cleanupStaleMetadata(['777']);
        // 'updateCheck' is excluded from the stale-candidate list so
        // it doesn't trigger a gratuitous rewrite. The active challenge
        // is still active, so nothing is stale.
        expect(writes).toHaveLength(0);
    });
});

describe('challenge metadata mutators', () => {
    test('setChallengeMetadata rejects empty challengeId', () => {
        expect(metadata.setChallengeMetadata('', '2026-05-09T12:00:00Z', 50)).toBe(false);
    });

    test('setChallengeMetadata rejects invalid timestamp', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null } });
        expect(metadata.setChallengeMetadata('777', 'not-a-date', 50)).toBe(false);
    });

    test('setChallengeMetadata rejects negative exposure', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null } });
        expect(metadata.setChallengeMetadata('777', '2026-05-09T12:00:00Z', -5)).toBe(false);
    });

    test('updateLastVoteTime preserves prior exposureBump', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            777: { lastVoteTime: '2020-01-01T00:00:00Z', exposureBump: 80 },
        });
        const writes = captureWrites();
        metadata.updateLastVoteTime('777', '2026-05-09T12:00:00Z');
        const lastWrite = writes[writes.length - 1];
        expect(lastWrite['777'].exposureBump).toBe(80);
        expect(lastWrite['777'].lastVoteTime).toBe('2026-05-09T12:00:00Z');
    });

    test('removeChallengeMetadata is a no-op when entry does not exist', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null } });
        const writes = captureWrites();
        const result = metadata.removeChallengeMetadata('not-stored');
        expect(result).toBe(true);
        expect(writes).toHaveLength(0);
    });
});

describe('update-check helpers', () => {
    test('getUpdateCheckData returns stored updateCheck', () => {
        setStoredMetadata({ updateCheck: { lastCheck: 555, skipVersion: '9.9.9' } });
        expect(metadata.getUpdateCheckData()).toEqual({ lastCheck: 555, skipVersion: '9.9.9' });
    });

    test('setLastUpdateCheck rejects non-positive timestamps', () => {
        expect(metadata.setLastUpdateCheck(0)).toBe(false);
        expect(metadata.setLastUpdateCheck(-1)).toBe(false);
        expect(metadata.setLastUpdateCheck('123')).toBe(false);
    });

    test('getLegacySkipVersion reads the metadata-resident skip preference', () => {
        setStoredMetadata({ updateCheck: { lastCheck: 1, skipVersion: '9.9.9' } });
        expect(metadata.getLegacySkipVersion()).toBe('9.9.9');
        setStoredMetadata({ updateCheck: { lastCheck: 1, skipVersion: null } });
        expect(metadata.getLegacySkipVersion()).toBeNull();
    });

    test('clearLegacySkipVersion nulls the legacy field and persists', () => {
        setStoredMetadata({ updateCheck: { lastCheck: 1, skipVersion: '9.9.9' } });
        const writes = captureWrites();
        expect(metadata.clearLegacySkipVersion()).toBe(true);
        expect(writes.at(-1).updateCheck.skipVersion).toBeNull();
        expect(writes.at(-1).updateCheck.lastCheck).toBe(1);
    });

    test('clearLegacySkipVersion is a no-op (no write) when nothing is stored', () => {
        setStoredMetadata({ updateCheck: { lastCheck: 1, skipVersion: null } });
        const writes = captureWrites();
        expect(metadata.clearLegacySkipVersion()).toBe(true);
        expect(writes).toHaveLength(0);
    });
});

describe('entryIds snapshot (voteOnNewEntry)', () => {
    test('round-trips through save and load', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null } });
        const writes = captureWrites();

        expect(metadata.setChallengeEntryIds('c1', ['a', 'b'])).toBe(true);
        expect(writes.at(-1).c1.entryIds).toEqual(['a', 'b']);

        setStoredMetadata(writes.at(-1));
        expect(metadata.getChallengeEntryIds('c1')).toEqual(['a', 'b']);
    });

    test('an empty snapshot is preserved and is distinct from an absent one', () => {
        // [] means "seen, and the challenge had no entries" — a valid baseline that
        // must not read as null, or the very next pass would fire on everything.
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null } });
        const writes = captureWrites();

        metadata.setChallengeEntryIds('c1', []);
        expect(writes.at(-1).c1.entryIds).toEqual([]);

        setStoredMetadata(writes.at(-1));
        expect(metadata.getChallengeEntryIds('c1')).toEqual([]);
        expect(metadata.getChallengeEntryIds('never-seen')).toBeNull();
    });

    test('merges into an existing entry without disturbing vote history', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            c1: { lastVoteTime: '2026-01-01T00:00:00.000Z', exposureBump: 42 },
        });
        const writes = captureWrites();

        metadata.setChallengeEntryIds('c1', ['a']);

        expect(writes.at(-1).c1).toEqual({
            lastVoteTime: '2026-01-01T00:00:00.000Z',
            exposureBump: 42,
            entryIds: ['a'],
        });
    });

    test('skips the write when the id set is unchanged, including a reorder', () => {
        // The whole file is re-read and re-serialized on every write, so a
        // server-side reorder must not cost any I/O at all.
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            c1: { entryIds: ['a', 'b'] },
        });
        const writes = captureWrites();

        expect(metadata.setChallengeEntryIds('c1', ['a', 'b'])).toBe(true);
        expect(writes).toHaveLength(0);

        expect(metadata.setChallengeEntryIds('c1', ['b', 'a'])).toBe(true);
        expect(writes).toHaveLength(0);

        expect(metadata.setChallengeEntryIds('c1', ['a', 'b', 'c'])).toBe(true);
        expect(writes).toHaveLength(1);
    });

    test.each([
        ['not an array', 'nope'],
        ['contains a non-string', ['a', 7]],
        ['contains an empty string', ['a', '']],
        ['over the id-count cap', Array.from({ length: 65 }, (_, i) => `id${i}`)],
        ['contains an over-long id', ['a'.repeat(65)]],
    ])('a malformed entryIds (%s) is stripped while the rest of the entry survives', (_label, entryIds) => {
        // entryIds derives from a remote API response, unlike lastVoteTime and
        // exposureBump — so it must never be able to take real voting history down
        // with it the way a malformed internal field does.
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            c1: { lastVoteTime: '2026-01-01T00:00:00.000Z', exposureBump: 42, entryIds },
        });

        const loaded = metadata.loadMetadata();

        expect(loaded.c1).toEqual({ lastVoteTime: '2026-01-01T00:00:00.000Z', exposureBump: 42 });
        expect(metadata.getChallengeEntryIds('c1')).toBeNull();
    });

    test('an entry malformed in BOTH ways is still dropped whole, not repaired', () => {
        // Ordering guard: the pre-existing lastVoteTime/exposureBump checks must
        // short-circuit before the entryIds repair path can rescue the entry.
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            c1: { lastVoteTime: 'not-a-date', entryIds: 'also-bad' },
        });

        expect(metadata.loadMetadata().c1).toBeUndefined();
    });

    test('setChallengeEntryIds refuses to store a malformed snapshot', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null } });
        const writes = captureWrites();

        expect(metadata.setChallengeEntryIds('c1', ['ok', 123])).toBe(false);
        expect(metadata.setChallengeEntryIds('', ['ok'])).toBe(false);
        expect(writes).toHaveLength(0);
    });

    test('cleanupStaleMetadata removes snapshots along with their challenge', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            gone: { entryIds: ['a'] },
            live: { entryIds: ['b'] },
        });
        const writes = captureWrites();

        expect(metadata.cleanupStaleMetadata(['live'])).toBe(true);

        expect(writes.at(-1).gone).toBeUndefined();
        expect(writes.at(-1).live.entryIds).toEqual(['b']);
    });
});

describe('validation of stored metadata', () => {
    const logger = require('../src/js/logger');
    const warnings = () =>
        logger.withCategory.mock.results.flatMap((r) => r.value.warning.mock.calls.map((call) => call[0]));

    test.each([
        ['a null entry', null],
        ['a primitive entry', 42],
        ['a non-string lastVoteTime', { lastVoteTime: 12345 }],
        ['a non-number exposureBump', { exposureBump: '50' }],
    ])('drops %s and rewrites the file', (_label, entry) => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            777: entry,
            888: { exposureBump: 1 },
        });
        const writes = captureWrites();

        const result = metadata.loadMetadata();

        expect(result['777']).toBeUndefined();
        expect(result['888']).toEqual({ exposureBump: 1 });
        expect(writes).toHaveLength(1);
        expect(warnings()).toEqual([expect.stringContaining('Removing invalid metadata entry for challenge 777')]);
    });

    test('logs a summary when more than one entry is removed', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            1: null,
            2: { exposureBump: -1 },
        });
        captureWrites();

        const result = metadata.loadMetadata();

        expect(Object.keys(result)).toEqual(['updateCheck']);
        expect(warnings()).toContain('Cleaned up 2 invalid metadata entries total');
    });

    test('adds a missing updateCheck block and persists the repair', () => {
        setStoredMetadata({ 777: { exposureBump: 10 } });
        const writes = captureWrites();

        const result = metadata.loadMetadata();

        expect(result.updateCheck).toEqual({ lastCheck: null, skipVersion: null });
        expect(result['777']).toEqual({ exposureBump: 10 });
        expect(writes).toHaveLength(1);
        expect(writes[0].updateCheck).toEqual({ lastCheck: null, skipVersion: null });
    });

    test('an updateCheck with undefined fields defaults them to null without a rewrite', () => {
        setStoredMetadata({ updateCheck: {} });
        const writes = captureWrites();

        expect(metadata.loadMetadata().updateCheck).toEqual({ lastCheck: null, skipVersion: null });
        expect(writes).toHaveLength(0);
    });

    test.each([
        ['zero', 0, '0 (must be > 0)'],
        ['negative', -5, '-5 (must be > 0)'],
        ['a string', 'yesterday', 'yesterday (type: string, expected: number)'],
    ])('removes an invalid lastCheck (%s)', (_label, lastCheck, desc) => {
        setStoredMetadata({ updateCheck: { lastCheck, skipVersion: '1.0.0' } });
        const writes = captureWrites();

        const result = metadata.loadMetadata();

        expect(result.updateCheck).toEqual({ lastCheck: null, skipVersion: '1.0.0' });
        expect(writes).toHaveLength(1);
        expect(warnings()).toEqual([`Invalid lastCheck timestamp in metadata: ${desc}, removing`]);
    });

    test.each([
        ['an empty string', '', '"" (empty string)'],
        ['a number', 7, '7 (type: number, expected: non-empty string)'],
    ])('removes an invalid skipVersion (%s)', (_label, skipVersion, desc) => {
        setStoredMetadata({ updateCheck: { lastCheck: 100, skipVersion } });
        const writes = captureWrites();

        const result = metadata.loadMetadata();

        expect(result.updateCheck).toEqual({ lastCheck: 100, skipVersion: null });
        expect(writes).toHaveLength(1);
        expect(warnings()).toEqual([`Invalid skipVersion in metadata: ${desc}, removing`]);
    });

    test('a stripped entryIds snapshot is logged and triggers a rewrite', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null }, c1: { entryIds: 'bad' } });
        const writes = captureWrites();

        metadata.loadMetadata();

        expect(writes).toHaveLength(1);
        expect(writes[0].c1).toEqual({});
        expect(warnings()).toEqual([expect.stringContaining('Dropping invalid entryIds snapshot for challenge c1')]);
    });
});

describe('challenge metadata mutators — write paths', () => {
    test('setChallengeMetadata creates a new entry when none exists', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null } });
        const writes = captureWrites();

        expect(metadata.setChallengeMetadata('900', '2026-05-09T12:00:00Z', 33)).toBe(true);
        expect(writes.at(-1)['900']).toEqual({ lastVoteTime: '2026-05-09T12:00:00Z', exposureBump: 33 });
    });

    test('setChallengeMetadata with neither field writes an empty entry', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null } });
        const writes = captureWrites();

        expect(metadata.setChallengeMetadata('901')).toBe(true);
        expect(writes.at(-1)['901']).toEqual({});
    });

    test('setChallengeMetadata rejects a non-number exposure', () => {
        const writes = captureWrites();
        expect(metadata.setChallengeMetadata('777', undefined, '50')).toBe(false);
        expect(writes).toHaveLength(0);
    });

    test('updateLastVoteTime defaults the timestamp to now', () => {
        jest.useFakeTimers({ now: new Date('2026-09-01T10:00:00.000Z') });
        try {
            setNoStoredFile();
            const writes = captureWrites();

            expect(metadata.updateLastVoteTime('555')).toBe(true);
            expect(writes.at(-1)['555']).toEqual({ lastVoteTime: '2026-09-01T10:00:00.000Z' });
        } finally {
            jest.useRealTimers();
        }
    });

    test('updateExposureBump preserves the prior lastVoteTime', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            777: { lastVoteTime: '2026-01-01T00:00:00Z', exposureBump: 10 },
        });
        const writes = captureWrites();

        expect(metadata.updateExposureBump('777', 120)).toBe(true);
        expect(writes.at(-1)['777']).toEqual({ lastVoteTime: '2026-01-01T00:00:00Z', exposureBump: 120 });
    });

    test('updateExposureBump on an unknown challenge stores only the exposure', () => {
        setNoStoredFile();
        const writes = captureWrites();

        expect(metadata.updateExposureBump('new', 5)).toBe(true);
        expect(writes.at(-1).new).toEqual({ exposureBump: 5 });
    });

    test('updateChallengeVoteMetadata writes both fields, defaulting the time to now', () => {
        jest.useFakeTimers({ now: new Date('2026-09-02T08:30:00.000Z') });
        try {
            setNoStoredFile();
            const writes = captureWrites();

            expect(metadata.updateChallengeVoteMetadata('10', 60)).toBe(true);
            expect(writes.at(-1)['10']).toEqual({ lastVoteTime: '2026-09-02T08:30:00.000Z', exposureBump: 60 });

            expect(metadata.updateChallengeVoteMetadata('11', 70, '2026-01-01T00:00:00Z')).toBe(true);
            expect(writes.at(-1)['11']).toEqual({ lastVoteTime: '2026-01-01T00:00:00Z', exposureBump: 70 });
        } finally {
            jest.useRealTimers();
        }
    });

    test('removeChallengeMetadata deletes an existing entry and persists', () => {
        setStoredMetadata({
            updateCheck: { lastCheck: null, skipVersion: null },
            777: { exposureBump: 1 },
            888: { exposureBump: 2 },
        });
        const writes = captureWrites();

        expect(metadata.removeChallengeMetadata('777')).toBe(true);
        expect(writes.at(-1)['777']).toBeUndefined();
        expect(writes.at(-1)['888']).toEqual({ exposureBump: 2 });
    });

    test('getChallengeMetadata returns null for an unknown challenge', () => {
        setNoStoredFile();
        expect(metadata.getChallengeMetadata('nope')).toBeNull();
    });
});

describe('entryIds snapshot — guards', () => {
    test.each(['__proto__', 'constructor', 'prototype'])('refuses the reserved key %s', (key) => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null } });
        const writes = captureWrites();

        expect(metadata.setChallengeEntryIds(key, ['a'])).toBe(false);
        expect(writes).toHaveLength(0);
        // Refused before any read, so Object.prototype can't be reached.
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    test('a same-length list with a different member is a change', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null }, c1: { entryIds: ['a', 'b'] } });
        const writes = captureWrites();

        expect(metadata.setChallengeEntryIds('c1', ['a', 'c'])).toBe(true);
        expect(writes.at(-1).c1.entryIds).toEqual(['a', 'c']);
    });

    test('duplicates are compared as sets: ["a","a"] vs ["a","b"] is a change', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null }, c1: { entryIds: ['a', 'b'] } });
        const writes = captureWrites();

        expect(metadata.setChallengeEntryIds('c1', ['a', 'a'])).toBe(true);
        expect(writes).toHaveLength(1);
        expect(writes.at(-1).c1.entryIds).toEqual(['a', 'a']);
    });

    test('an existing entry without a snapshot gets one written', () => {
        setStoredMetadata({ updateCheck: { lastCheck: null, skipVersion: null }, c1: { exposureBump: 3 } });
        const writes = captureWrites();

        expect(metadata.setChallengeEntryIds('c1', [])).toBe(true);
        expect(writes.at(-1).c1).toEqual({ exposureBump: 3, entryIds: [] });
    });
});

describe('utility and update-check write paths', () => {
    test('getAllMetadata returns the validated store contents', () => {
        setStoredMetadata({ updateCheck: { lastCheck: 5, skipVersion: null }, 1: { exposureBump: 9 } });
        expect(metadata.getAllMetadata()).toEqual({
            updateCheck: { lastCheck: 5, skipVersion: null },
            1: { exposureBump: 9 },
        });
    });

    test('resetAllMetadata writes back the default structure only', () => {
        const writes = captureWrites();
        expect(metadata.resetAllMetadata()).toBe(true);
        expect(writes.at(-1)).toEqual({ updateCheck: { lastCheck: null, skipVersion: null } });
    });

    test('setLastUpdateCheck stores a valid timestamp and keeps skipVersion', () => {
        setStoredMetadata({ updateCheck: { lastCheck: 1, skipVersion: '2.0.0' }, 7: { exposureBump: 1 } });
        const writes = captureWrites();

        expect(metadata.setLastUpdateCheck(1_700_000_000_000)).toBe(true);
        expect(writes.at(-1).updateCheck).toEqual({ lastCheck: 1_700_000_000_000, skipVersion: '2.0.0' });
        expect(writes.at(-1)['7']).toEqual({ exposureBump: 1 });
    });

    test('setLastUpdateCheck works on a fresh install with no stored file', () => {
        setNoStoredFile();
        const writes = captureWrites();

        expect(metadata.setLastUpdateCheck(42)).toBe(true);
        expect(writes.at(-1).updateCheck).toEqual({ lastCheck: 42, skipVersion: null });
    });

    test('getMetadataPath resolves to metadata.json under the user-data dir', () => {
        expect(metadata.getMetadataPath()).toMatch(/metadata\.json$/);
    });
});
