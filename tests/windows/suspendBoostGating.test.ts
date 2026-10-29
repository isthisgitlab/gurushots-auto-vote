/**
 * Which challenges a device sleep boosts: imminentBoostChallenges over the REAL
 * VotingLogic.describeDeadlineActions (the other quitGuard / suspendBoost suites
 * stub it), so the boost gating — autoBoost, Boost Time 0 = off, the Turbo
 * conflict — is the production rule, not a restatement of it.
 */

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import VotingLogic = require('../../src/ts/services/VotingLogic');
import quitGuard = require('../../src/ts/windows/quitGuard');
import logger = require('../../src/ts/logger');
import type * as boostModule from '../../src/ts/services/votingOrchestrator/suspendBoostRunner';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
import type { MemberBoost, RankingEntry } from '../../src/ts/types/gurushots';
import type { VotingPassApi } from '../../src/ts/types/votingPass';
import { invalid } from '../helpers/invalid';
const { runSuspendBoost } =
    require('../../src/ts/services/votingOrchestrator/suspendBoostRunner') as typeof boostModule;

jest.mock('../../src/ts/settings');

const CLOSE = 1_000_000;
const NOW = CLOSE - 3600;

// Same settings stand-in the describeDeadlineActions suite uses.
const mockSettings = (overrides = {}) => {
    const defaults = {
        autoSubmitSchedule: [{ count: 2, seconds: 900 }],
        turboTime: 7200,
        emergencySubmit: 300,
        boostTime: 300,
        keyUnlockedBoostTime: 900,
        autoBoost: true,
        useTurbo: true,
        autoSubmit: true,
        boostImageIndex: 1,
        mustIncludeTags: [],
    };
    const merged: Record<string, unknown> = { ...defaults, ...overrides };
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => merged[key]));
    settings.getEffectiveTagSetting = invalid(jest.fn((key: string) => merged[key]));
};

// Expires 30 min from now; boostTime 300 makes it due 25 min from now — inside the 30 min horizon.
const timedBoost: MemberBoost = { state: 'AVAILABLE', timeout: NOW + 1800 };

const challenge = (id: number, entries: RankingEntry[] = [{ id: 'e1' }], boost: MemberBoost = timedBoost) =>
    buildChallenge({ id, close_time: CLOSE, max_photo_submits: 2, member: { boost, ranking: { entries } } });

// Key-unlocked boosts are due keyUnlockedBoostTime (900 s) before the close, so a close
// 30 min out puts the due instant 15 min away.
const keyChallenge = (id: number) =>
    buildChallenge({
        id,
        close_time: NOW + 1800,
        max_photo_submits: 2,
        member: { boost: { state: 'AVAILABLE_KEY' }, ranking: { entries: [{ id: 'e1' }] } },
    });

const selectedIds = () =>
    quitGuard
        .imminentBoostChallenges(NOW, VotingLogic.describeDeadlineActions, quitGuard.SUSPEND_BOOST_HORIZON_SEC)
        .map(({ challenge: c }) => c.id);

beforeEach(() => {
    jest.clearAllMocks();
    quitGuard.resetQuitGuard();
});

describe('imminentBoostChallenges with the real describeDeadlineActions', () => {
    test('a normal due boost is selected', () => {
        mockSettings();
        quitGuard.rememberChallenges([challenge(1)], false);
        expect(selectedIds()).toEqual([1]);
    });

    test('autoBoost off is not selected', () => {
        mockSettings({ autoBoost: false });
        quitGuard.rememberChallenges([challenge(1)], false);
        expect(selectedIds()).toEqual([]);
    });

    test('Boost Time 0 (off) is not selected', () => {
        mockSettings({ boostTime: 0 });
        quitGuard.rememberChallenges([challenge(1)], false);
        expect(selectedIds()).toEqual([]);
    });

    test('a Turbo conflict (only entry already turboed, nowhere to place the boost) is not selected', () => {
        mockSettings();
        quitGuard.rememberChallenges(
            [
                challenge(1, [
                    { id: 'e1', turbo: true },
                    { id: 'e2', turbo: true },
                ]),
            ],
            false,
        );
        expect(selectedIds()).toEqual([]);
    });

    test('a boost blocked by the photo pinned for Turbo is not selected, and the sleep boost skips it', async () => {
        mockSettings({ emergencySubmit: 0 });
        settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
        const blocked = challenge(1);
        quitGuard.rememberChallenges([blocked], false);
        expect(selectedIds()).toEqual([]);

        jest.mocked(logger.withCategory).mockImplementation(() => invalid({ info: jest.fn(), infoT: jest.fn() }));
        const api = { applyBoost: jest.fn(), applyBoostToEntry: jest.fn() };
        const outcome = await runSuspendBoost({
            challenge: blocked,
            token: 'tok',
            now: NOW,
            api: invalid<VotingPassApi>(api),
            fillDeps: invalid(null),
            entryAges: null,
        });
        expect(outcome).toBe('skipped');
        expect(api.applyBoost).not.toHaveBeenCalled();
    });

    test('a boost blocked by a Turbo pin that gives way inside the horizon is selected, and the sleep boost lands on that photo', async () => {
        // Closes in 30 min; Emergency Submit 300 s: the pin gives way 25 min from now.
        mockSettings({ emergencySubmit: 300 });
        settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
        const pinned = buildChallenge({
            id: 7,
            close_time: NOW + 1800,
            max_photo_submits: 2,
            member: {
                boost: { state: 'AVAILABLE_KEY' },
                turbo: { state: 'LOCKED' },
                ranking: { entries: [{ id: 'e1' }] },
            },
        });
        quitGuard.rememberChallenges([pinned], false);
        expect(selectedIds()).toEqual([7]);
        expect(
            quitGuard
                .imminentBoostChallenges(NOW, VotingLogic.describeDeadlineActions, quitGuard.SUSPEND_BOOST_HORIZON_SEC)
                .map(({ dueAt }) => dueAt),
        ).toEqual([NOW + 1500]);

        jest.mocked(logger.withCategory).mockImplementation(() =>
            invalid({ info: jest.fn(), infoT: jest.fn(), startOperation: jest.fn(), endOperation: jest.fn() }),
        );
        const api = { applyBoost: jest.fn(), applyBoostToEntry: jest.fn(async () => ({ success: true })) };
        const outcome = await runSuspendBoost({
            challenge: pinned,
            token: 'tok',
            now: NOW,
            api: invalid<VotingPassApi>(api),
            fillDeps: invalid(null),
            entryAges: null,
        });
        expect(outcome).toBe('applied');
        // applyBoost would pick at the clock, where the pin still blocks; the entry is named instead.
        expect(api.applyBoost).not.toHaveBeenCalled();
        expect(api.applyBoostToEntry).toHaveBeenCalledWith('7', 'e1', 'tok');
    });

    test('a block with no release inside the horizon (Emergency Submit off) is neither selected nor boosted', async () => {
        mockSettings({ emergencySubmit: 0 });
        settings.getEntryPins.mockReturnValue({ boost: null, turbo: 'e1' });
        const pinned = keyChallenge(8);
        pinned.member!.turbo = { state: 'LOCKED' };
        quitGuard.rememberChallenges([pinned], false);
        expect(selectedIds()).toEqual([]);
    });

    test('only the selectable challenge is picked out of a mixed list', () => {
        mockSettings();
        quitGuard.rememberChallenges(
            [
                challenge(1),
                challenge(2, [
                    { id: 'e1', turbo: true },
                    { id: 'e2', turbo: true },
                ]),
            ],
            false,
        );
        expect(selectedIds()).toEqual([1]);
    });

    test('a key-unlocked boost is selected inside 30 min of its key-unlocked due time', () => {
        mockSettings();
        quitGuard.rememberChallenges([keyChallenge(1)], false);
        expect(selectedIds()).toEqual([1]);
    });

    test('a key-unlocked boost is not selected with keyUnlockedBoostTime 0 (off)', () => {
        mockSettings({ keyUnlockedBoostTime: 0 });
        quitGuard.rememberChallenges([keyChallenge(1)], false);
        expect(selectedIds()).toEqual([]);
    });

    test('a fill-new conflict row (only entry turboed, free slot) is selected, and the sleep boost skips it with the Turbo reason', async () => {
        mockSettings({ boostNewSubmitOnConflict: true });
        const conflicted = challenge(1, [{ id: 'e1', turbo: true }]);
        quitGuard.rememberChallenges([conflicted], false);
        expect(selectedIds()).toEqual([1]);

        const info = jest.fn<void, unknown[]>();
        // infoT renders through the real catalog onto the same fn, so the
        // assertion below keeps reading today's rendered line.
        const infoT = jest.fn((key: string, params: unknown[], data: unknown) => {
            const { renderLogTemplate } = require('../helpers/logTemplate') as typeof import('../helpers/logTemplate');
            info(renderLogTemplate(key, params), data);
        });
        jest.mocked(logger.withCategory).mockImplementation(() => invalid({ info, infoT }));
        const api = { applyBoost: jest.fn(), applyBoostToEntry: jest.fn() };
        const outcome = await runSuspendBoost({
            challenge: conflicted,
            token: 'tok',
            now: NOW,
            api: invalid<VotingPassApi>(api),
            fillDeps: invalid(null),
            entryAges: null,
        });
        expect(outcome).toBe('skipped');
        expect(api.applyBoost).not.toHaveBeenCalled();
        expect(api.applyBoostToEntry).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith(
            '[Challenge 1: Challenge] every entry has Turbo or is pinned for Turbo, and a new photo cannot be submitted before sleep — boost skipped',
            null,
        );
    });
});
