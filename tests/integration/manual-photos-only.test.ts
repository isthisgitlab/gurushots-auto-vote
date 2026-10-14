/**
 * End-to-end guard for Manual Photos Only: the REAL voting pass, rule engine, fill pipeline, decisions and currency
 * runner over a challenge that every automatic photo path wants to act on at once. Each unit gate is tested where
 * it lives; this is the seam that catches a path nobody gated. Only settings (to drive every option), the spend
 * endpoints and the API are stubbed.
 *
 * The control run (switch off) must submit photos and swap; the same pass with the switch on must do neither.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => null,
        writeRaw: () => {},
        getFilePath: () => '/tmp/manual-photos-only.json',
        initializeAsync: async () => {},
    }),
}));
jest.mock('../../src/ts/services/currencyActions', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/services/currencyActions')>(
        '../../src/ts/services/currencyActions',
    ),
    previewSwap: jest.fn(),
    swapEntry: jest.fn(),
}));

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import currencyActionsModule = require('../../src/ts/services/currencyActions');
const currencyActions = jest.mocked(currencyActionsModule);
import type * as votingOrchestratorModule from '../../src/ts/services/votingOrchestrator';
import type * as currencyAutoStoreModule from '../../src/ts/currencyAutoStore';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type * as VotingLogicModule from '../../src/ts/services/VotingLogic';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { VotingPassDeps } from '../../src/ts/types/votingPass';
import { invalid } from '../helpers/invalid';
const { runVotingPass } = require('../../src/ts/services/votingOrchestrator') as typeof votingOrchestratorModule;
const { createMemoryAutoSpendLedger } = require('../../src/ts/currencyAutoStore') as typeof currencyAutoStoreModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
const VotingLogic = require('../../src/ts/services/VotingLogic') as typeof VotingLogicModule;

const NOW = Math.floor(Date.now() / 1000);

/** Free slots, the Emergency Submit window open, a Boost and a won Turbo ready, two entries a swap could replace. */
const challenge = (): Challenge =>
    buildChallenge({
        id: 7007,
        title: 'Pink In Nature',
        type: 'regular',
        start_time: NOW - 20 * 3600,
        close_time: NOW + 120,
        max_photo_submits: 4,
        swap_enable: true,
        swap_locked: false,
        member: {
            boost: { state: 'AVAILABLE_KEY' },
            turbo: { state: 'WON' },
            ranking: {
                entries: [
                    { id: 'e1', member_id: 'm', votes: 40 },
                    { id: 'e2', member_id: 'm', votes: 3 },
                ],
                exposure: { exposure_factor: 100 },
                swaps: [],
            },
        },
    });

const ALL_ON: Record<string, unknown> = {
    // Nothing to vote for: exposure sits at the trigger.
    exposure: 90,
    exposureTarget: 0,
    onlyBoost: false,
    voteOnNewEntry: false,
    voteOnlyInLastMinute: false,
    lastMinuteThreshold: 10,
    useFinalWindowExposure: false,
    useScheduledFill: false,
    scheduledFillReplaces: false,
    scheduledFillTime: [],
    scheduledFillBeforeEnd: [],
    timezone: 'UTC',
    // The photo paths
    autoFill: true,
    autoFillSchedule: [{ count: 4, seconds: 600 }],
    emergencyFill: 300,
    autoBoost: true,
    boostTime: 3600,
    keyUnlockedBoostTime: 900,
    boostFreshEntryWait: 0,
    boostImageIndex: 1,
    boostFillNew: true,
    boostFillNewOnConflict: true,
    useTurbo: true,
    turboTime: 7200,
    turboImageIndex: 1,
    turboFillNew: true,
    turboFillNewOnConflict: true,
    autoSwap: true,
    autoSwapAfterStart: 0,
    autoSwapBeforeEnd: 0,
    autoSwapAfterPercent: 0,
    autoSwapImageIndex: 0,
    autoSwapLowestVotes: false,
    autoSwapAllowBoosted: false,
    autoSwapMaxVotes: 0,
    autoSwapMax: 1,
    currencyReserveSwaps: 0,
    // Fill options
    mustIncludeTags: [],
    shouldIncludeTags: [],
    fillWithoutTagMatch: true,
    chosenPhotos: [],
    chosenPhotosOnly: false,
    chosenPhotosInOrder: false,
};

const mockSettings = (overrides: Record<string, unknown>) => {
    const values = { ...ALL_ON, ...overrides };
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => values[key]));
    settings.getEffectiveTagSetting = invalid(jest.fn((key: string) => values[key]));
};

let photoSerial: number;
const photos = () =>
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => ({
        id,
        labels: ['Pink'],
        upload_date: 9000 + photoSerial++,
        permission: { allowed: true, message: null },
    }));

const makeApi = (live: Challenge) => ({
    getActiveChallenges: jest.fn(async () => ({ challenges: [live] })),
    getVoteImages: jest.fn(async () => ({ images: [{ id: 'i1' }] })),
    submitVotes: jest.fn(async () => ({ success: true })),
    applyBoost: jest.fn(async () => ({ success: true })),
    applyBoostToEntry: jest.fn<Promise<{ success: boolean }>, [string, string, string]>(async () => ({
        success: true,
    })),
    applyTurbo: jest.fn(async () => ({ ok: true })),
    getEligiblePhotos: jest.fn(async () => photos()),
    getImageData: jest.fn(async () => null),
    submitToChallenge: jest.fn(async () => ({ ok: true, raw: { success: true } })),
    runTurboMiniGame: jest.fn(async () => ({ played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false })),
});

const run = (api: ReturnType<typeof makeApi>) =>
    runVotingPass(
        'tok',
        null,
        invalid<VotingPassDeps>({
            api,
            cleanupStaleMetadata: null,
            interChallengeDelay: () => 0,
            currency: {
                strategy: { getBankroll: jest.fn(async () => ({ keys: 3, swaps: 3, fills: 3, coins: 0 })) },
                swapLedger: { onSwapped: jest.fn() },
                spendLedger: createMemoryAutoSpendLedger(),
            },
        }),
    );

beforeEach(() => {
    jest.clearAllMocks();
    photoSerial = 0;
    currencyActions.previewSwap.mockResolvedValue(
        invalid({ ok: true, outcome: 'ok', candidate: { id: 'new1', member_id: 'm' } }),
    );
    currencyActions.swapEntry.mockResolvedValue({ ok: true, outcome: 'ok' });
});

describe('a pass over a challenge every automatic photo path wants', () => {
    test('control, switch off: the pass submits photos and swaps', async () => {
        mockSettings({ manualPhotosOnly: false });
        const api = makeApi(challenge());
        await run(api);
        expect(api.submitToChallenge).toHaveBeenCalled();
        expect(currencyActions.swapEntry).toHaveBeenCalled();
    });

    test('control, Auto-Submit off: Emergency Submit alone still submits', async () => {
        mockSettings({ manualPhotosOnly: false, autoFill: false, boostFillNew: false, turboFillNew: false });
        const api = makeApi(challenge());
        await run(api);
        expect(api.submitToChallenge).toHaveBeenCalled();
    });

    test.each([
        ['every option on', {}],
        ['Auto-Submit off, so Emergency Submit is the one that would act', { autoFill: false }],
        ['only the fresh-photo Boost/Turbo options on', { autoFill: false, emergencyFill: 0, autoSwap: false }],
    ])('switch on, %s: no photo is submitted and nothing is swapped', async (_name, overrides) => {
        mockSettings({ manualPhotosOnly: true, ...overrides });
        const api = makeApi(challenge());
        await run(api);
        expect(api.submitToChallenge).not.toHaveBeenCalled();
        expect(currencyActions.previewSwap).not.toHaveBeenCalled();
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();
    });

    test('switch on: Boost and Turbo still go on the entries the challenge already has', async () => {
        mockSettings({ manualPhotosOnly: true });
        const api = makeApi(challenge());
        await run(api);
        expect(api.applyBoostToEntry.mock.calls.length + api.applyBoost.mock.calls.length).toBeGreaterThan(0);
        expect(api.applyTurbo).toHaveBeenCalled();
        for (const [, imageId] of api.applyBoostToEntry.mock.calls) expect(['e1', 'e2']).toContain(imageId);
    });

    test('switch on: the deadline view lists no Auto-Submit or Emergency Submit row', () => {
        mockSettings({ manualPhotosOnly: true });
        const { actions } = VotingLogic.describeDeadlineActions(challenge(), NOW);
        const rows = actions.map((row) => row.action);
        expect(rows).not.toContain('autoFill');
        expect(rows).not.toContain('emergencyFill');
    });
});
