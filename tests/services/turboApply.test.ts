/**
 * shouldApplyTurbo decides whether to apply a previously-won Turbo to
 * one of the user's entries on a challenge. The evaluator combines
 * timing (turboTime threshold) and entry index (per-entry boost/turbo
 * are mutually exclusive — turbo applies to a specific entry). An open
 * boost window does not hold turbo back; only the shared entry does.
 */

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import VotingLogic = require('../../src/ts/services/VotingLogic');
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type { RankingEntry } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';
const { buildChallenge: buildBaseChallenge } =
    require('../helpers/challengeFixtures') as typeof challengeFixturesModule;

jest.mock('../../src/ts/settings');

const buildChallenge = ({
    turboState = 'WON',
    turboMode = 'classic',
    closeInSeconds = 600,
    entries = [{ id: 'entry-1' }, { id: 'entry-2' }, { id: 'entry-3' }],
    boostState = 'NONE',
    boostTimeout = 0,
}: {
    turboState?: string;
    turboMode?: string;
    closeInSeconds?: number;
    entries?: RankingEntry[];
    boostState?: string;
    boostTimeout?: number;
}) =>
    buildBaseChallenge({
        id: '222',
        close_time: Math.floor(Date.now() / 1000) + closeInSeconds,
        member: {
            turbo: { state: turboState, mode: turboMode },
            boost: { state: boostState, timeout: boostTimeout },
            ranking: { entries },
        },
    });

const mockSettings = (overrides = {}) => {
    const defaults = {
        useTurbo: true,
        turboTime: 7200,
        turboImageIndex: 1,
        turboNewSubmit: false,
        turboNewSubmitOnConflict: false,
        emergencySubmit: 300,
    };
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => ({ ...defaults, ...overrides })[key]));
};

const NOW = () => Math.floor(Date.now() / 1000);

describe('shouldApplyTurbo', () => {
    beforeEach(() => jest.clearAllMocks());

    test('applies when state is WON and within turboTime window', () => {
        mockSettings();
        const challenge = buildChallenge({ closeInSeconds: 600 }); // 10 min < 7200 default
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());

        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('entry-1'); // turboImageIndex=1 → first entry
    });

    test('does not apply when useTurbo is disabled', () => {
        mockSettings({ useTurbo: false });
        const challenge = buildChallenge({ closeInSeconds: 600 });
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(false);
    });

    test('does not apply when state is not WON', () => {
        mockSettings();
        const challenge = buildChallenge({ turboState: 'TIMER' });
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(false);
    });

    test('does not apply a won turbo whose mode is unknown (the mobile copy)', () => {
        mockSettings();
        const challenge = buildBaseChallenge({
            id: '222',
            close_time: NOW() + 600,
            member: { turbo: { state: 'WON' }, ranking: { entries: [{ id: 'entry-1' }] } },
        });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(false);
        expect(result.reason).toBe('turbo mode unknown');
    });

    test('applies a won Snap-mode turbo', () => {
        mockSettings();
        const challenge = buildChallenge({ turboMode: 'snap' });
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(true);
    });

    test('does not apply when challenge has ended', () => {
        mockSettings();
        const challenge = buildChallenge({ closeInSeconds: -10 });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(false);
        expect(result.reason).toBe('challenge ended');
    });

    test('does not apply when remaining time exceeds turboTime threshold', () => {
        mockSettings({ turboTime: 600 }); // 10 min threshold
        const challenge = buildChallenge({ closeInSeconds: 7200 }); // 2h remaining
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(false);
        expect(result.reason).toContain('threshold');
    });

    test.each([
        ['timer boost', 'AVAILABLE', NOW() + 1800],
        ['key-unlocked boost', 'AVAILABLE_KEY', 0],
    ])('applies while a %s window is open — boost and turbo are independent', (_label, boostState, boostTimeout) => {
        mockSettings();
        const challenge = buildChallenge({ closeInSeconds: 600, boostState, boostTimeout });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('entry-1');
    });

    test('with a boost window open, still steps off the boosted entry', () => {
        mockSettings();
        const challenge = buildChallenge({
            closeInSeconds: 600,
            boostState: 'AVAILABLE',
            boostTimeout: NOW() + 1800,
            entries: [{ id: 'entry-1', boosted: true }, { id: 'entry-2' }],
        });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('entry-2');
    });

    test('turboImageIndex 0 maps to last entry (sentinel)', () => {
        mockSettings({ turboImageIndex: 0 });
        const challenge = buildChallenge({
            closeInSeconds: 600,
            entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('c');
    });

    test('turboImageIndex above entry count clamps to last entry', () => {
        mockSettings({ turboImageIndex: 99 });
        const challenge = buildChallenge({
            closeInSeconds: 600,
            entries: [{ id: 'a' }, { id: 'b' }],
        });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('b');
    });

    test('does not apply (no entries) when challenge has no entries and fill-new is off', () => {
        mockSettings();
        const challenge = buildChallenge({ closeInSeconds: 600, entries: [] });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(false);
        expect(result.reason).toBe('no entries to apply turbo to');
    });

    test('reports fillNew=false on the normal (non fill-new) path', () => {
        mockSettings();
        const challenge = buildChallenge({ closeInSeconds: 600 });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(true);
        expect(result.fillNew).toBe(false);
    });

    describe('turboNewSubmit (fill-new)', () => {
        test('applies with fillNew=true and no entries (fill-new can create the first entry)', () => {
            mockSettings({ turboNewSubmit: true });
            const challenge = buildChallenge({ closeInSeconds: 600, entries: [] });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(true);
            expect(result.fillNew).toBe(true);
            expect(result.imageId).toBeNull(); // no existing fallback target
        });

        test('still passes the existing entry as a fallback target when entries exist', () => {
            mockSettings({ turboNewSubmit: true });
            const challenge = buildChallenge({ closeInSeconds: 600 }); // entry-1..3
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(true);
            expect(result.fillNew).toBe(true);
            expect(result.imageId).toBe('entry-1'); // turboImageIndex=1 → first entry
        });

        test('still honors the WON gate when fill-new is on', () => {
            mockSettings({ turboNewSubmit: true });
            const challenge = buildChallenge({ turboState: 'TIMER', closeInSeconds: 600, entries: [] });
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(false);
        });

        test('still honors the timing threshold when fill-new is on', () => {
            mockSettings({ turboNewSubmit: true, turboTime: 600 });
            const challenge = buildChallenge({ closeInSeconds: 7200, entries: [] });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(false);
            expect(result.reason).toContain('threshold');
        });

        test('applies with a null fallback when the only existing entry is already boosted', () => {
            // Picker returns null (single entry already boosted) — fill-new still
            // applies, with imageId=null so the caller knows there is no fallback.
            mockSettings({ turboNewSubmit: true });
            const challenge = buildChallenge({ closeInSeconds: 600, entries: [{ id: 'b1', boosted: true }] });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(true);
            expect(result.fillNew).toBe(true);
            expect(result.imageId).toBeNull();
        });
    });

    describe('Manual Only turns both fresh-photo options off', () => {
        test('turboNewSubmit: turbo goes on the existing entry, never a fresh photo', () => {
            mockSettings({ turboNewSubmit: true, manualPhotosOnly: true });
            const result = VotingLogic.shouldApplyTurbo(buildChallenge({ closeInSeconds: 600 }), NOW());
            expect(result).toMatchObject({ apply: true, fillNew: false, imageId: 'entry-1' });
        });

        test('turboNewSubmit with no entries: nothing to turbo, and no photo is submitted for it', () => {
            mockSettings({ turboNewSubmit: true, manualPhotosOnly: true });
            const result = VotingLogic.shouldApplyTurbo(buildChallenge({ closeInSeconds: 600, entries: [] }), NOW());
            expect(result.apply).toBe(false);
            expect(result.fillNew).toBe(false);
        });

        test('turboNewSubmitOnConflict: a boosted sole entry is left alone, with no fresh photo', () => {
            mockSettings({ turboNewSubmitOnConflict: true, manualPhotosOnly: true });
            const challenge = buildChallenge({ closeInSeconds: 600, entries: [{ id: 'b1', boosted: true }] });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(false);
            expect(result.fillNew).toBe(false);
            expect(result.reason).toContain('Boost');
        });

        test('with the switch off the same settings still fill a fresh photo', () => {
            mockSettings({ turboNewSubmit: true, turboNewSubmitOnConflict: true, manualPhotosOnly: false });
            const result = VotingLogic.shouldApplyTurbo(buildChallenge({ closeInSeconds: 600 }), NOW());
            expect(result.fillNew).toBe(true);
        });
    });

    describe('turboNewSubmitOnConflict (fill-new only to break a boost/turbo conflict)', () => {
        test('fills a fresh photo when the only existing entry is already boosted', () => {
            // The narrower opt-in: turbo cannot go on the single boosted entry, so
            // submit a fresh one instead. imageId=null — there is no fallback target.
            mockSettings({ turboNewSubmitOnConflict: true });
            const challenge = buildChallenge({ closeInSeconds: 600, entries: [{ id: 'b1', boosted: true }] });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(true);
            expect(result.fillNew).toBe(true);
            expect(result.imageId).toBeNull();
            expect(result.reason).toContain('conflict');
        });

        test('does NOT fill new in the normal case — turbos the existing entry', () => {
            // No conflict: the picked entry is free, so on-conflict stays dormant and
            // turbo applies to the existing entry the normal way (fillNew=false).
            mockSettings({ turboNewSubmitOnConflict: true });
            const challenge = buildChallenge({ closeInSeconds: 600 }); // entry-1..3, none boosted
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(true);
            expect(result.fillNew).toBe(false);
            expect(result.imageId).toBe('entry-1');
        });

        test('does NOT fill new when there are simply no entries yet (not a conflict)', () => {
            // Empty list is the "always fill-new" case, not the conflict case; the
            // narrower toggle leaves it as the ordinary no-entries noop.
            mockSettings({ turboNewSubmitOnConflict: true });
            const challenge = buildChallenge({ closeInSeconds: 600, entries: [] });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(false);
            expect(result.fillNew).toBe(false);
            expect(result.reason).toBe('no entries to apply turbo to');
        });

        test('turboNewSubmit (always) takes precedence over on-conflict', () => {
            // Both on, no conflict present: the always-fill path wins and still
            // fills new, passing the existing entry as the fallback target.
            mockSettings({ turboNewSubmit: true, turboNewSubmitOnConflict: true });
            const challenge = buildChallenge({ closeInSeconds: 600 }); // entry-1..3
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(true);
            expect(result.fillNew).toBe(true);
            expect(result.imageId).toBe('entry-1');
        });

        test('stays off by default — only boosted entry is a plain noop', () => {
            mockSettings(); // turboNewSubmitOnConflict:false
            const challenge = buildChallenge({ closeInSeconds: 600, entries: [{ id: 'b1', boosted: true }] });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(false);
            expect(result.fillNew).toBe(false);
            expect(result.reason).toBe('every entry has Boost or is pinned for Boost');
        });
    });

    describe('emergency override', () => {
        test('applies a won turbo in the emergency window even when useTurbo is off', () => {
            mockSettings({ useTurbo: false, emergencySubmit: 300 });
            const challenge = buildChallenge({ closeInSeconds: 120 }); // inside 5-min window
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true });
            expect(result.apply).toBe(true);
            expect(result.imageId).toBe('entry-1');
        });

        test('has no effect without the option flag (default behavior unchanged)', () => {
            mockSettings({ useTurbo: false, emergencySubmit: 300 });
            const challenge = buildChallenge({ closeInSeconds: 120 });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(false);
            expect(result.reason).toBe('useTurbo disabled');
        });

        test('bypasses the turboTime threshold in the emergency window', () => {
            mockSettings({ turboTime: 60, emergencySubmit: 300 }); // 2 min remaining > 1 min threshold
            const challenge = buildChallenge({ closeInSeconds: 120 });
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(false); // blocked without emergency
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true }).apply).toBe(true);
        });

        test('still honors the WON gate', () => {
            mockSettings({ useTurbo: false, emergencySubmit: 300 });
            const challenge = buildChallenge({ turboState: 'TIMER', closeInSeconds: 120 });
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true }).apply).toBe(false);
        });

        test('does not override outside the emergency window', () => {
            mockSettings({ useTurbo: false, emergencySubmit: 300 });
            const challenge = buildChallenge({ closeInSeconds: 600 }); // 10 min > 5-min window
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true });
            expect(result.apply).toBe(false);
            expect(result.reason).toBe('useTurbo disabled');
        });

        test('does not override when Emergency Fill is disabled (0)', () => {
            mockSettings({ useTurbo: false, emergencySubmit: 0 });
            const challenge = buildChallenge({ closeInSeconds: 120 });
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true }).apply).toBe(false);
        });
    });
});
