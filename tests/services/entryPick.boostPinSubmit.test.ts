/**
 * The Boost-pinned submit's eligibility check: canSubmitBoostPin answers the
 * pinned photo's id only when the opt-in is on, Manual Only is off, the Boost
 * pin is gone from the challenge, the photo is one of the Chosen Photos, a slot
 * is free, and no failure latch sits on this challenge, pin and Boost window.
 */

jest.mock('../../src/ts/settings');

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as VotingLogicModule from '../../src/ts/services/VotingLogic';
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type { Challenge, RankingEntry } from '../../src/ts/types/gurushots';
import type { EntryPins } from '../../src/ts/types/settings';
import { invalid } from '../helpers/invalid';
const VotingLogic = require('../../src/ts/services/VotingLogic') as typeof VotingLogicModule;
const { createMemoryEntryAgeLedger } = require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;

const NOW = 1_800_000_000;
const CLOSE = NOW + 3600;

const setup = (pins: Partial<EntryPins> = {}, values: Record<string, unknown> = {}) => {
    const merged: Record<string, unknown> = {
        boostPinnedSubmit: true,
        manualPhotosOnly: false,
        chosenPhotos: ['pin1'],
        chosenPhotosOnly: false,
        chosenPhotosInOrder: false,
        emergencySubmit: 0,
        ...values,
    };
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null, ...pins });
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => merged[key]));
    settings.getEffectiveTagSetting = invalid(jest.fn((key: string) => merged[key]));
};

const build = (entries: RankingEntry[]): Challenge =>
    buildChallenge({
        id: '42',
        close_time: CLOSE,
        max_photo_submits: entries.length + 2,
        member: { ranking: { entries } },
    });

const A = { id: 'aaa' };

beforeEach(() => jest.clearAllMocks());

describe('canSubmitBoostPin', () => {
    test('the pinned id when everything holds', () => {
        setup({ boost: 'pin1' });
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', createMemoryEntryAgeLedger())).toBe('pin1');
    });

    test('null while the opt-in is off', () => {
        setup({ boost: 'pin1' }, { boostPinnedSubmit: false });
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', createMemoryEntryAgeLedger())).toBeNull();
    });

    test('null under Manual Only', () => {
        setup({ boost: 'pin1' }, { manualPhotosOnly: true });
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', createMemoryEntryAgeLedger())).toBeNull();
    });

    test('null unless the Boost pin is gone: no pin, a live pin, and a conflicting pin all wait', () => {
        const ledger = createMemoryEntryAgeLedger();
        setup({}, { boostPinnedSubmit: true });
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', ledger)).toBeNull();
        setup({ boost: 'aaa' });
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', ledger)).toBeNull();
        setup({ boost: 'aaa' });
        expect(VotingLogic.canSubmitBoostPin(build([{ id: 'aaa', turbo: true }]), '42', ledger)).toBeNull();
    });

    test('null when the gone pin carries no id (a malformed pin)', () => {
        setup({ boost: '' });
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', createMemoryEntryAgeLedger())).toBeNull();
    });

    test('null when the pinned photo is not among the Chosen Photos', () => {
        setup({ boost: 'pin1' }, { chosenPhotos: ['other'] });
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', createMemoryEntryAgeLedger())).toBeNull();
    });

    test('null when every slot is taken', () => {
        setup({ boost: 'pin1' });
        const challenge = buildChallenge({
            id: '42',
            close_time: CLOSE,
            max_photo_submits: 2,
            member: { ranking: { entries: [A, { id: 'bbb' }] } },
        });
        expect(VotingLogic.canSubmitBoostPin(challenge, '42', createMemoryEntryAgeLedger())).toBeNull();
    });

    test('null without a ledger: the latch cannot be honoured, so the feature stays off', () => {
        setup({ boost: 'pin1' });
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', null)).toBeNull();
    });

    test('null while the failure latch names this pin and Boost window; a new pin or window may try again', () => {
        setup({ boost: 'pin1' });
        const ledger = createMemoryEntryAgeLedger();
        ledger.markPinSubmitFailed(build([A]), 'pin1', CLOSE);
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', ledger)).toBeNull();
        // A different pin is a new key.
        ledger.markPinSubmitFailed(build([A]), 'pin2', CLOSE);
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', ledger)).toBe('pin1');
        // So is a new Boost window.
        const nextWindow = createMemoryEntryAgeLedger();
        nextWindow.markPinSubmitFailed(build([A]), 'pin1', CLOSE + 1);
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', nextWindow)).toBe('pin1');
    });

    test('a latch whose Boost window passed no longer blocks', () => {
        setup({ boost: 'pin1' });
        const ledger = createMemoryEntryAgeLedger();
        ledger.markPinSubmitFailed(build([A]), 'pin1', CLOSE);
        ledger.observe(build([A]), CLOSE);
        expect(VotingLogic.canSubmitBoostPin(build([A]), '42', ledger)).toBe('pin1');
    });
});
