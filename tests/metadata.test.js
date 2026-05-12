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

    test('setSkipUpdateVersion rejects empty / non-string versions', () => {
        expect(metadata.setSkipUpdateVersion('')).toBe(false);
        expect(metadata.setSkipUpdateVersion(null)).toBe(false);
        expect(metadata.setSkipUpdateVersion(123)).toBe(false);
    });
});
