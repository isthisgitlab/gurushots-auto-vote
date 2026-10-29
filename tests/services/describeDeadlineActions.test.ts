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
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import type { Challenge, MemberBoost, MemberTurbo, RankingEntry } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';
const { createMemoryEntryAgeLedger } = require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;
const { boostDeadline } =
    require('../../src/ts/voting/boostWindow') as typeof import('../../src/ts/voting/boostWindow');

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
    VotingLogic.describeDeadlineActions(challenge, now, null).actions.map((a) => a.action);

describe('describeDeadlineActions — row gating', () => {
    beforeEach(() => jest.clearAllMocks());

    test('no phantom turbo row when no turbo is held', () => {
        mockSettings();
        // turboTime is a positive default (7200) even with no turbo — must be omitted.
        expect(actionsOf(build({ turbo: { state: 'NONE' } }))).not.toContain('turbo');
    });

    test('turbo row shown when a turbo is WON and useTurbo is on', () => {
        mockSettings({ useTurbo: true });
        expect(actionsOf(build({ turbo: { state: 'WON', mode: 'classic' } }))).toContain('turbo');
    });

    test('turbo row hidden when a turbo is WON but useTurbo is off', () => {
        mockSettings({ useTurbo: false });
        expect(actionsOf(build({ turbo: { state: 'WON', mode: 'classic' } }))).not.toContain('turbo');
    });

    test.each([[undefined], ['snap'], ['classic']])('turbo row for a WON turbo of mode %p', (mode) => {
        mockSettings({ useTurbo: true });
        const listed = actionsOf(build({ turbo: { state: 'WON', mode } })).includes('turbo');
        // A mode-less WON is the mobile copy, whose WON can be false for a Snap game.
        expect(listed).toBe(mode !== undefined);
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
        const result = VotingLogic.describeDeadlineActions(challenge, NOW, null);
        // The conflict owns this case — the timeline must not also show a boost row.
        expect(result.actions.map((a) => a.action)).not.toContain('boost');
        expect(result).toMatchObject({ boostBlocked: true, boostBlockedBy: 'flag', boostReleaseAt: null });
    });

    test('boost row suppressed when a pin for Turbo blocks the only entry', () => {
        mockSettings({ autoBoost: true, keyUnlockedBoostTime: 900, emergencySubmit: 0 });
        settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'LOCKED' } });
        const result = VotingLogic.describeDeadlineActions(challenge, NOW, null);
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
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON', mode: 'classic' } });
        const result = VotingLogic.describeDeadlineActions(challenge, NOW, null);
        expect(result.actions.map((a) => a.action)).not.toContain('turbo');
        expect(result).toMatchObject({
            boostBlocked: false,
            turboBlocked: true,
            turboBlockedBy: 'pin',
            turboReleaseAt: null,
        });
    });

    test.each([[true], [false]])(
        'a pin on a photo that already carries the flag is inert, so the block is a flag block and stays (switch %s)',
        (manualOnly) => {
            // Regression lock: the only entry already has Turbo and is also pinned for Turbo. The pin is not live
            // (a pin is inert once any entry carries its own feature’s flag), so Manual Only has no pin block to lift.
            mockSettings({ manualPhotosOnly: manualOnly, emergencySubmit: 300 });
            settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
            const boost = VotingLogic.describeDeadlineActions(
                build({
                    boost: { state: 'AVAILABLE_KEY' },
                    turbo: { state: 'LOCKED' },
                    entries: [{ id: 'e1', turbo: true }],
                }),
                NOW,
                null,
            );
            expect(boost).toEqual(
                expect.objectContaining({ boostBlocked: true, boostBlockedBy: 'flag', boostReleaseAt: null }),
            );
            settings.getEntryPins.mockReturnValue({ boost: 'e1', turbo: null });
            const turbo = VotingLogic.describeDeadlineActions(
                build({
                    boost: { state: 'AVAILABLE_KEY' },
                    turbo: { state: 'WON', mode: 'classic' },
                    entries: [{ id: 'e1', boosted: true }],
                }),
                NOW,
                null,
            );
            expect(turbo).toEqual(
                expect.objectContaining({ turboBlocked: true, turboBlockedBy: 'flag', turboReleaseAt: null }),
            );
        },
    );

    test('a Turbo blocked by a boosted sole entry is blocked by a flag', () => {
        mockSettings({ useTurbo: true });
        const challenge = build({
            boost: { state: 'USED' },
            turbo: { state: 'WON', mode: 'classic' },
            entries: [{ id: 'e1', boosted: true }],
        });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW, null)).toMatchObject({
            turboBlocked: true,
            turboBlockedBy: 'flag',
            turboReleaseAt: null,
        });
    });

    describe('a block whose pin is due to give way keeps its row, due at the release', () => {
        const FAR = CLOSE - 5000;
        const rowOf = (challenge: Challenge, action: string) =>
            VotingLogic.describeDeadlineActions(challenge, FAR, null).actions.find((a) => a.action === action);

        test('a key-unlocked Boost blocked by a Turbo pin is due at the release, later than its own time', () => {
            mockSettings({ keyUnlockedBoostTime: 900, emergencySubmit: 300 });
            settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
            const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'LOCKED' } });
            expect(VotingLogic.describeDeadlineActions(challenge, FAR, null)).toMatchObject({
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
            const challenge = build({ boost: { state: 'LOCKED' }, turbo: { state: 'WON', mode: 'classic' } });
            expect(VotingLogic.describeDeadlineActions(challenge, FAR, null)).toMatchObject({
                turboBlocked: true,
                turboBlockedBy: 'pin',
                turboReleaseAt: CLOSE - 300,
            });
            expect(rowOf(challenge, 'turbo')).toEqual({ action: 'turbo', thresholdSec: 300, dueAt: CLOSE - 300 });
        });

        test('a held row is listed by its adjusted time: a Turbo held by a Boost pin follows an Auto-fill row now due earlier', () => {
            mockSettings({ turboTime: 7200, useTurbo: true, emergencySubmit: 300, autoSubmit: true });
            settings.getEntryPins.mockReturnValue({ boost: 'e1', turbo: null });
            const challenge = build({ boost: { state: 'LOCKED' }, turbo: { state: 'WON', mode: 'classic' } });
            // Turbo ordered first on its own 7200 s, then moved to the release 300 s before close.
            expect(VotingLogic.describeDeadlineActions(challenge, FAR, null).actions).toEqual([
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
            const ready = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON', mode: 'classic' } });
            expect(VotingLogic.describeDeadlineActions(ready, FAR, null)).toMatchObject({
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

    describe('a pin waiting for its own photo (the pin is absolute)', () => {
        const FAR = CLOSE - 5000;
        const rowsOf = (challenge: Challenge) => VotingLogic.describeDeadlineActions(challenge, FAR, null).actions;
        const boostRow = (challenge: Challenge) => rowsOf(challenge).find((a) => a.action === 'boost');
        const turboRow = (challenge: Challenge) => rowsOf(challenge).find((a) => a.action === 'turbo');

        test('a gone pin with a fill ahead moves the boost row past the fill instant', () => {
            mockSettings({ keyUnlockedBoostTime: 1800 });
            settings.getEntryPins.mockReturnValue({ boost: 'zzz', turbo: null });
            const challenge = build({ boost: { state: 'AVAILABLE_KEY' } });
            // The fill boundary (close − 900) is later than the boost's own due (close − 1800).
            expect(boostRow(challenge)).toEqual({ action: 'boost', thresholdSec: 900, dueAt: CLOSE - 900 });
        });

        test('the fill instant yields to a later blocking-pin release: the later of the two wins', () => {
            mockSettings({ keyUnlockedBoostTime: 1800 });
            // The Boost pin is gone AND the Turbo pin blocks the boost, giving way 300 s before close.
            settings.getEntryPins.mockReturnValue({ boost: 'zzz', turbo: 'e1' });
            const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'LOCKED' } });
            expect(VotingLogic.describeDeadlineActions(challenge, FAR, null)).toMatchObject({
                boostBlocked: true,
                boostReleaseAt: CLOSE - 300,
            });
            expect(boostRow(challenge)).toEqual({ action: 'boost', thresholdSec: 300, dueAt: CLOSE - 300 });
        });

        test('a gone turbo pin moves the turbo row past the fill instant the same way', () => {
            mockSettings({ turboTime: 7200 });
            settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'zzz' });
            const challenge = build({ turbo: { state: 'WON', mode: 'classic' } });
            expect(turboRow(challenge)).toEqual({ action: 'turbo', thresholdSec: 900, dueAt: CLOSE - 900 });
        });

        test('a conflict pin hides its row even when fill-new would resolve a flag block', () => {
            mockSettings({ boostNewSubmit: true });
            settings.getEntryPins.mockReturnValue({ boost: 'e1', turbo: null });
            // The sole entry is turboed AND pinned for Boost: fill-new would place the boost on a
            // fresh photo, but the absolute pin means the automatic boost never fires.
            const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1', turbo: true }] });
            expect(VotingLogic.describeDeadlineActions(challenge, FAR, null).boostBlocked).toBe(false);
            expect(rowsOf(challenge).map((a) => a.action)).not.toContain('boost');
        });

        test('a gone pin with no fill ahead hides its row: autoSubmit off, or no threshold ahead', () => {
            mockSettings({ autoSubmit: false, keyUnlockedBoostTime: 1800 });
            settings.getEntryPins.mockReturnValue({ boost: 'zzz', turbo: null });
            expect(rowsOf(build({ boost: { state: 'AVAILABLE_KEY' } })).map((a) => a.action)).not.toContain('boost');

            mockSettings({ autoSubmitSchedule: [], keyUnlockedBoostTime: 1800 });
            settings.getEntryPins.mockReturnValue({ boost: 'zzz', turbo: null });
            expect(rowsOf(build({ boost: { state: 'AVAILABLE_KEY' } })).map((a) => a.action)).not.toContain('boost');
        });

        test('a gone turbo pin leaves the emergency fill row at its own threshold', () => {
            // The emergency row survives stand-down only under a must-include filter the fill
            // cannot meet; its runner fires at its own window, so a pin must never move it.
            mockSettings({ autoSubmitSchedule: [{ count: 2, seconds: 120 }], mustIncludeTags: ['nope'] });
            settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'zzz' });
            const challenge = build({ turbo: { state: 'WON', mode: 'classic' } });
            const emergency = rowsOf(challenge).find((a) => a.action === 'emergencySubmit');
            // Not moved to the fill boundary (close − 120) by the waiting turbo pin.
            expect(emergency).toEqual({ action: 'emergencySubmit', thresholdSec: 300, dueAt: CLOSE - 300 });
        });

        test('a moved boost row never points past the boost deadline: it shows the last chance instead', () => {
            mockSettings({ autoSubmitSchedule: [{ count: 2, seconds: 300 }], boostTime: 1800 });
            settings.getEntryPins.mockReturnValue({ boost: 'zzz', turbo: null });
            // Timer boost dies 600 s before close; the fill boundary (close − 300) lands after
            // its death, so the row clamps to the deadline's last poll (close − 660).
            const challenge = build({ boost: { state: 'AVAILABLE', timeout: CLOSE - 600 } });
            expect(boostRow(challenge)).toEqual({ action: 'boost', thresholdSec: 660, dueAt: CLOSE - 660 });
        });
    });

    test('a WON turbo of unknown mode is not held, so it blocks nothing and holds no pin', () => {
        const far = CLOSE - 5000;
        mockSettings({ keyUnlockedBoostTime: 900, emergencySubmit: 300 });
        settings.getEntryPins.mockReturnValue({ boost: 'e1', turbo: null });
        const modeless = build({ boost: { state: 'LOCKED' }, turbo: { state: 'WON' } });
        expect(VotingLogic.describeDeadlineActions(modeless, far, null).turboBlocked).toBe(false);
        // The Turbo pin is not ready without a known mode, so it gives way inside Emergency Submit, as for a Turbo not won.
        settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
        const pinned = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON' } });
        const { boostBlocked, boostReleaseAt } = VotingLogic.describeDeadlineActions(pinned, far, null);
        expect(boostBlocked).toBe(true);
        expect(boostReleaseAt).not.toBeNull();
    });

    test('turbo is not blocked while a turbo is not held, or while an entry is free', () => {
        mockSettings({ emergencySubmit: 0 });
        settings.getEntryPins.mockReturnValue({ boost: 'e1', turbo: null });
        const notHeld = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'NONE' } });
        expect(VotingLogic.describeDeadlineActions(notHeld, NOW, null).turboBlocked).toBe(false);
        const spare = build({ turbo: { state: 'WON', mode: 'classic' }, entries: [{ id: 'e1' }, { id: 'e2' }] });
        expect(VotingLogic.describeDeadlineActions(spare, NOW, null).turboBlocked).toBe(false);
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
        VotingLogic.describeDeadlineActions(challenge, NOW, null);
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
        const { actions } = VotingLogic.describeDeadlineActions(build(), NOW, null);
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
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON', mode: 'classic' } });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW, null).actions).toEqual([]);
        mockSettings({ autoSubmit: false, emergencySubmit: 300, manualPhotosOnly: true });
        expect(actionsOf(build())).toEqual([]);
    });

    test('with the switch off the same challenge keeps its rows', () => {
        mockSettings({ autoSubmit: true, emergencySubmit: 300, mustIncludeTags: ['sunset'], manualPhotosOnly: false });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON', mode: 'classic' } });
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
        const result = VotingLogic.describeDeadlineActions(challenge, NOW, null);
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
                    .imminentBoostChallenges(NOW, VotingLogic.describeDeadlineActions, 3600, null)
                    .map((boost) => boost.challenge.id),
            ).toEqual(['42']);
            mockSettings({ manualPhotosOnly: true });
            expect(guard.imminentBoostChallenges(NOW, VotingLogic.describeDeadlineActions, 3600, null)).toEqual([]);
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
            null,
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
            build({ boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON', mode: 'classic' } }),
            NOW,
            null,
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
        expect(VotingLogic.describeDeadlineActions(challenge, NOW, null).boostBlocked).toBe(false);
    });

    test('true when the sole entry already has Turbo and boost is available', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1', turbo: true }] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW, null).boostBlocked).toBe(true);
    });

    test('false when the boost window is closed', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'USED' }, entries: [{ id: 'e1', turbo: true }] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW, null).boostBlocked).toBe(false);
    });

    test('false when the sole entry is placeable (not turboed)', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1' }] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW, null).boostBlocked).toBe(false);
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
        expect(VotingLogic.describeDeadlineActions(challenge, NOW, null).boostBlocked).toBe(false);
    });

    test('false when boostNewSubmitOnConflict will resolve the conflict via a free slot', () => {
        mockSettings({ boostNewSubmitOnConflict: true });
        const challenge = build({
            boost: { state: 'AVAILABLE_KEY' },
            entries: [{ id: 'e1', turbo: true }],
            maxSubmits: 2,
        });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW, null).boostBlocked).toBe(false);
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
        expect(VotingLogic.describeDeadlineActions(challenge, NOW, null).boostBlocked).toBe(true);
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

describe('describeDeadlineActions — the Boost-pinned submit', () => {
    const FAR = CLOSE - 5000;
    // Eligible path: the opt-in on, the gone pin 'zzz' among the Chosen Photos, a slot free,
    // and the ledger below carries no latch.
    const eligible = (over = {}, boost: MemberBoost = { state: 'AVAILABLE_KEY' }) => {
        mockSettings({
            boostPinnedSubmit: true,
            chosenPhotos: ['zzz'],
            keyUnlockedBoostTime: 1800,
            autoBoost: true,
            emergencySubmit: 0,
            ...over,
        });
        settings.getEntryPins.mockReturnValue({ boost: 'zzz', turbo: null });
        return build({ boost });
    };

    beforeEach(() => jest.clearAllMocks());

    test('an eligible gone pin keeps the boost row at its own time and reports boostPinSubmits', () => {
        const result = VotingLogic.describeDeadlineActions(eligible(), FAR, createMemoryEntryAgeLedger());
        expect(result.boostPinSubmits).toBe(true);
        // Without the path the gone pin would move the row to the fill instant (close − 900).
        expect(result.actions.find((a) => a.action === 'boost')).toEqual({
            action: 'boost',
            thresholdSec: 1800,
            dueAt: CLOSE - 1800,
        });
    });

    test('an eligible gone pin keeps its row even when no fill will run (autoSubmit off)', () => {
        const challenge = eligible({ autoSubmit: false });
        const result = VotingLogic.describeDeadlineActions(challenge, FAR, createMemoryEntryAgeLedger());
        expect(result.actions.find((a) => a.action === 'boost')).toEqual({
            action: 'boost',
            thresholdSec: 1800,
            dueAt: CLOSE - 1800,
        });
    });

    test('the flag is false while Auto Boost is off: eligible, but no boost row to follow', () => {
        const result = VotingLogic.describeDeadlineActions(
            eligible({ autoBoost: false }),
            FAR,
            createMemoryEntryAgeLedger(),
        );
        expect(result.actions.map((a) => a.action)).not.toContain('boost');
        expect(result.boostPinSubmits).toBe(false);
    });

    test('the flag is false with Boost Time 0 on a timer Boost: the row stays off', () => {
        const result = VotingLogic.describeDeadlineActions(
            eligible({ boostTime: 0 }, { state: 'AVAILABLE', timeout: CLOSE - 600 }),
            FAR,
            createMemoryEntryAgeLedger(),
        );
        expect(result.actions.map((a) => a.action)).not.toContain('boost');
        expect(result.boostPinSubmits).toBe(false);
    });

    test('the flag is false when no Boost is available', () => {
        const result = VotingLogic.describeDeadlineActions(eligible({}, {}), FAR, createMemoryEntryAgeLedger());
        expect(result.actions.map((a) => a.action)).not.toContain('boost');
        expect(result.boostPinSubmits).toBe(false);
    });

    test('every entry has Turbo and a Turbo pin: the row is shown and the boost is not blocked', () => {
        mockSettings({
            boostPinnedSubmit: true,
            chosenPhotos: ['zzz'],
            keyUnlockedBoostTime: 1800,
            autoBoost: true,
            emergencySubmit: 0,
        });
        settings.getEntryPins.mockReturnValue({ boost: 'zzz', turbo: 'e1' });
        const challenge = build({
            boost: { state: 'AVAILABLE_KEY' },
            turbo: { state: 'LOCKED' },
            entries: [{ id: 'e1', turbo: true }],
        });
        const result = VotingLogic.describeDeadlineActions(challenge, FAR, createMemoryEntryAgeLedger());
        expect(result).toMatchObject({
            boostPinSubmits: true,
            boostBlocked: false,
            boostBlockedBy: null,
            boostReleaseAt: null,
        });
        expect(result.actions.map((a) => a.action)).toContain('boost');
    });

    test('isBoostBlocked is false while eligible with a Turbo pin everywhere, true again once latched', () => {
        mockSettings({
            boostPinnedSubmit: true,
            chosenPhotos: ['zzz'],
            keyUnlockedBoostTime: 1800,
            autoBoost: true,
            emergencySubmit: 0,
        });
        settings.getEntryPins.mockReturnValue({ boost: 'zzz', turbo: 'e1' });
        const challenge = build({
            boost: { state: 'AVAILABLE_KEY' },
            turbo: { state: 'LOCKED' },
            entries: [{ id: 'e1', turbo: true }],
        });
        const ledger = createMemoryEntryAgeLedger();
        expect(VotingLogic.isBoostBlocked(challenge, '42', FAR, ledger)).toBe(false);
        ledger.markPinSubmitFailed(challenge, 'zzz', boostDeadline(challenge), FAR);
        expect(VotingLogic.isBoostBlocked(challenge, '42', FAR, ledger)).toBe(true);
    });

    test('a latch set moves the row and clamps it to the last chance, as today, and clears the flag', () => {
        const ledger = createMemoryEntryAgeLedger();
        const challenge = eligible(
            { autoSubmitSchedule: [{ count: 2, seconds: 300 }], boostTime: 1800 },
            { state: 'AVAILABLE', timeout: CLOSE - 600 },
        );
        ledger.markPinSubmitFailed(challenge, 'zzz', boostDeadline(challenge), FAR);
        // The same clamped moved row the pre-Boost-pinned-submit test pins (close − 660).
        expect(
            VotingLogic.describeDeadlineActions(challenge, FAR, ledger).actions.find((a) => a.action === 'boost'),
        ).toEqual({
            action: 'boost',
            thresholdSec: 660,
            dueAt: CLOSE - 660,
        });
        expect(VotingLogic.describeDeadlineActions(challenge, FAR, ledger).boostPinSubmits).toBe(false);
    });

    test('today’s hidden row when every slot is taken: no free slot, and a full challenge has no fill ahead', () => {
        mockSettings({
            boostPinnedSubmit: true,
            chosenPhotos: ['zzz'],
            keyUnlockedBoostTime: 1800,
            autoBoost: true,
            emergencySubmit: 0,
        });
        settings.getEntryPins.mockReturnValue({ boost: 'zzz', turbo: null });
        // Two entries at max 2: no free slot for the pinned submit — and the schedule row
        // ({count: 2}) is already satisfied, so no fill instant exists to wait at and the
        // gone pin hides the row, exactly as before the Boost-pinned submit.
        const full = build({
            boost: { state: 'AVAILABLE_KEY' },
            entries: [{ id: 'e1' }, { id: 'e2' }],
            maxSubmits: 2,
        });
        const result = VotingLogic.describeDeadlineActions(full, FAR, createMemoryEntryAgeLedger());
        expect(result.boostPinSubmits).toBe(false);
        expect(result.actions.map((a) => a.action)).not.toContain('boost');
    });

    test('today’s moved row when the setting is off', () => {
        const challenge = eligible({ boostPinnedSubmit: false });
        const result = VotingLogic.describeDeadlineActions(challenge, FAR, createMemoryEntryAgeLedger());
        expect(result.boostPinSubmits).toBe(false);
        expect(result.actions.find((a) => a.action === 'boost')).toEqual({
            action: 'boost',
            thresholdSec: 900,
            dueAt: CLOSE - 900,
        });
    });
});
