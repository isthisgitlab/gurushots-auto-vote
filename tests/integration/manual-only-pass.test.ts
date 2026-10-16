/**
 * Manual Only end to end: the REAL voting pass (and, in mock mode, the REAL mock strategy) over a Manual Only
 * challenge that every automatic path wants to act on at once. The injected api is a recording proxy over EVERY method
 * the pass could call, so a path nobody gated shows up as a call attributed to the challenge's id. Pass-wide calls
 * (the fetch, the join/claim pre-steps, the bankroll read) carry no challenge and are not counted.
 */

const mockLogs: Array<{ level: string; msg: string; args: unknown[] }> = [];

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => null,
        writeRaw: () => {},
        getFilePath: () => '/tmp/manual-only-pass.json',
        initializeAsync: async () => {},
    }),
}));
jest.mock('../../src/ts/logger', () => {
    const category = new Proxy(
        {},
        {
            get:
                (_target, level: string) =>
                (msg: unknown, ...rest: unknown[]) => {
                    mockLogs.push({
                        level,
                        msg: String(msg) + (typeof rest[0] === 'string' ? ` ${rest[0]}` : ''),
                        args: [msg, ...rest],
                    });
                },
        },
    );
    const named = {
        __esModule: true,
        withCategory: () => category,
        challengeTag: (challenge: { id?: unknown; title?: unknown }) =>
            `[Challenge ${challenge.id}: ${challenge.title}]`,
    };
    // Anything else the pass reaches for on the logger is a no-op.
    return new Proxy(named, { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}) });
});
jest.mock('../../src/ts/voting/cancellation', () => ({
    isCancelled: jest.fn(() => false),
    setCancelled: jest.fn(),
    reset: jest.fn(),
}));

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import cancellationModule = require('../../src/ts/voting/cancellation');
const cancellation = jest.mocked(cancellationModule);
import type * as votingOrchestratorModule from '../../src/ts/services/votingOrchestrator';
import type * as currencyAutoStoreModule from '../../src/ts/currencyAutoStore';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type * as mockStrategyModule from '../../src/ts/mock/strategy';
import type * as newEntryTrackerModule from '../../src/ts/services/newEntryTracker';
import type * as manualVoteModule from '../../src/ts/services/manualVote';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { MissionNeeds } from '../../src/ts/services/missions';
import type { VotingPassDeps } from '../../src/ts/types/votingPass';
import { invalid } from '../helpers/invalid';
const { runVotingPass, resetManualOnlyLog, resetMissionVoteLog } =
    require('../../src/ts/services/votingOrchestrator') as typeof votingOrchestratorModule;
const { createMemoryAutoSpendLedger } = require('../../src/ts/currencyAutoStore') as typeof currencyAutoStoreModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
const { createMockStrategy } = require('../../src/ts/mock/strategy') as typeof mockStrategyModule;
const { createMemoryEntryTracker } = require('../../src/ts/services/newEntryTracker') as typeof newEntryTrackerModule;
const { voteAllChallengesManual } = require('../../src/ts/services/manualVote') as typeof manualVoteModule;

const NOW = Math.floor(Date.now() / 1000);
const MANUAL_ID = 7007;
const SIBLING_ID = 8008;

const SCENARIO = {
    name: 'Plan',
    version: 1,
    start: 'main',
    phases: { main: { rules: [{ id: 'r', do: [{ type: 'fillExposure' }] }] } },
};

/** Low exposure, a boost and a won Turbo, free slots, the Emergency Submit window open: everything is due. */
const dueChallenge = (id: number, extra: Record<string, unknown> = {}): Challenge =>
    buildChallenge({
        id,
        title: `Challenge ${id}`,
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
                    { id: `e1-${id}`, member_id: 'm', votes: 40 },
                    { id: `e2-${id}`, member_id: 'm', votes: 3 },
                ],
                exposure: { exposure_factor: 10 },
                swaps: [],
            },
        },
        ...extra,
    });

const VALUES: Record<string, unknown> = {
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
    autoSubmit: true,
    autoSubmitSchedule: [{ count: 4, seconds: 600 }],
    emergencySubmit: 300,
    autoBoost: true,
    boostTime: 3600,
    keyUnlockedBoostTime: 900,
    boostFreshEntryWait: 0,
    boostImageIndex: 1,
    boostNewSubmit: true,
    boostNewSubmitOnConflict: true,
    useTurbo: true,
    turboTime: 7200,
    turboImageIndex: 1,
    turboNewSubmit: true,
    turboNewSubmitOnConflict: true,
    autoSwap: true,
    autoKeyUnlock: true,
    autoExposureFill: true,
    scenario: 'Plan',
    mustIncludeTags: [],
    shouldIncludeTags: [],
    submitWithoutTagMatch: true,
    chosenPhotos: [],
    chosenPhotosOnly: false,
    chosenPhotosInOrder: false,
};

/** `manual`: the challenge ids the switch is on for; a function replaces the read (to throw, or to flip mid-pass). */
const mockSettings = (manual: Array<number | string> | ((id: string) => boolean), overrides = {}) => {
    const values: Record<string, unknown> = { ...VALUES, ...overrides };
    const manualFor = Array.isArray(manual) ? (id: string) => manual.map(String).includes(id) : manual;
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
    settings.getScenario = invalid(jest.fn(() => SCENARIO));
    settings.getSetting = invalid(jest.fn((key: string) => values[key]));
    settings.getEffectiveSetting = invalid(
        jest.fn((key: string, id: string) => (key === 'manualPhotosOnly' ? manualFor(id) : values[key])),
    );
    settings.getEffectiveTagSetting = invalid(jest.fn((key: string) => values[key]));
};

type Call = { method: string; args: unknown[] };

/** Whether any argument (deeply) names the challenge: its id as a value, or an object carrying it. */
const mentions = (value: unknown, id: number, depth = 0): boolean => {
    if (value === null || depth > 4) return false;
    if (typeof value === 'number' || typeof value === 'string') return String(value) === String(id);
    if (typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if (record.id !== undefined && String(record.id) === String(id)) return true;
    return Object.values(record).some((inner) => mentions(inner, id, depth + 1));
};

const photos = () =>
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, index) => ({
        id,
        labels: ['Pink'],
        upload_date: 9000 + index,
        permission: { allowed: true, message: null },
    }));

/**
 * A recording stand-in for an endpoint set: ANY property read yields a recording function, so a method the pass
 * reaches for is counted whether or not this file knew about it.
 */
const recorder = (calls: Call[], live: Challenge[]) =>
    new Proxy(
        {},
        {
            get: (_target, name: string | symbol) => {
                if (typeof name !== 'string' || name === 'then') return undefined;
                return async (...args: unknown[]) => {
                    calls.push({ method: name, args });
                    switch (name) {
                        case 'getActiveChallenges':
                            return { challenges: live };
                        case 'getVoteImages':
                            // Carries the challenge, as the real answer does, so the vote that follows is attributable.
                            return { images: [{ id: 'i1' }], challengeId: (args[0] as Challenge | undefined)?.id };
                        case 'getEligiblePhotos':
                            return photos();
                        case 'submitToChallenge':
                            return { ok: true, raw: { success: true } };
                        case 'applyTurbo':
                            return { ok: true };
                        case 'runTurboMiniGame':
                            return { played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false };
                        case 'getBankroll':
                            return { keys: 3, swaps: 3, fills: 3, coins: 0 };
                        case 'getMyMissions':
                            return { missions: [] };
                        default:
                            return { success: true, ok: true };
                    }
                };
            },
        },
    );

const attributed = (calls: Call[], id: number) => calls.filter((call) => call.args.some((arg) => mentions(arg, id)));
const methodsOf = (calls: Call[]) => [...new Set(calls.map((call) => call.method))];

const scenarioLedger = () => ({
    get: jest.fn(() => ({ corrupt: false, state: null, epoch: 0 })),
    set: jest.fn(() => 'saved'),
});

const passDeps = (calls: Call[], live: Challenge[], extra: Partial<VotingPassDeps> = {}) => {
    const ledger = scenarioLedger();
    const deps = invalid<VotingPassDeps>({
        api: recorder(calls, live),
        cleanupStaleMetadata: null,
        interChallengeDelay: () => 0,
        currency: {
            strategy: recorder(calls, live),
            swapLedger: { onSwapped: jest.fn() },
            spendLedger: createMemoryAutoSpendLedger(),
        },
        scenarios: { ledger },
        ...extra,
    });
    return { deps, ledger };
};

const run = (deps: VotingPassDeps, filter: string | number | null = null) => runVotingPass('tok', filter, deps);

const infoLines = () => mockLogs.filter((entry) => entry.level === 'info').map((entry) => entry.msg);

beforeEach(() => {
    jest.clearAllMocks();
    mockLogs.length = 0;
    resetManualOnlyLog();
    resetMissionVoteLog();
    cancellation.isCancelled.mockReturnValue(false);
});

describe('a Manual Only challenge with everything due', () => {
    test('control, switch off: the same pass acts on the challenge (the recorder sees it)', async () => {
        mockSettings([]);
        const calls: Call[] = [];
        const live = [dueChallenge(MANUAL_ID)];
        const { deps, ledger } = passDeps(calls, live);
        await run(deps);
        expect(attributed(calls, MANUAL_ID).length).toBeGreaterThan(0);
        expect(ledger.set).toHaveBeenCalled();
    });

    test('real-strategy shape: zero calls for it on every method of the api and the currency endpoints, no scenario write', async () => {
        mockSettings([MANUAL_ID]);
        const calls: Call[] = [];
        const live = [dueChallenge(MANUAL_ID)];
        const { deps, ledger } = passDeps(calls, live, {
            missions: invalid<MissionNeeds>({ vote: 20, turbo: 2, fill: 1 }),
        });
        await run(deps);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
        expect(ledger.get).not.toHaveBeenCalled();
        expect(ledger.set).not.toHaveBeenCalled();
    });

    test('a locked boost with a key due is left alone too', async () => {
        mockSettings([MANUAL_ID]);
        const calls: Call[] = [];
        const live = [dueChallenge(MANUAL_ID, { member: { boost: { state: 'LOCKED' }, turbo: { state: 'FREE' } } })];
        const { deps } = passDeps(calls, live);
        await run(deps);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
    });

    test('a sibling without the switch still runs', async () => {
        mockSettings([MANUAL_ID]);
        const calls: Call[] = [];
        const live = [dueChallenge(MANUAL_ID), dueChallenge(SIBLING_ID)];
        const { deps, ledger } = passDeps(calls, live);
        await run(deps);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
        expect(attributed(calls, SIBLING_ID).length).toBeGreaterThan(0);
        expect(ledger.set).toHaveBeenCalled();
    });

    test('mock mode: the same, through the mock strategy over a recording client', async () => {
        mockSettings([MANUAL_ID]);
        const calls: Call[] = [];
        const live = [dueChallenge(MANUAL_ID), dueChallenge(SIBLING_ID)];
        const client = recorder(calls, live);
        const result = await createMockStrategy(invalid(client)).fetchChallengesAndVote('tok');
        expect(result.success).toBe(true);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
        expect(attributed(calls, SIBLING_ID).length).toBeGreaterThan(0);
    });

    test('turning the switch on between two challenges stops the second', async () => {
        const calls: Call[] = [];
        const live = [dueChallenge(MANUAL_ID), dueChallenge(SIBLING_ID)];
        // Sorted by close time: both close together, so the order is the list order. The switch reads off for the
        // first challenge's own checks, then flips on once the second challenge is reached.
        let reads = 0;
        mockSettings((id) => {
            if (id === String(SIBLING_ID)) {
                reads += 1;
                return reads > 1;
            }
            return false;
        });
        const { deps } = passDeps(calls, live);
        await run(deps);
        expect(attributed(calls, MANUAL_ID).length).toBeGreaterThan(0);
        expect(methodsOf(attributed(calls, SIBLING_ID))).toEqual([]);
    });

    test('a switch read that throws spends nothing on that challenge, and the next one still runs', async () => {
        const calls: Call[] = [];
        const live = [dueChallenge(MANUAL_ID), dueChallenge(SIBLING_ID)];
        mockSettings((id) => {
            if (id === String(MANUAL_ID)) throw new Error('unreadable');
            return false;
        });
        const { deps } = passDeps(calls, live);
        const result = await run(deps);
        expect(result.success).toBe(true);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
        expect(attributed(calls, SIBLING_ID).length).toBeGreaterThan(0);
        expect(
            mockLogs.some(
                (entry) => entry.level === 'error' && entry.msg.includes('Skipped after an unexpected error'),
            ),
        ).toBe(true);
    });

    test('a cancel during a pass whose remaining challenges are all Manual Only reports cancelled', async () => {
        mockSettings([MANUAL_ID, SIBLING_ID]);
        const calls: Call[] = [];
        const { deps } = passDeps(calls, [dueChallenge(MANUAL_ID), dueChallenge(SIBLING_ID)]);
        cancellation.isCancelled.mockReturnValue(true);
        const result = await run(deps);
        expect(result.success).toBe(false);
        expect(result.message).toBe('Voting cancelled by user');
    });
});

describe('the scoped Run', () => {
    test('on a Manual Only challenge it is a successful no-op with one info line and no error', async () => {
        mockSettings([MANUAL_ID]);
        const calls: Call[] = [];
        const { deps } = passDeps(calls, [dueChallenge(MANUAL_ID), dueChallenge(SIBLING_ID)]);
        const result = await run(deps, MANUAL_ID);
        expect(result.success).toBe(true);
        expect(result.message).toBe(
            `[Challenge ${MANUAL_ID}: Challenge ${MANUAL_ID}] Manual Only is on — nothing runs automatically`,
        );
        expect(infoLines()).toContain(result.message);
        expect(mockLogs.filter((entry) => entry.level === 'error' || entry.level === 'warning')).toEqual([]);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
        expect(result.challenges).toHaveLength(2);
    });

    test('when the switch cannot be read it fails closed, says so, and is a failed Run, not a Manual Only one', async () => {
        mockSettings((id) => {
            if (id === String(MANUAL_ID)) throw new Error('unreadable');
            return false;
        });
        const calls: Call[] = [];
        const { deps } = passDeps(calls, [dueChallenge(MANUAL_ID), dueChallenge(SIBLING_ID)]);
        const result = await run(deps, MANUAL_ID);
        const message = `[Challenge ${MANUAL_ID}: Challenge ${MANUAL_ID}] Could not read the Manual Only setting — nothing runs automatically. Open the challenge settings, make sure Manual Only is set the way you want and save, then try again`;
        expect(result).toEqual(expect.objectContaining({ success: false, error: message }));
        expect(result.challenges).toHaveLength(2);
        expect(mockLogs.filter((entry) => entry.level === 'warning').map((entry) => entry.msg)).toContain(message);
        expect(infoLines().some((line) => line.includes('Manual Only is on'))).toBe(false);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
    });

    test('through the CLI cliVote it closes cli-vote as a success', async () => {
        mockSettings([MANUAL_ID]);
        const calls: Call[] = [];
        const { deps } = passDeps(calls, [dueChallenge(MANUAL_ID)]);
        const { BaseMiddleware } =
            require('../../src/ts/services/BaseMiddleware') as typeof import('../../src/ts/services/BaseMiddleware');
        const token = 'tok';
        const middleware = new BaseMiddleware(
            invalid({ fetchChallengesAndVote: (_token: string, id: string | number | null) => run(deps, id) }),
        );
        jest.spyOn(middleware, '_requireCliToken').mockReturnValue(token);
        const result = await middleware.cliVote(MANUAL_ID);
        expect(result).toEqual(expect.objectContaining({ success: true }));
        expect(mockLogs.filter((entry) => entry.level === 'error')).toEqual([]);
        expect(mockLogs.some((entry) => entry.level === 'endOperation')).toBe(true);
    });

    test('through the CLI cliVote an unreadable switch closes cli-vote as a failure with the real cause', async () => {
        mockSettings((id) => {
            if (id === String(MANUAL_ID)) throw new Error('unreadable');
            return false;
        });
        const calls: Call[] = [];
        const { deps } = passDeps(calls, [dueChallenge(MANUAL_ID)]);
        const { BaseMiddleware } =
            require('../../src/ts/services/BaseMiddleware') as typeof import('../../src/ts/services/BaseMiddleware');
        const middleware = new BaseMiddleware(
            invalid({ fetchChallengesAndVote: (_token: string, id: string | number | null) => run(deps, id) }),
        );
        jest.spyOn(middleware, '_requireCliToken').mockReturnValue('tok');
        const message = `[Challenge ${MANUAL_ID}: Challenge ${MANUAL_ID}] Could not read the Manual Only setting — nothing runs automatically. Open the challenge settings, make sure Manual Only is set the way you want and save, then try again`;
        const result = await middleware.cliVote(MANUAL_ID);
        expect(result).toEqual(expect.objectContaining({ success: false, error: message }));
        const closed = mockLogs.filter((entry) => entry.level === 'endOperation').map((entry) => entry.args);
        // The pass closes its own operation with the cause, and cli-vote closes as a failure (no success text).
        expect(closed).toContainEqual(['voting-process', null, message]);
        expect(closed).toContainEqual(['cli-vote', null, message]);
        expect(closed).not.toContainEqual(['cli-vote', 'Voting process completed successfully']);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
    });

    test('on a challenge without the switch it runs as before', async () => {
        mockSettings([MANUAL_ID]);
        const calls: Call[] = [];
        const { deps } = passDeps(calls, [dueChallenge(MANUAL_ID), dueChallenge(SIBLING_ID)]);
        await run(deps, SIBLING_ID);
        expect(attributed(calls, SIBLING_ID).length).toBeGreaterThan(0);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
    });
});

describe('the progress counter', () => {
    test('counts every challenge, a skipped Manual Only one included', async () => {
        mockSettings([MANUAL_ID]);
        const calls: Call[] = [];
        const { deps } = passDeps(calls, [dueChallenge(MANUAL_ID), dueChallenge(SIBLING_ID)]);
        await run(deps);
        const progress = mockLogs.filter((entry) => entry.level === 'progress').map((entry) => entry.msg);
        expect(progress).toEqual([
            `Processing challenge 1/2: Challenge ${MANUAL_ID}`,
            `Processing challenge 2/2: Challenge ${SIBLING_ID}`,
        ]);
    });
});

describe('the skip log', () => {
    test('is written when a challenge enters the state and when it leaves it, never on every pass', async () => {
        const calls: Call[] = [];
        const live = [dueChallenge(MANUAL_ID)];
        const tag = `[Challenge ${MANUAL_ID}: Challenge ${MANUAL_ID}]`;
        const on = `${tag} Manual Only is on — nothing runs automatically`;
        const off = `${tag} Manual Only is off — automatic rules resume`;
        const { deps } = passDeps(calls, live);

        mockSettings([MANUAL_ID]);
        await run(deps);
        await run(deps);
        expect(infoLines().filter((line) => line === on)).toHaveLength(1);

        mockSettings([]);
        await run(deps);
        await run(deps);
        expect(infoLines().filter((line) => line === off)).toHaveLength(1);

        mockSettings([MANUAL_ID]);
        await run(deps);
        expect(infoLines().filter((line) => line === on)).toHaveLength(2);
    });

    test('forgets challenges that are no longer active', async () => {
        const calls: Call[] = [];
        mockSettings([MANUAL_ID]);
        const tag = `[Challenge ${MANUAL_ID}: Challenge ${MANUAL_ID}]`;
        await run(passDeps(calls, [dueChallenge(MANUAL_ID)]).deps);
        await run(passDeps(calls, [dueChallenge(SIBLING_ID)]).deps);
        await run(passDeps(calls, [dueChallenge(MANUAL_ID)]).deps);
        expect(
            infoLines().filter((line) => line === `${tag} Manual Only is on — nothing runs automatically`),
        ).toHaveLength(2);
    });
});

describe('the ledgers stay current while a challenge is skipped', () => {
    const withEntries = (ids: string[], close = NOW + 7200): Challenge =>
        dueChallenge(MANUAL_ID, {
            close_time: close,
            member: {
                boost: { state: 'NONE' },
                turbo: { state: 'NONE' },
                ranking: {
                    entries: ids.map((id) => ({ id, member_id: 'm', votes: 1 })),
                    exposure: { exposure_factor: 100 },
                },
            },
        });

    test('the entry ages are observed, and the new-entry snapshot is re-baselined', async () => {
        mockSettings([MANUAL_ID], { voteOnNewEntry: true });
        const calls: Call[] = [];
        const entryTracker = createMemoryEntryTracker();
        const observe = jest.fn();
        const entryAges = invalid<VotingPassDeps['entryAges']>({ observe, isUncertain: () => false });
        entryTracker.set(String(MANUAL_ID), ['a']);
        const { deps } = passDeps(calls, [withEntries(['a', 'b'])], { entryTracker, entryAges });
        await run(deps);
        expect(observe).toHaveBeenCalledTimes(1);
        // The photo entered by hand while the switch was on is not "new" once it goes off.
        expect(entryTracker.get(String(MANUAL_ID))).toEqual(['a', 'b']);
    });

    test('an empty entries read does not clear the snapshot', async () => {
        mockSettings([MANUAL_ID], { voteOnNewEntry: true });
        const calls: Call[] = [];
        const entryTracker = createMemoryEntryTracker();
        entryTracker.set(String(MANUAL_ID), ['a', 'b']);
        const { deps } = passDeps(calls, [withEntries([])], { entryTracker });
        await run(deps);
        expect(entryTracker.get(String(MANUAL_ID))).toEqual(['a', 'b']);
    });

    test('switching off then makes no forced vote for the entries the snapshot already saw', async () => {
        const calls: Call[] = [];
        const entryTracker = createMemoryEntryTracker();
        entryTracker.set(String(MANUAL_ID), ['a']);
        const live = [withEntries(['a', 'b'])];
        const { deps } = passDeps(calls, live, { entryTracker });
        mockSettings([MANUAL_ID], { voteOnNewEntry: true });
        await run(deps);
        mockLogs.length = 0;
        mockSettings([], { voteOnNewEntry: true });
        await run(deps);
        expect(mockLogs.some((entry) => entry.msg.includes('New entry detected'))).toBe(false);
    });

    test('a photo still fresh at switch-off keeps its normal new-entry detection', async () => {
        const calls: Call[] = [];
        const entryTracker = createMemoryEntryTracker();
        entryTracker.set(String(MANUAL_ID), ['a']);
        const { deps } = passDeps(calls, [withEntries(['a'])], { entryTracker });
        mockSettings([MANUAL_ID], { voteOnNewEntry: true });
        await run(deps);
        mockSettings([], { voteOnNewEntry: true });
        const grown = passDeps(calls, [withEntries(['a', 'c'])], { entryTracker }).deps;
        await run(grown);
        expect(mockLogs.some((entry) => entry.msg.includes('New entry detected'))).toBe(true);
    });
});

describe('vote missions', () => {
    const open = (id: number) =>
        dueChallenge(id, {
            member: {
                boost: { state: 'NONE' },
                turbo: { state: 'NONE' },
                ranking: { entries: [{ id: `e-${id}`, member_id: 'm', votes: 1 }], exposure: { exposure_factor: 50 } },
            },
            close_time: NOW + 7200,
        });
    // Plain voting stays off, so only the mission would make a challenge vote.
    const missionSettings = { exposure: 0 };

    test('with only Manual Only challenges available, nothing is cast and the stall is logged', async () => {
        mockSettings([MANUAL_ID], missionSettings);
        const calls: Call[] = [];
        const { deps } = passDeps(calls, [open(MANUAL_ID)], { missions: invalid<MissionNeeds>({ vote: 20 }) });
        await run(deps);
        expect(calls.filter((call) => call.method === 'submitVotes')).toEqual([]);
        expect(infoLines().some((line) => line.includes('Vote mission: 20 left'))).toBe(true);
    });

    test('the quota is shared over the challenges that can vote, not the Manual Only one', async () => {
        mockSettings([MANUAL_ID], missionSettings);
        const calls: Call[] = [];
        const { deps } = passDeps(calls, [open(MANUAL_ID), open(SIBLING_ID)], {
            missions: invalid<MissionNeeds>({ vote: 20 }),
        });
        await run(deps);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
        expect(
            calls.some((call) => call.method === 'submitVotes' && call.args.some((arg) => mentions(arg, SIBLING_ID))),
        ).toBe(true);
        expect(infoLines().some((line) => line.includes('Vote mission'))).toBe(false);
    });

    test('a challenge whose switch read throws takes no quota, and the others still vote', async () => {
        mockSettings((id) => {
            if (id === String(MANUAL_ID)) throw new Error('unreadable');
            return false;
        }, missionSettings);
        const calls: Call[] = [];
        const { deps } = passDeps(calls, [open(MANUAL_ID), open(SIBLING_ID)], {
            missions: invalid<MissionNeeds>({ vote: 20 }),
        });
        await run(deps);
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
        expect(
            calls.some((call) => call.method === 'submitVotes' && call.args.some((arg) => mentions(arg, SIBLING_ID))),
        ).toBe(true);
    });
});

describe('Vote All', () => {
    const strategy = (calls: Call[], live: Challenge[]) =>
        invalid<Parameters<typeof voteAllChallengesManual>[1]>(recorder(calls, live));
    const voteable = (id: number) =>
        dueChallenge(id, {
            close_time: NOW + 7200,
            member: { ranking: { exposure: { exposure_factor: 10 }, entries: [] } },
        });

    test('skips a Manual Only challenge, logs one line for it and counts it as skipped', async () => {
        mockSettings([MANUAL_ID]);
        const calls: Call[] = [];
        const live = [voteable(MANUAL_ID), voteable(SIBLING_ID)];
        const result = await voteAllChallengesManual(live, strategy(calls, live), 'tok', { staggerMs: 0 });
        expect(result).toEqual({ voted: 1, skipped: 1, total: 2 });
        expect(methodsOf(attributed(calls, MANUAL_ID))).toEqual([]);
        expect(
            infoLines().filter((line) => line.endsWith('Manual Only is on — nothing runs automatically')),
        ).toHaveLength(1);
    });

    test('a switch read that throws skips that challenge with one error line', async () => {
        mockSettings((id) => {
            if (id === String(MANUAL_ID)) throw new Error('unreadable');
            return false;
        });
        const calls: Call[] = [];
        const live = [voteable(MANUAL_ID), voteable(SIBLING_ID)];
        const result = await voteAllChallengesManual(live, strategy(calls, live), 'tok', { staggerMs: 0 });
        expect(result).toEqual({ voted: 1, skipped: 1, total: 2 });
        expect(mockLogs.filter((entry) => entry.level === 'error')).toHaveLength(1);
    });
});
