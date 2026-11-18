/**
 * The scenario evidence loader: it fetches only the evidence the rules of a scenario read, through the API factory and
 * the existing services, and turns a failed read into unreadable evidence, never an empty value.
 */

jest.mock('../../src/ts/core/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warning: jest.fn(), success: jest.fn() };
    return {
        withCategory: jest.fn(() => category),
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
        __category: category,
    };
});
jest.mock('../../src/ts/core/settings', () => ({
    getEntryPins: jest.fn(),
    getEffectiveTagSetting: jest.fn(),
    getEffectiveSetting: jest.fn(),
    getSetting: jest.fn(),
}));
jest.mock('../../src/ts/core/services/autoFill', () => ({ scanFillCandidates: jest.fn() }));

import loggerModule = require('../../src/ts/core/logger');
import settingsModule = require('../../src/ts/core/settings');
import autoFillModule = require('../../src/ts/core/services/autoFill');
import type * as loaderModule from '../../src/ts/core/services/scenarioRunner/facts';
import type * as factsModule from '../../src/ts/core/scenarios/facts';
import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';
import type { RunnerContext } from '../../src/ts/core/services/scenarioRunner/types';
import type { CompletedChallenge, Mission } from '../../src/ts/core/types/gurushots';
import type { CategoryLogger } from '../../src/ts/core/logger';
import { invalid } from '../helpers/invalid';

const settings = jest.mocked(settingsModule);
const { scanFillCandidates } = jest.mocked(autoFillModule);
const { loadScenarioSnapshot } = require('../../src/ts/core/services/scenarioRunner/facts') as typeof loaderModule;
const { FACTS } = require('../../src/ts/core/scenarios/facts') as typeof factsModule;

type CategoryMock = { warning: jest.MockedFunction<CategoryLogger['warning']> };
const log = (loggerModule as typeof loggerModule & { __category: CategoryMock }).__category;

const NOW = Math.floor(Date.now() / 1000);
const warnings = () => log.warning.mock.calls.map((call) => call[0]);

const lit = (value: number, quantity = 'count') => ({ kind: 'literal', value, quantity });
const factRef = (name: string, select?: object) => ({ kind: 'fact', name, ...(select ? { select } : {}) });
const present = (name: string, select?: object) => ({ type: 'present', value: factRef(name, select) });
const compare = (name: string, quantity = 'count') => ({
    type: 'compare',
    left: factRef(name),
    op: '>',
    right: lit(0, quantity),
});

/** A scenario whose `main` phase holds one rule per condition list (`other` holds the rules of a second phase). */
const scenario = (conditions: object[], other: object[] = []) =>
    invalid<ScenarioDocument>({
        name: 'Plan',
        version: 1,
        start: 'main',
        phases: {
            main: { rules: [{ id: 'r1', if: conditions, do: [] }] },
            other: { rules: [{ id: 'r2', if: other, do: [] }] },
        },
    });

type Ledger = {
    refresh: jest.Mock<Promise<void>, []>;
    entryTimes: jest.Mock<Record<string, { at: number; exact: boolean }>, []>;
    isUncertain: jest.Mock<boolean, [string | number, string | number]>;
    health: jest.Mock<{ read: boolean; refresh: boolean }, []>;
};

const makeLedger = (): Ledger => ({
    refresh: jest.fn(async () => undefined),
    entryTimes: jest.fn(() => ({ a: { at: NOW - 600, exact: true } })),
    isUncertain: jest.fn((_challengeId, imageId) => imageId === 'b'),
    health: jest.fn(() => ({ read: true, refresh: true })),
});

const getBankroll = jest.fn();
const getMyMissions = jest.fn();
const getMyCompletedChallenges = jest.fn();
let ledger: Ledger | null;
let api: Record<string, unknown>;

const ctx = () =>
    invalid<RunnerContext>({
        challenge: {
            id: 7,
            member: { ranking: { entries: [{ id: 'a' }, { id: 'b' }] } },
        },
        challengeId: '7',
        pass: {
            token: 'tok',
            api,
            fillDeps: { marker: 'fill-deps' },
            entryAges: ledger,
            currency: { strategy: { getBankroll } },
        },
    });

const mission = (name: string, current: number, required: number, over: Record<string, unknown> = {}) =>
    invalid<Mission>({
        id: name,
        name,
        progress: { current, required },
        expiration_timestamp: NOW + 3600,
        claim_state: 'DISABLED',
        ...over,
    });

const completed = (id: number, claim: string) =>
    invalid<CompletedChallenge>({ id, member: { rewards_by_section: { claim_state: claim } } });

beforeEach(() => {
    jest.clearAllMocks();
    ledger = makeLedger();
    getBankroll.mockResolvedValue({ keys: 1, swaps: 2, fills: 3, coins: 4 });
    getMyMissions.mockResolvedValue([]);
    getMyCompletedChallenges.mockResolvedValue([]);
    api = { getMyMissions, getMyCompletedChallenges };
    settings.getEntryPins.mockReturnValue({ boost: 'a', turbo: null });
    settings.getEffectiveTagSetting.mockImplementation((key) => (key === 'mustIncludeTags' ? ['sea'] : ['light']));
    settings.getEffectiveSetting.mockReturnValue(false);
    scanFillCandidates.mockResolvedValue({ eligible: 3, complete: true });
});

const noReads = () => {
    expect(getBankroll).not.toHaveBeenCalled();
    expect(getMyMissions).not.toHaveBeenCalled();
    expect(getMyCompletedChallenges).not.toHaveBeenCalled();
    expect(ledger?.refresh).not.toHaveBeenCalled();
    expect(ledger?.entryTimes).not.toHaveBeenCalled();
    expect(settings.getEntryPins).not.toHaveBeenCalled();
    expect(scanFillCandidates).not.toHaveBeenCalled();
};

describe('what is fetched', () => {
    test('a scenario whose facts need no extra evidence makes no read at all', async () => {
        const conditions = [
            { type: 'entries', op: '>', value: 0 },
            { type: 'boostState', in: ['AVAILABLE'] },
            { type: 'memorySet', slot: 'x' },
            { type: 'entry', select: { by: 'mostVotes' }, field: 'votes', op: '>', value: 1 },
            { type: 'entriesWhere', quantifier: 'any', where: [{ field: 'votes', op: '>', value: 1 }] },
            { type: 'entryCount', where: [{ field: 'votes', op: '>', value: 1 }], op: '>', value: 0 },
            compare('challenge.timeLeft', 'duration'),
            present('boost.open'),
            present('challenge.players'),
            { type: 'any', of: [{ type: 'not', condition: present('clock.now') }] },
        ];
        await expect(loadScenarioSnapshot(scenario(conditions), ctx())).resolves.toEqual({});
        noReads();
    });

    test('a scenario with no rules, or a phase with none, reads nothing', async () => {
        const empty = invalid<ScenarioDocument>({ name: 'Plan', version: 1, start: 'main', phases: { main: {} } });
        await expect(loadScenarioSnapshot(empty, ctx())).resolves.toEqual({});
        await expect(loadScenarioSnapshot(empty, ctx(), 'main')).resolves.toEqual({});
        await expect(loadScenarioSnapshot(empty, ctx(), 'gone')).resolves.toEqual({});
        noReads();
    });

    test('a rule without conditions reads nothing', async () => {
        const noIf = invalid<ScenarioDocument>({
            name: 'Plan',
            version: 1,
            start: 'main',
            phases: { main: { rules: [{ id: 'r1', do: [] }] } },
        });
        await expect(loadScenarioSnapshot(noIf, ctx())).resolves.toEqual({});
        noReads();
    });

    test('a balance fact only inside a compare expression loads the bankroll', async () => {
        const evidence = await loadScenarioSnapshot(scenario([compare('balance.coins', 'coins')]), ctx());
        expect(getBankroll).toHaveBeenCalledWith('tok');
        expect(evidence).toEqual({ bankroll: { keys: 1, swaps: 2, fills: 3, coins: 4 } });
        expect(getMyMissions).not.toHaveBeenCalled();
    });

    test('a balance fact deep in an expression (offset, earlier, min) still loads it', async () => {
        const nested = {
            type: 'compare',
            op: '>',
            left: {
                kind: 'min',
                of: [factRef('balance.swaps'), { kind: 'add', left: factRef('balance.swaps'), right: lit(1, 'swaps') }],
            },
            right: lit(0, 'swaps'),
        };
        await loadScenarioSnapshot(scenario([nested]), ctx());
        expect(getBankroll).toHaveBeenCalledTimes(1);
    });

    test('the balance condition, alone or inside any, all and not, loads the bankroll once', async () => {
        const balance = { type: 'balance', currency: 'swaps', op: '>', value: 1 };
        for (const conditions of [
            [balance],
            [{ type: 'any', of: [balance] }],
            [{ type: 'all', of: [balance, balance] }],
            [{ type: 'not', condition: { type: 'all', of: [balance] } }],
        ]) {
            getBankroll.mockClear();
            await loadScenarioSnapshot(scenario(conditions), ctx());
            expect(getBankroll).toHaveBeenCalledTimes(1);
        }
    });

    test('every expression slot is read: present, absent, contains, containsAny, containsAll, compare right side', async () => {
        const slots = [
            { type: 'absent', value: factRef('balance.keys') },
            { type: 'present', value: factRef('balance.keys') },
            { type: 'contains', list: factRef('challenge.tags'), value: factRef('balance.keys') },
            { type: 'containsAny', list: factRef('balance.keys'), value: lit(1) },
            { type: 'containsAll', list: lit(1), value: factRef('balance.keys') },
            { type: 'compare', left: lit(1, 'keys'), op: '>', right: factRef('balance.keys') },
        ];
        for (const slot of slots) {
            getBankroll.mockClear();
            await loadScenarioSnapshot(scenario([slot]), ctx());
            expect(getBankroll).toHaveBeenCalledTimes(1);
        }
    });

    test('each kind of evidence is fetched only for the facts that read it', async () => {
        const kinds: Array<[string, object, string[]]> = [
            ['missions', compare('missions.joinNeed'), ['missions']],
            ['rewards', present('rewards.claimable'), ['rewards']],
            ['entry ages', present('entry.minAge', { by: 'slot', index: 1 }), ['entryAges']],
            ['uncertain', present('entry.uncertainSubmission', { by: 'slot', index: 1 }), ['uncertain']],
            ['pins', present('entry.pinned', { by: 'slot', index: 1 }), ['pins']],
            ['photos', present('photos.hasEligible'), ['photoScan']],
        ];
        for (const [, condition, expected] of kinds) {
            jest.clearAllMocks();
            const evidence = await loadScenarioSnapshot(scenario([condition]), ctx());
            expect(Object.keys(evidence)).toEqual(expected);
            expect(getBankroll).not.toHaveBeenCalled();
        }
    });

    test('the registry decides: every fact that names evidence in its dependencies loads exactly that evidence', async () => {
        const expected: Record<string, string> = {
            bankroll: 'bankroll',
            missions: 'missions',
            rewards: 'rewards',
            'entry-ages': 'entryAges',
            'entry-uncertain': 'uncertain',
            'entry-pins': 'pins',
            'photo-scan': 'photoScan',
        };
        for (const [name, fact] of Object.entries(FACTS)) {
            jest.clearAllMocks();
            const select = fact.takesSelect ? { by: 'slot', index: 1 } : undefined;
            const evidence = await loadScenarioSnapshot(scenario([present(name, select)]), ctx());
            const wanted = fact.dependencies.filter((dependency) => dependency in expected).map((d) => expected[d]);
            expect(Object.keys(evidence).sort()).toEqual([...new Set(wanted)].sort());
        }
    });

    test("with a phase, only that phase's rules decide; without one, every phase does", async () => {
        const doc = scenario([present('clock.now')], [compare('missions.voteNeed')]);
        await expect(loadScenarioSnapshot(doc, ctx(), 'main')).resolves.toEqual({});
        expect(getMyMissions).not.toHaveBeenCalled();
        const other = await loadScenarioSnapshot(doc, ctx(), 'other');
        expect(Object.keys(other)).toEqual(['missions']);
        const all = await loadScenarioSnapshot(doc, ctx());
        expect(Object.keys(all)).toEqual(['missions']);
    });

    test('evidence is fetched once per call, whatever the number of facts that read it', async () => {
        await loadScenarioSnapshot(
            scenario([
                compare('missions.joinNeed'),
                compare('missions.voteNeed'),
                compare('missions.nextExpiry', 'instant'),
            ]),
            ctx(),
        );
        expect(getMyMissions).toHaveBeenCalledTimes(1);
    });
});

describe('the bankroll', () => {
    test('a bankroll the producer could not read stays null (unknown), a throw is logged and also null', async () => {
        getBankroll.mockResolvedValueOnce(null);
        await expect(loadScenarioSnapshot(scenario([compare('balance.coins', 'coins')]), ctx())).resolves.toEqual({
            bankroll: null,
        });
        getBankroll.mockRejectedValueOnce(new Error('offline'));
        await expect(loadScenarioSnapshot(scenario([compare('balance.coins', 'coins')]), ctx())).resolves.toEqual({
            bankroll: null,
        });
        getBankroll.mockRejectedValueOnce('plain');
        await loadScenarioSnapshot(scenario([compare('balance.coins', 'coins')]), ctx());
        expect(warnings()).toEqual([
            '[7] could not read the balance for the scenario: offline',
            '[7] could not read the balance for the scenario: plain',
        ]);
    });
});

describe('missions', () => {
    test('a read list becomes the needs of every kind and the next expiry', async () => {
        getMyMissions.mockResolvedValue([
            mission('Join 7 challenges', 2, 7),
            mission('Use Fill 3 times', 1, 3, { expiration_timestamp: NOW + 600 }),
        ]);
        const { missions } = await loadScenarioSnapshot(scenario([compare('missions.joinNeed')]), ctx());
        expect(getMyMissions).toHaveBeenCalledWith('tok');
        expect(missions).toEqual({
            readable: true,
            needs: { join: 5, fill: 2, turbo: 0, boost: 0, vote: 0 },
            unreadable: [],
            nextExpiry: NOW + 600,
            expiryUnreadable: false,
        });
    });

    test('a confirmed empty list is readable with no needs', async () => {
        const { missions } = await loadScenarioSnapshot(scenario([compare('missions.joinNeed')]), ctx());
        expect(missions).toMatchObject({ readable: true, needs: { join: 0, vote: 0 }, nextExpiry: null });
    });

    test('a failed read (null) is unreadable, never an empty list', async () => {
        getMyMissions.mockResolvedValue(null);
        const { missions } = await loadScenarioSnapshot(scenario([compare('missions.joinNeed')]), ctx());
        expect(missions).toEqual({ readable: false, reason: 'missions-unreadable' });
    });

    test('a pass whose endpoints carry no mission read is unavailable, not empty', async () => {
        api = {};
        const { missions } = await loadScenarioSnapshot(scenario([compare('missions.joinNeed')]), ctx());
        expect(missions).toEqual({ readable: false, reason: 'missions-unavailable' });
    });

    test('a throw is logged and unreadable', async () => {
        getMyMissions.mockRejectedValue(new Error('boom'));
        const { missions } = await loadScenarioSnapshot(scenario([compare('missions.joinNeed')]), ctx());
        expect(missions).toEqual({ readable: false, reason: 'missions-unreadable' });
        expect(warnings()).toEqual(['[7] could not read the missions for the scenario: boom']);
    });
});

describe('rewards', () => {
    const rewardScenario = scenario([present('rewards.claimable')]);

    test('a short page ends the listing: the claimable ids, the listed ids, complete', async () => {
        getMyCompletedChallenges.mockResolvedValue([completed(7, 'CLAIM'), completed(8, 'CLAIMED')]);
        const { rewards } = await loadScenarioSnapshot(rewardScenario, ctx());
        expect(getMyCompletedChallenges).toHaveBeenCalledWith('tok', 0, 20);
        expect(rewards).toEqual({ readable: true, listed: ['7', '8'], claimable: ['7'], complete: true });
    });

    test('a listing that reaches the page cap is not complete', async () => {
        const page = Array.from({ length: 20 }, (_, i) => completed(100 + i, 'CLAIMED'));
        getMyCompletedChallenges.mockResolvedValue(page);
        const { rewards } = await loadScenarioSnapshot(rewardScenario, ctx());
        expect(getMyCompletedChallenges).toHaveBeenCalledTimes(5);
        expect(rewards).toMatchObject({ readable: true, complete: false });
    });

    test('a page that was not read makes the whole read unreadable, even after claimable ones were seen', async () => {
        const page = [completed(7, 'CLAIM'), ...Array.from({ length: 19 }, (_, i) => completed(100 + i, 'CLAIMED'))];
        getMyCompletedChallenges.mockResolvedValueOnce(page).mockResolvedValueOnce(null);
        const { rewards } = await loadScenarioSnapshot(rewardScenario, ctx());
        expect(rewards).toEqual({ readable: false, reason: 'rewards-unreadable' });
    });

    test('a pass whose endpoints carry no completed-challenges read is unavailable, not empty', async () => {
        api = {};
        const { rewards } = await loadScenarioSnapshot(rewardScenario, ctx());
        expect(rewards).toEqual({ readable: false, reason: 'rewards-unavailable' });
    });

    test('a throw is logged and unreadable', async () => {
        getMyCompletedChallenges.mockRejectedValue(new Error('boom'));
        const { rewards } = await loadScenarioSnapshot(rewardScenario, ctx());
        expect(rewards).toEqual({ readable: false, reason: 'rewards-unreadable' });
        expect(warnings()).toEqual(['[7] could not read the completed challenges for the scenario: boom']);
    });
});

describe('the entry-age ledger', () => {
    const agesScenario = scenario([present('entry.minAge', { by: 'slot', index: 1 })]);
    const flagsScenario = scenario([present('entry.uncertainSubmission', { by: 'slot', index: 1 })]);
    const bothScenario = scenario([
        present('entry.minAge', { by: 'slot', index: 1 }),
        present('entry.uncertainSubmission', { by: 'slot', index: 1 }),
    ]);

    test('refreshes, then reads the times of the subject challenge', async () => {
        const evidence = await loadScenarioSnapshot(agesScenario, ctx());
        expect(ledger?.refresh).toHaveBeenCalledTimes(1);
        expect(evidence).toEqual({ entryAges: { readable: true, times: { a: { at: NOW - 600, exact: true } } } });
    });

    test('the uncertain ids are the subject entries the ledger marks', async () => {
        const evidence = await loadScenarioSnapshot(flagsScenario, ctx());
        expect(evidence).toEqual({ uncertain: { readable: true, ids: ['b'] } });
        expect(ledger?.isUncertain).toHaveBeenCalledWith('7', 'a');
    });

    test('both are read in one pass over the ledger when both are referenced', async () => {
        const evidence = await loadScenarioSnapshot(bothScenario, ctx());
        expect(ledger?.refresh).toHaveBeenCalledTimes(1);
        expect(Object.keys(evidence).sort()).toEqual(['entryAges', 'uncertain']);
    });

    test.each([
        ['a read that failed', { read: false, refresh: true }],
        ['a refresh that failed', { read: true, refresh: false }],
    ])('%s makes every referenced field unreadable, never an empty record', async (_label, health) => {
        ledger?.health.mockReturnValue(health);
        await expect(loadScenarioSnapshot(bothScenario, ctx())).resolves.toEqual({
            entryAges: { readable: false, reason: 'entry-ages-unreadable' },
            uncertain: { readable: false, reason: 'entry-ages-unreadable' },
        });
        await expect(loadScenarioSnapshot(agesScenario, ctx())).resolves.toEqual({
            entryAges: { readable: false, reason: 'entry-ages-unreadable' },
        });
        await expect(loadScenarioSnapshot(flagsScenario, ctx())).resolves.toEqual({
            uncertain: { readable: false, reason: 'entry-ages-unreadable' },
        });
    });

    test('a pass with no ledger is unavailable', async () => {
        ledger = null;
        await expect(loadScenarioSnapshot(agesScenario, ctx())).resolves.toEqual({
            entryAges: { readable: false, reason: 'entry-ages-unavailable' },
        });
    });

    test('a throw is logged and unreadable', async () => {
        ledger?.refresh.mockRejectedValue(new Error('prefs'));
        await expect(loadScenarioSnapshot(agesScenario, ctx())).resolves.toEqual({
            entryAges: { readable: false, reason: 'entry-ages-unreadable' },
        });
        expect(warnings()).toEqual(['[7] could not read the entry ages for the scenario: prefs']);
        ledger?.refresh.mockRejectedValue('plain');
        await loadScenarioSnapshot(agesScenario, ctx());
        expect(warnings()[1]).toBe('[7] could not read the entry ages for the scenario: plain');
    });
});

describe('pins and photo candidates', () => {
    test('the pins of the subject challenge', async () => {
        const evidence = await loadScenarioSnapshot(
            scenario([present('entry.pinned', { by: 'slot', index: 1 })]),
            ctx(),
        );
        expect(settings.getEntryPins).toHaveBeenCalledWith('7');
        expect(evidence).toEqual({ pins: { readable: true, boost: 'a', turbo: null } });
    });

    test('a pin read that throws is logged and unreadable', async () => {
        settings.getEntryPins.mockImplementation(() => {
            throw new Error('config');
        });
        const evidence = await loadScenarioSnapshot(
            scenario([present('entry.pinned', { by: 'slot', index: 1 })]),
            ctx(),
        );
        expect(evidence).toEqual({ pins: { readable: false, reason: 'pins-unreadable' } });
        expect(warnings()).toEqual(['[7] could not read the pinned photos for the scenario: config']);
    });

    test("the scan runs with the scheduled fill's tag settings, the pass token and its fill dependencies", async () => {
        settings.getEffectiveSetting.mockReturnValue(true);
        const evidence = await loadScenarioSnapshot(scenario([present('photos.hasEligible')]), ctx());
        expect(scanFillCandidates).toHaveBeenCalledWith({
            challenge: expect.objectContaining({ id: 7 }),
            token: 'tok',
            deps: { marker: 'fill-deps' },
            mustIncludeTags: ['sea'],
            shouldIncludeTags: ['light'],
            submitWithoutTagMatch: true,
        });
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('submitWithoutTagMatch', '7');
        expect(evidence).toEqual({ photoScan: { readable: true, eligible: 3, complete: true } });
    });

    test('an incomplete scan keeps its flag and reason', async () => {
        scanFillCandidates.mockResolvedValue({ eligible: 0, complete: false, firstReason: 'photo-read-failed' });
        const evidence = await loadScenarioSnapshot(scenario([present('photos.hasEligible')]), ctx());
        expect(evidence).toEqual({
            photoScan: { readable: true, eligible: 0, complete: false, firstReason: 'photo-read-failed' },
        });
    });

    test('a scan that throws is logged and unreadable, never zero', async () => {
        scanFillCandidates.mockRejectedValue(new Error('vision'));
        const evidence = await loadScenarioSnapshot(scenario([present('photos.hasEligible')]), ctx());
        expect(evidence).toEqual({ photoScan: { readable: false, reason: 'photo-scan-failed' } });
        expect(warnings()).toEqual(['[7] could not read the photo candidates for the scenario: vision']);
    });

    test('a non-Error throw is logged as it is', async () => {
        scanFillCandidates.mockRejectedValue('plain');
        await loadScenarioSnapshot(scenario([present('photos.hasEligible')]), ctx());
        expect(warnings()).toEqual(['[7] could not read the photo candidates for the scenario: plain']);
    });
});
