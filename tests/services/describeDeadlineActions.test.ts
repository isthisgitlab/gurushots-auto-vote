/**
 * describeDeadlineActions is the read-only, renderer-facing view behind the
 * get-deadline-actions IPC channel: the deadline actions that will ACTUALLY
 * fire (gated on the runner's own conditions, not just a positive threshold)
 * plus each one's absolute dueAt, and the boost/turbo conflict flag.
 *
 * These tests pin the review's correctness fixes: no phantom turbo row when no
 * turbo is held, no phantom boost row when boostTime=0, off/n-a rows omitted,
 * and the boostBlocked empty-entry guard.
 */

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import VotingLogic = require('../../src/ts/services/VotingLogic');
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
const { buildChallenge: buildBaseChallenge } =
    require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
import type { Challenge, MemberBoost, MemberTurbo, RankingEntry } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

jest.mock('../../src/ts/settings');

const NOW = 1_000_000 - 100; // just before close_time below
const CLOSE = 1_000_000;

const mockSettings = (overrides = {}) => {
    const defaults = {
        autoSubmitSchedule: [{ count: 2, seconds: 900 }],
        turboTime: 7200,
        emergencySubmit: 300,
        boostTime: 3600,
        keyUnlockedBoostTime: 900,
        autoBoost: true,
        useTurbo: true,
        autoSubmit: true,
        boostImageIndex: 1,
        mustIncludeTags: [], // mirrors the schema default
    };
    const merged: Record<string, unknown> = { ...defaults, ...overrides };
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => merged[key]));
    // Tag lists go through the title-aware reader; the title-rule union is not
    // under test here, so resolve it off the same map.
    settings.getEffectiveTagSetting = invalid(jest.fn((key: string) => merged[key]));
};

const build = ({
    boost = { state: 'NONE' },
    turbo = { state: 'NONE' },
    entries = [{ id: 'e1' }],
    maxSubmits = 2,
}: { boost?: MemberBoost; turbo?: MemberTurbo; entries?: RankingEntry[]; maxSubmits?: number } = {}) =>
    buildBaseChallenge({
        id: '42',
        close_time: CLOSE,
        max_photo_submits: maxSubmits,
        member: { boost, turbo, ranking: { entries } },
    });

const actionsOf = (challenge: Challenge, now = NOW) =>
    VotingLogic.describeDeadlineActions(challenge, now).actions.map((a) => a.action);

describe('describeDeadlineActions — row gating', () => {
    beforeEach(() => jest.clearAllMocks());

    test('no phantom turbo row when no turbo is held', () => {
        mockSettings();
        // turboTime is a positive default (7200) even with no turbo — must be omitted.
        expect(actionsOf(build({ turbo: { state: 'NONE' } }))).not.toContain('turbo');
    });

    test('turbo row shown when a turbo is WON and useTurbo is on', () => {
        mockSettings({ useTurbo: true });
        expect(actionsOf(build({ turbo: { state: 'WON' } }))).toContain('turbo');
    });

    test('turbo row hidden when a turbo is WON but useTurbo is off', () => {
        mockSettings({ useTurbo: false });
        expect(actionsOf(build({ turbo: { state: 'WON' } }))).not.toContain('turbo');
    });

    test('no phantom boost row when boostTime=0 on a timer boost', () => {
        mockSettings({ boostTime: 0 });
        // AVAILABLE with a future timeout → timer branch; boostTime 0 = off.
        const challenge = build({ boost: { state: 'AVAILABLE', timeout: CLOSE - 1000 } });
        expect(actionsOf(challenge)).not.toContain('boost');
    });

    test('boost row shown when boostTime>0 on a timer boost', () => {
        mockSettings({ boostTime: 3600 });
        const challenge = build({ boost: { state: 'AVAILABLE', timeout: CLOSE - 1000 } });
        expect(actionsOf(challenge)).toContain('boost');
    });

    test('boost row shown for an available key-unlocked boost with autoBoost on', () => {
        mockSettings({ autoBoost: true, keyUnlockedBoostTime: 900 });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1' }] });
        expect(actionsOf(challenge)).toContain('boost');
    });

    test('boost row hidden when autoBoost is off', () => {
        mockSettings({ autoBoost: false });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' } });
        expect(actionsOf(challenge)).not.toContain('boost');
    });

    test('boost row suppressed when the boost is blocked (sole entry already turboed)', () => {
        mockSettings({ autoBoost: true, keyUnlockedBoostTime: 900 });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1', turbo: true }] });
        const result = VotingLogic.describeDeadlineActions(challenge, NOW);
        // The conflict owns this case — the timeline must not also show a boost row.
        expect(result.actions.map((a) => a.action)).not.toContain('boost');
        expect(result).toMatchObject({ boostBlocked: true, boostBlockedBy: 'flag', boostReleaseAt: null });
    });

    test('boost row suppressed when a pin for Turbo blocks the only entry', () => {
        mockSettings({ autoBoost: true, keyUnlockedBoostTime: 900, emergencySubmit: 0 });
        settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'LOCKED' } });
        const result = VotingLogic.describeDeadlineActions(challenge, NOW);
        expect(result.actions.map((a) => a.action)).not.toContain('boost');
        expect(result).toMatchObject({
            boostBlocked: true,
            turboBlocked: false,
            boostBlockedBy: 'pin',
            turboBlockedBy: null,
            boostReleaseAt: null,
        });
    });

    test('turbo row suppressed when a pin for Boost blocks the only entry', () => {
        mockSettings({ useTurbo: true, emergencySubmit: 0 });
        settings.getEntryPins.mockReturnValue({ boost: 'e1', turbo: null });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON' } });
        const result = VotingLogic.describeDeadlineActions(challenge, NOW);
        expect(result.actions.map((a) => a.action)).not.toContain('turbo');
        expect(result).toMatchObject({
            boostBlocked: false,
            turboBlocked: true,
            turboBlockedBy: 'pin',
            turboReleaseAt: null,
        });
    });

    test('a Turbo blocked by a boosted sole entry is blocked by a flag', () => {
        mockSettings({ useTurbo: true });
        const challenge = build({
            boost: { state: 'USED' },
            turbo: { state: 'WON' },
            entries: [{ id: 'e1', boosted: true }],
        });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW)).toMatchObject({
            turboBlocked: true,
            turboBlockedBy: 'flag',
            turboReleaseAt: null,
        });
    });

    describe('a block whose pin is due to give way keeps its row, due at the release', () => {
        const FAR = CLOSE - 5000;
        const rowOf = (challenge: Challenge, action: string) =>
            VotingLogic.describeDeadlineActions(challenge, FAR).actions.find((a) => a.action === action);

        test('a key-unlocked Boost blocked by a Turbo pin is due at the release, later than its own time', () => {
            mockSettings({ keyUnlockedBoostTime: 900, emergencySubmit: 300 });
            settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
            const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'LOCKED' } });
            expect(VotingLogic.describeDeadlineActions(challenge, FAR)).toMatchObject({
                boostBlocked: true,
                boostBlockedBy: 'pin',
                boostReleaseAt: CLOSE - 300,
            });
            expect(rowOf(challenge, 'boost')).toEqual({ action: 'boost', thresholdSec: 300, dueAt: CLOSE - 300 });
        });

        test('a timer Boost releases by its own timeout: due at min(close - release, its own threshold)', () => {
            mockSettings({ boostTime: 3600, emergencySubmit: 300 });
            settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
            const timeout = CLOSE - 2000;
            const challenge = build({ boost: { state: 'AVAILABLE', timeout }, turbo: { state: 'LOCKED' } });
            // Its own threshold is 2000 + 3600 s before close; the pin gives way 300 s before the timeout.
            expect(rowOf(challenge, 'boost')).toEqual({
                action: 'boost',
                thresholdSec: 2300,
                dueAt: timeout - 300,
            });
        });

        test('a Turbo blocked by a Boost pin is due at the release', () => {
            mockSettings({ turboTime: 7200, useTurbo: true, emergencySubmit: 300 });
            settings.getEntryPins.mockReturnValue({ boost: 'e1', turbo: null });
            const challenge = build({ boost: { state: 'LOCKED' }, turbo: { state: 'WON' } });
            expect(VotingLogic.describeDeadlineActions(challenge, FAR)).toMatchObject({
                turboBlocked: true,
                turboBlockedBy: 'pin',
                turboReleaseAt: CLOSE - 300,
            });
            expect(rowOf(challenge, 'turbo')).toEqual({ action: 'turbo', thresholdSec: 300, dueAt: CLOSE - 300 });
        });

        test('a held row is listed by its adjusted time: a Turbo held by a Boost pin follows an Auto-fill row now due earlier', () => {
            mockSettings({ turboTime: 7200, useTurbo: true, emergencySubmit: 300, autoSubmit: true });
            settings.getEntryPins.mockReturnValue({ boost: 'e1', turbo: null });
            const challenge = build({ boost: { state: 'LOCKED' }, turbo: { state: 'WON' } });
            // Turbo ordered first on its own 7200 s, then moved to the release 300 s before close.
            expect(VotingLogic.describeDeadlineActions(challenge, FAR).actions).toEqual([
                { action: 'autoSubmit', thresholdSec: 900, dueAt: CLOSE - 900 },
                { action: 'turbo', thresholdSec: 300, dueAt: CLOSE - 300 },
            ]);
        });

        test('a release earlier than the row’s own time leaves the row where it was', () => {
            mockSettings({ keyUnlockedBoostTime: 900, emergencySubmit: 3600 });
            settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
            const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'LOCKED' } });
            expect(rowOf(challenge, 'boost')).toEqual({ action: 'boost', thresholdSec: 900, dueAt: CLOSE - 900 });
        });

        test('a pin that never gives way (ready, or Emergency Submit off) hides the row', () => {
            mockSettings({ keyUnlockedBoostTime: 900, emergencySubmit: 300 });
            settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
            const ready = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON' } });
            expect(VotingLogic.describeDeadlineActions(ready, FAR)).toMatchObject({
                boostBlocked: true,
                boostReleaseAt: null,
            });
            expect(rowOf(ready, 'boost')).toBeUndefined();
            mockSettings({ keyUnlockedBoostTime: 900, emergencySubmit: 0 });
            settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
            const off = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'LOCKED' } });
            expect(rowOf(off, 'boost')).toBeUndefined();
        });
    });

    test('turbo is not blocked while a turbo is not held, or while an entry is free', () => {
        mockSettings({ emergencySubmit: 0 });
        settings.getEntryPins.mockReturnValue({ boost: 'e1', turbo: null });
        const notHeld = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'NONE' } });
        expect(VotingLogic.describeDeadlineActions(notHeld, NOW).turboBlocked).toBe(false);
        const spare = build({ turbo: { state: 'WON' }, entries: [{ id: 'e1' }, { id: 'e2' }] });
        expect(VotingLogic.describeDeadlineActions(spare, NOW).turboBlocked).toBe(false);
    });

    test('autoSubmit row hidden when autoSubmit is off', () => {
        mockSettings({ autoSubmit: false });
        expect(actionsOf(build())).not.toContain('autoSubmit');
    });

    test('emergency-fill row omitted when off (0)', () => {
        mockSettings({ emergencySubmit: 0 });
        expect(actionsOf(build())).not.toContain('emergencySubmit');
    });

    test('no phantom emergency-fill row when normal auto-fill already owns the challenge', () => {
        // The common configuration: auto-fill on, no must-include filter. The
        // runner returns 'skipped' before any network call, so the row would be
        // permanent noise on every challenge.
        mockSettings({ autoSubmit: true, mustIncludeTags: [] });
        expect(actionsOf(build())).not.toContain('emergencySubmit');
    });

    test('the must-include lookup receives the challenge OBJECT, not its id', () => {
        // The second argument drives the title-rule union in getEffectiveTagSetting,
        // so passing challengeId here would silently break title-rule-driven
        // mustIncludeTags for this row. Same contract the runner's own tests lock.
        mockSettings({ autoSubmit: false });
        const challenge = build();
        VotingLogic.describeDeadlineActions(challenge, NOW);
        expect(settings.getEffectiveTagSetting).toHaveBeenCalledWith('mustIncludeTags', challenge);
    });

    test('emergency-fill row shown when auto-fill is off (nothing else fills the slot)', () => {
        mockSettings({ autoSubmit: false });
        expect(actionsOf(build())).toContain('emergencySubmit');
    });

    test('emergency-fill row shown with auto-fill on when a must-include filter is set', () => {
        // The filter may leave the slot empty; only a network probe can tell, so
        // the advisory row stays.
        mockSettings({ autoSubmit: true, mustIncludeTags: ['sunset'] });
        expect(actionsOf(build())).toContain('emergencySubmit');
    });

    test('no phantom emergency-fill row when every slot is already full', () => {
        // 2/2 entries — getSlotsRemaining hits 0 and the runner skips. auto-fill
        // is off so the stand-down above cannot be what hides the row.
        mockSettings({ autoSubmit: false });
        const full = build({ entries: [{ id: 'e1' }, { id: 'e2' }], maxSubmits: 2 });
        expect(actionsOf(full)).not.toContain('emergencySubmit');
    });

    test('dueAt = close_time − thresholdSec', () => {
        mockSettings({ autoSubmit: true, autoSubmitSchedule: [{ count: 2, seconds: 900 }] });
        const { actions } = VotingLogic.describeDeadlineActions(build(), NOW);
        const autoSubmit = actions.find((a) => a.action === 'autoSubmit');
        expect(autoSubmit!.dueAt).toBe(CLOSE - autoSubmit!.thresholdSec);
    });
});

describe('describeDeadlineActions — Manual Only', () => {
    beforeEach(() => jest.clearAllMocks());

    test('lists no action at all, whatever else is set', () => {
        mockSettings({
            autoSubmit: true,
            emergencySubmit: 300,
            manualPhotosOnly: true,
            mustIncludeTags: ['sunset'],
            useTurbo: true,
        });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON' } });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).actions).toEqual([]);
        mockSettings({ autoSubmit: false, emergencySubmit: 300, manualPhotosOnly: true });
        expect(actionsOf(build())).toEqual([]);
    });

    test('with the switch off the same challenge keeps its rows', () => {
        mockSettings({ autoSubmit: true, emergencySubmit: 300, mustIncludeTags: ['sunset'], manualPhotosOnly: false });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON' } });
        expect(actionsOf(challenge)).toEqual(
            expect.arrayContaining(['autoSubmit', 'emergencySubmit', 'boost', 'turbo']),
        );
    });

    test('a flag block (every entry carries the other feature) is still reported', () => {
        mockSettings({ boostNewSubmit: true, boostNewSubmitOnConflict: true, manualPhotosOnly: true });
        const challenge = build({
            boost: { state: 'AVAILABLE_KEY' },
            entries: [{ id: 'e1', turbo: true }],
            maxSubmits: 2,
        });
        const result = VotingLogic.describeDeadlineActions(challenge, NOW);
        expect(result).toEqual(
            expect.objectContaining({ boostBlocked: true, boostBlockedBy: 'flag', boostReleaseAt: null, actions: [] }),
        );
    });

    test('the quit guard (and so the sleep boost) selects no boost on the challenge', () => {
        const guard = require('../../src/ts/windows/quitGuard') as typeof import('../../src/ts/windows/quitGuard');
        const challenge = build({ boost: { state: 'AVAILABLE', timeout: CLOSE - 10 } });
        guard.rememberChallenges([challenge], false);
        try {
            mockSettings({ manualPhotosOnly: false });
            expect(
                guard
                    .imminentBoostChallenges(NOW, VotingLogic.describeDeadlineActions, 3600)
                    .map((boost) => boost.challenge.id),
            ).toEqual(['42']);
            mockSettings({ manualPhotosOnly: true });
            expect(guard.imminentBoostChallenges(NOW, VotingLogic.describeDeadlineActions, 3600)).toEqual([]);
        } finally {
            guard.resetQuitGuard();
        }
    });

    test.each([[true], [false]])('a pin block with the switch %s', (manualOnly) => {
        const expected = !manualOnly;
        mockSettings({ manualPhotosOnly: manualOnly, autoBoost: true, useTurbo: true, emergencySubmit: 0 });
        settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
        const boost = VotingLogic.describeDeadlineActions(
            build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'LOCKED' } }),
            NOW,
        );
        expect(boost).toEqual(
            expect.objectContaining({
                boostBlocked: expected,
                boostBlockedBy: expected ? 'pin' : null,
                boostReleaseAt: null,
            }),
        );
        settings.getEntryPins.mockReturnValue({ boost: 'e1', turbo: null });
        const turbo = VotingLogic.describeDeadlineActions(
            build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON' } }),
            NOW,
        );
        expect(turbo).toEqual(
            expect.objectContaining({
                turboBlocked: expected,
                turboBlockedBy: expected ? 'pin' : null,
                turboReleaseAt: null,
            }),
        );
    });
});

describe('describeDeadlineActions — boostBlocked', () => {
    beforeEach(() => jest.clearAllMocks());

    test('false on a zero-entry challenge with an open boost window', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(false);
    });

    test('true when the sole entry already has Turbo and boost is available', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1', turbo: true }] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(true);
    });

    test('false when the boost window is closed', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'USED' }, entries: [{ id: 'e1', turbo: true }] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(false);
    });

    test('false when the sole entry is placeable (not turboed)', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1' }] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(false);
    });

    test('false when boostNewSubmit (always) will resolve the conflict via a free slot', () => {
        // Sole entry turboed, but a fresh photo can be submitted (2 slots, 1 used)
        // and boosted instead — so there is no conflict to warn about.
        mockSettings({ boostNewSubmit: true });
        const challenge = build({
            boost: { state: 'AVAILABLE_KEY' },
            entries: [{ id: 'e1', turbo: true }],
            maxSubmits: 2,
        });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(false);
    });

    test('false when boostNewSubmitOnConflict will resolve the conflict via a free slot', () => {
        mockSettings({ boostNewSubmitOnConflict: true });
        const challenge = build({
            boost: { state: 'AVAILABLE_KEY' },
            entries: [{ id: 'e1', turbo: true }],
            maxSubmits: 2,
        });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(false);
    });

    test('true when fill-new is on but there is no free slot to submit into', () => {
        // maxSubmits equals the entry count → fill-new cannot break the conflict,
        // so the warning must still show.
        mockSettings({ boostNewSubmitOnConflict: true });
        const challenge = build({
            boost: { state: 'AVAILABLE_KEY' },
            entries: [{ id: 'e1', turbo: true }],
            maxSubmits: 1,
        });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(true);
    });

    test('boost row shown (not suppressed) when fill-new will place the boost on a fresh entry', () => {
        mockSettings({ boostNewSubmitOnConflict: true });
        const challenge = build({
            boost: { state: 'AVAILABLE_KEY' },
            entries: [{ id: 'e1', turbo: true }],
            maxSubmits: 2,
        });
        expect(actionsOf(challenge)).toContain('boost');
    });
});

describe('resolveBoostFillNewMode', () => {
    beforeEach(() => jest.clearAllMocks());

    const conflicted = () => build({ entries: [{ id: 'e1', turbo: true }], maxSubmits: 2 });
    const placeable = () => build({ entries: [{ id: 'e1' }], maxSubmits: 2 });

    test("'always' when boostNewSubmit is on, regardless of conflict", () => {
        mockSettings({ boostNewSubmit: true });
        expect(VotingLogic.resolveBoostFillNewMode(placeable(), '42')).toBe('always');
        expect(VotingLogic.resolveBoostFillNewMode(conflicted(), '42')).toBe('always');
    });

    test("'no' while Manual Only is on, whichever fill-new option is set", () => {
        mockSettings({ boostNewSubmit: true, boostNewSubmitOnConflict: true, manualPhotosOnly: true });
        expect(VotingLogic.resolveBoostFillNewMode(placeable(), '42')).toBe('no');
        expect(VotingLogic.resolveBoostFillNewMode(conflicted(), '42')).toBe('no');
    });

    test("'conflict' when only boostNewSubmitOnConflict is on AND the sole entry is turboed", () => {
        mockSettings({ boostNewSubmitOnConflict: true });
        expect(VotingLogic.resolveBoostFillNewMode(conflicted(), '42')).toBe('conflict');
    });

    test("'no' when boostNewSubmitOnConflict is on but there is no conflict", () => {
        mockSettings({ boostNewSubmitOnConflict: true });
        expect(VotingLogic.resolveBoostFillNewMode(placeable(), '42')).toBe('no');
    });

    test("'no' when boostNewSubmitOnConflict is on but there are no entries (not a conflict)", () => {
        mockSettings({ boostNewSubmitOnConflict: true });
        const empty = build({ entries: [], maxSubmits: 2 });
        expect(VotingLogic.resolveBoostFillNewMode(empty, '42')).toBe('no');
    });

    test("'no' when neither fill-new setting is on", () => {
        mockSettings();
        expect(VotingLogic.resolveBoostFillNewMode(conflicted(), '42')).toBe('no');
    });

    test('boostNewSubmit takes precedence over on-conflict', () => {
        mockSettings({ boostNewSubmit: true, boostNewSubmitOnConflict: true });
        expect(VotingLogic.resolveBoostFillNewMode(placeable(), '42')).toBe('always');
    });
});
