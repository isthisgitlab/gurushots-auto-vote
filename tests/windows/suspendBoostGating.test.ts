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
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
import type { MemberBoost, RankingEntry } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

jest.mock('../../src/ts/settings');

const CLOSE = 1_000_000;
const NOW = CLOSE - 3600;

// Same settings stand-in the describeDeadlineActions suite uses.
const mockSettings = (overrides = {}) => {
    const defaults = {
        autoFillSchedule: [{ count: 2, seconds: 900 }],
        turboTime: 7200,
        emergencyFill: 300,
        boostTime: 300,
        keyUnlockedBoostTime: 900,
        autoBoost: true,
        useTurbo: true,
        autoFill: true,
        boostImageIndex: 1,
        mustIncludeTags: [],
    };
    const merged: Record<string, unknown> = { ...defaults, ...overrides };
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => merged[key]));
    settings.getEffectiveTagSetting = invalid(jest.fn((key: string) => merged[key]));
};

// Expires 30 min from now; boostTime 300 makes it due 25 min from now — inside the 30 min horizon.
const timedBoost: MemberBoost = { state: 'AVAILABLE', timeout: NOW + 1800 };

const challenge = (id: number, entries: RankingEntry[] = [{ id: 'e1' }], boost: MemberBoost = timedBoost) =>
    buildChallenge({ id, close_time: CLOSE, max_photo_submits: 2, member: { boost, ranking: { entries } } });

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
});
