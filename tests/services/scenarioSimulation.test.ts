/**
 * The simulation coordinator's parts (services/scenarioRunner/simulation.ts): the controlled endpoints and what each assumed
 * outcome does to the world, the snapshots, the simulated settings, and how a run ends when something goes wrong. The whole
 * lifecycle against the live composition is in tests/integration/scenarioSimulationParity.test.ts.
 */

jest.mock('../../src/ts/core/logger', () => {
    const category = new Proxy({}, { get: () => () => {} });
    const named = {
        __esModule: true,
        withCategory: () => category,
        challengeTag: (challenge: { id?: unknown } | null | undefined) => `[Challenge ${challenge?.id}]`,
    };
    return new Proxy(named, { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}) });
});
jest.mock('../../src/ts/core/mock/strategy', () => {
    const actual = jest.requireActual<typeof mockStrategyModule>('../../src/ts/core/mock/strategy');
    return { ...actual, __esModule: true, createMockStrategy: jest.fn(actual.createMockStrategy) };
});
jest.mock('../../src/ts/core/services/installationTimezone', () => {
    const actual = jest.requireActual<typeof timezoneModule>('../../src/ts/core/services/installationTimezone');
    return { ...actual, __esModule: true, captureInstallationTimezone: jest.fn(actual.captureInstallationTimezone) };
});

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { buildChallenge } from '../helpers/challengeFixtures';
import { invalid } from '../helpers/invalid';
import settings = require('../../src/ts/core/settings');
import { noteSimulatedHalt } from '../../src/ts/core/simulationScope';
import type * as simulationModule from '../../src/ts/core/services/scenarioRunner/simulation';
import type * as mockStrategyModule from '../../src/ts/core/mock/strategy';
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as timezoneModule from '../../src/ts/core/services/installationTimezone';
import type { ConfigV2 } from '../../src/ts/core/types/config';
import type { Bankroll, Challenge, CompletedChallenge, LibraryPhoto } from '../../src/ts/core/types/gurushots';
import type { SimulationAssumptions, SimulationOperation, SimulationOutcome } from '../../src/ts/core/types/scenario';
import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';

const { applyFacts, controlledEndpoints, runSimulation, simulatedSettings, worldOf } =
    require('../../src/ts/core/services/scenarioRunner/simulation') as typeof simulationModule;
const { initialState, ledgerFor } = require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const strategyModule = jest.mocked(require('../../src/ts/core/mock/strategy') as typeof mockStrategyModule);
const timezone = jest.mocked(require('../../src/ts/core/services/installationTimezone') as typeof timezoneModule);

const NOW = 1_800_000_000;
const clock = { nowSec: () => NOW };
const BANKROLL: Bankroll = { keys: 1, swaps: 1, fills: 1, coins: 50 };
const photos = (): LibraryPhoto[] => [{ id: 'p1', labels: ['Pink'] }, { id: 'p2', labels: ['Blue'] }, { id: 'p3' }];

const active = (): Challenge =>
    buildChallenge({
        id: 7,
        title: 'Seven',
        close_time: NOW + 3600,
        member: {
            boost: { state: 'AVAILABLE' },
            ranking: { entries: [{ id: 'e1', member_id: 'm', votes: 3 }], exposure: { exposure_factor: 10 } },
        },
    });
const candidate = (extra: Record<string, unknown> = {}): Challenge =>
    buildChallenge({ id: 8, title: 'Open', close_time: NOW + 3600, member: { submit_state: 'join' }, ...extra });
const completed = (claimState = 'CLAIM'): CompletedChallenge =>
    invalid<CompletedChallenge>({
        id: 9,
        title: 'Done',
        member: {
            rewards_by_section: {
                claim_state: claimState,
                sections: [{ type: 'TOTAL', name: 'T', resources: [{ type: 'COINS', title: 'C', value: 1 }] }],
            },
        },
    });

const world = (patch: Partial<ReturnType<typeof worldOf>> = {}) => ({
    ...worldOf({ provenance: 'active-list', challenge: active(), bankroll: { ...BANKROLL } }),
    library: photos(),
    ...patch,
});
const all = (outcome: SimulationOutcome): NonNullable<SimulationAssumptions['outcomes']> =>
    Object.fromEntries(
        (['submit', 'join', 'claim', 'boost', 'turbo', 'swap', 'fill', 'keyUnlock'] as SimulationOperation[]).map(
            (operation) => [operation, outcome],
        ),
    );

beforeEach(() => {
    installHeadlessStore();
});

afterEach(() => {
    jest.clearAllMocks();
    removeHeadlessStore();
});

describe('the controlled reads: what the world shows, and what it does not know', () => {
    test('what is unknown is a failed read, never an invented answer', async () => {
        const { client } = controlledEndpoints(world({ bankroll: null, library: null }), {}, clock);
        expect(await client.authenticate('a', 'b')).toBeNull();
        expect(await client.getVoteImages(active(), 'tok')).toBeNull();
        expect(await client.submitVotes(invalid({ images: [] }), 'tok')).toBeUndefined();
        expect(await client.getLibrarySuggestedIds(7, 'tok')).toBeNull();
        expect(await client.getImageData('p1', 'tok')).toBeNull();
        expect(await client.getMyMissions('tok')).toBeNull();
        expect(await client.getCurrentMemberProfile('tok')).toBeNull();
        expect(await client.searchTagAutocomplete('tok', 'x', 'y')).toEqual([]);
        expect(await client.getSuggestedPhotoIds('tok', 7)).toEqual([]);
        expect(await client.getBankroll('tok')).toBeNull();
        expect(await client.getEligiblePhotos(7, 'tok')).toEqual([]);
        expect(await client.getEligiblePhotosWalk(7, 'tok')).toEqual({
            items: [],
            truncated: true,
            nextStart: 0,
            stop: 'failed',
        });
        expect(await client.getMemberChallenges('tok', 'upcoming')).toBeNull();
    });

    test('the lists: the subject’s own listing, the bankroll as a copy, completed pages', async () => {
        const subject = world({ candidate: candidate(), completed: completed(), active: null });
        const { client } = controlledEndpoints(subject, {}, clock);
        expect(await client.getActiveChallenges('tok')).toEqual({ challenges: [] });
        expect(await client.getMemberChallenges('tok', 'open')).toEqual([subject.candidate]);
        expect(await client.getMemberChallenges('tok')).toEqual([subject.candidate]);
        expect(await client.getMyCompletedChallenges('tok')).toEqual([subject.completed]);
        expect(await client.getMyCompletedChallenges('tok', 1, 20)).toEqual([]);
        const bankroll = await client.getBankroll('tok');
        expect(bankroll).toEqual(BANKROLL);
        expect(bankroll).not.toBe(subject.bankroll);
        const none = controlledEndpoints(world({ candidate: null, completed: null }), {}, clock).client;
        expect(await none.getMemberChallenges('tok', 'open')).toEqual([]);
        expect(await none.getMyCompletedChallenges('tok')).toEqual([]);
    });

    test('the library: photos already entered are left out, a search is an exact tag match, a walk skips what it is told to', async () => {
        const subject = world();
        const { client } = controlledEndpoints(subject, { submit: 'success' }, clock);
        expect((await client.getEligiblePhotos(7, 'tok')).map((photo) => photo.id)).toEqual(['p1', 'p2', 'p3']);
        expect((await client.getEligiblePhotos(7, 'tok', { search: ' pink ' })).map((photo) => photo.id)).toEqual([
            'p1',
        ]);
        await client.submitToChallenge(7, ['p1'], 'tok');
        expect((await client.getEligiblePhotos(7, 'tok')).map((photo) => photo.id)).toEqual(['p2', 'p3']);
        const walk = await client.getEligiblePhotosWalk(7, 'tok');
        expect(walk).toEqual({ items: [photos()[1], photos()[2]], truncated: false, nextStart: 2, stop: 'end' });
        const skipped = await client.getEligiblePhotosWalk(7, 'tok', { skip: (photo) => photo.id === 'p2' });
        expect(skipped).toEqual({
            items: [photos()[2]],
            skipped: ['p2'],
            truncated: false,
            nextStart: 2,
            stop: 'end',
        });
        const searched = await client.getEligiblePhotosWalk(7, 'tok', { search: 'blue' });
        expect(searched.items.map((photo) => photo.id)).toEqual(['p2']);
        // With no active challenge nothing is entered.
        const unjoined = controlledEndpoints(world({ active: null }), {}, clock).client;
        expect((await unjoined.getEligiblePhotos(7, 'tok')).map((photo) => photo.id)).toEqual(['p1', 'p2', 'p3']);
    });

    test('a photo whose submit landed shows among the challenge’s entries once, however often it is read', async () => {
        const subject = world();
        const { client } = controlledEndpoints(subject, { submit: 'success' }, clock);
        await client.submitToChallenge(7, ['p1'], 'tok');
        const first = await client.getActiveChallenges('tok');
        const second = await client.getActiveChallenges('tok');
        expect(first.challenges[0].member?.ranking?.entries?.map((entry) => entry.id)).toEqual(['e1', 'p1']);
        expect(second.challenges[0].member?.ranking?.entries).toHaveLength(2);
        // A ranking with no entries yet gets them.
        const empty = world({ active: invalid<Challenge>({ id: 7, member: { ranking: {} } }) });
        const emptyClient = controlledEndpoints(empty, { submit: 'success' }, clock).client;
        await emptyClient.submitToChallenge(7, ['p1'], 'tok');
        expect((await emptyClient.getActiveChallenges('tok')).challenges[0].member?.ranking?.entries).toEqual([
            { id: 'p1' },
        ]);
        // A challenge with no ranking to add to is shown as it is.
        const bare = world({ active: invalid<Challenge>({ id: 7 }) });
        const bareClient = controlledEndpoints(bare, { submit: 'success' }, clock).client;
        await bareClient.submitToChallenge(7, ['p1'], 'tok');
        expect((await bareClient.getActiveChallenges('tok')).challenges).toEqual([{ id: 7 }]);
    });
});

describe('the requests that change the account answer the assumed outcome', () => {
    const calls = (client: ReturnType<typeof controlledEndpoints>['client']) => [
        () => client.submitToChallenge(7, ['p1'], 'tok'),
        () => client.coinsUnlock(7, 'tok'),
        () => client.claimChallengeResources(9, 'tok'),
        () => client.claimMissionPrize('m1', 'tok'),
        () => client.applyBoostToEntry(7, 'e1', 'tok'),
        () => client.applyTurbo(7, 'e1', 'tok'),
        () => client.keyUnlock(7, 'tok'),
        () => client.swapPhoto(7, 'e1', 'p1', 'tok'),
        () => client.exposureAutofill(7, 'm', 'tok'),
        () => client.runTurboGame(active(), 'tok'),
        () => client.applyBoost(world().active as Challenge, 'tok'),
    ];

    test.each([
        ['success', true],
        ['refused', false],
        ['unclear', false],
    ] as const)('%s: each request answers as the real endpoint does, and the trace says so', async (outcome, ok) => {
        const { client, operations } = controlledEndpoints(world({ completed: completed() }), all(outcome), clock);
        const answers = await Promise.all(calls(client).map((call) => call()));
        expect(operations.map((operation) => [operation.operation, operation.outcome])).toEqual(
            [
                'submitToChallenge',
                'coinsUnlock',
                'claimChallengeResources',
                'claimMissionPrize',
                'applyBoostToEntry',
                'applyTurbo',
                'keyUnlock',
                'swapPhoto',
                'exposureAutofill',
                'runTurboGame',
                'applyBoost',
            ].map((endpoint) => [endpoint, outcome]),
        );
        expect(operations.every((operation) => operation.at === NOW)).toBe(true);
        expect(operations[3].subject).toBe('mission:m1');
        const [submit, unlock, claim, mission, boostEntry, turbo, key, swap, fill, game, boost] = answers;
        for (const answer of [submit, unlock, turbo, key, swap, fill]) {
            expect(answer).toEqual(
                ok
                    ? { ok: true, raw: { success: true } }
                    : outcome === 'refused'
                      ? { ok: false, raw: { success: false } }
                      : { ok: false, raw: null, unclear: true },
            );
        }
        expect([claim, mission]).toEqual([ok, ok]);
        expect(boostEntry).toEqual(ok ? { success: true } : null);
        expect(boost).toEqual(ok ? { success: true } : null);
        expect(game).toMatchObject({ kind: 'classic', won: ok, played: ok ? 1 : 0 });
    });

    test('an outcome that is not assumed does nothing, is not traced, and the first one needed is remembered', async () => {
        const { client, operations, need } = controlledEndpoints(world(), { claim: 'success' }, clock);
        expect(need()).toBeNull();
        expect(await client.submitToChallenge(7, ['p1'], 'tok')).toEqual({ ok: false, raw: null, unclear: true });
        await client.swapPhoto(7, 'e1', 'p1', 'tok');
        expect(operations).toEqual([]);
        expect(need()).toEqual({ operation: 'submit', subject: '7', at: NOW });
        // Nothing the request would have done was done.
        expect((await client.getActiveChallenges('tok')).challenges[0].member?.ranking?.entries).toHaveLength(1);
    });

    test('a submit that went through joins a candidate: it is an active challenge with that photo from then on', async () => {
        const subject = world({ active: null, candidate: candidate() });
        const { client } = controlledEndpoints(subject, { submit: 'success' }, clock);
        await client.submitToChallenge(8, ['p2'], 'tok');
        expect(subject.candidate).toBeNull();
        expect(await client.getMemberChallenges('tok', 'open')).toEqual([]);
        const joined = (await client.getActiveChallenges('tok')).challenges[0];
        expect(joined).toMatchObject({ id: 8, title: 'Open' });
        expect(joined.member?.ranking?.entries).toEqual([{ id: 'p2' }]);
        // A submit to some other challenge leaves the candidate where it is.
        const other = world({ active: null, candidate: candidate() });
        await controlledEndpoints(other, { submit: 'success' }, clock).client.submitToChallenge(99, ['p2'], 'tok');
        expect(other.candidate).not.toBeNull();
    });

    test('a coin unlock costs the price when it is known and the balance is; the other spends take one, never below nothing', async () => {
        const priced = world({ active: null, candidate: candidate({ join_coins: 30 }) });
        await controlledEndpoints(priced, { join: 'success' }, clock).client.coinsUnlock(8, 'tok');
        expect(priced.bankroll?.coins).toBe(20);
        const dear = world({ active: null, candidate: candidate({ join_coins: 500 }) });
        await controlledEndpoints(dear, { join: 'success' }, clock).client.coinsUnlock(8, 'tok');
        expect(dear.bankroll?.coins).toBe(0);
        const unpriced = world({ active: null, candidate: candidate() });
        await controlledEndpoints(unpriced, { join: 'success' }, clock).client.coinsUnlock(8, 'tok');
        expect(unpriced.bankroll?.coins).toBe(50);
        const unknown = world({ active: null, candidate: candidate({ join_coins: 5 }), bankroll: null });
        await controlledEndpoints(unknown, { join: 'success' }, clock).client.coinsUnlock(8, 'tok');
        expect(unknown.bankroll).toBeNull();

        const spent = world();
        const { client } = controlledEndpoints(
            spent,
            { keyUnlock: 'success', swap: 'success', fill: 'success' },
            clock,
        );
        await client.keyUnlock(7, 'tok');
        await client.swapPhoto(7, 'e1', 'p1', 'tok');
        await client.exposureAutofill(7, 'm', 'tok');
        await client.exposureAutofill(7, 'm', 'tok');
        expect(spent.bankroll).toEqual({ keys: 0, swaps: 0, fills: 0, coins: 50 });
        const unread = world({ bankroll: null });
        await controlledEndpoints(unread, { keyUnlock: 'success' }, clock).client.keyUnlock(7, 'tok');
        expect(unread.bankroll).toBeNull();
    });

    test('a claim that went through leaves nothing waiting, and credits nothing: its value is not known', async () => {
        const subject = world({ completed: completed(), bankroll: { ...BANKROLL } });
        const { client } = controlledEndpoints(subject, { claim: 'success' }, clock);
        await client.claimChallengeResources(9, 'tok');
        expect(subject.completed?.member?.rewards_by_section?.claim_state).toBe('CLAIMED');
        expect(subject.bankroll).toEqual(BANKROLL);
        // Already claimed, or no completed challenge at all: nothing to change.
        const claimed = world({ completed: completed('CLAIMED') });
        await controlledEndpoints(claimed, { claim: 'success' }, clock).client.claimChallengeResources(9, 'tok');
        expect(claimed.completed?.member?.rewards_by_section?.claim_state).toBe('CLAIMED');
        const none = world({ completed: null });
        await expect(
            controlledEndpoints(none, { claim: 'success' }, clock).client.claimChallengeResources(9, 'tok'),
        ).resolves.toBe(true);
        const bare = world({ completed: invalid<CompletedChallenge>({ id: 9 }) });
        await controlledEndpoints(bare, { claim: 'success' }, clock).client.claimChallengeResources(9, 'tok');
        expect(bare.completed).toEqual({ id: 9 });
    });

    test('a boost that went through uses the boost up; with no boost to use, nothing changes', async () => {
        const subject = world();
        await controlledEndpoints(subject, { boost: 'success' }, clock).client.applyBoost(
            subject.active as Challenge,
            'tok',
        );
        expect(subject.active?.member?.boost?.state).toBe('USED');
        const bare = world({ active: invalid<Challenge>({ id: 7, member: { ranking: { entries: [{ id: 'e1' }] } } }) });
        await controlledEndpoints(bare, { boost: 'success' }, clock).client.applyBoost(bare.active as Challenge, 'tok');
        expect(bare.active?.member?.boost).toBeUndefined();
        const gone = world({ active: null });
        await controlledEndpoints(gone, { boost: 'success' }, clock).client.applyBoost(
            world().active as Challenge,
            'tok',
        );
        expect(gone.active).toBeNull();
    });
});

describe('the snapshots replace what the subject’s kind shows', () => {
    test('the challenge goes where its kind lists it, as a copy; the bankroll and the library are replaced', () => {
        const facts = { challenge: active(), bankroll: { ...BANKROLL, coins: 9 }, library: photos() };
        const target = world({ active: null, library: null, bankroll: null });
        applyFacts(target, facts, { kind: 'active', challengeId: '7' });
        expect(target.active).toEqual(facts.challenge);
        expect(target.active).not.toBe(facts.challenge);
        expect(target.bankroll).toEqual({ ...BANKROLL, coins: 9 });
        expect(target.library).toEqual(photos());
        expect(target.library).not.toBe(facts.library);

        const candidates = world({ candidate: null });
        applyFacts(candidates, { challenge: candidate() }, { kind: 'candidate', challengeId: '8' });
        expect(candidates.candidate).toMatchObject({ id: 8 });
        const closed = world({ completed: null });
        applyFacts(closed, { challenge: invalid<Challenge>({ id: 9 }) }, { kind: 'completed', challengeId: '9' });
        expect(closed.completed).toEqual({ id: 9 });
        // An installation has no challenge to replace.
        const account = world({ active: null });
        applyFacts(account, { challenge: active() }, { kind: 'installation' });
        expect([account.active, account.candidate]).toEqual([null, null]);
        applyFacts(account, {}, { kind: 'installation' });
        expect(account.bankroll).toEqual(BANKROLL);
    });
});

describe('the simulated settings', () => {
    const doc = (name: string): ScenarioDocument => ({ name, version: 1, start: 'main', phases: { main: {} } });
    const config = (patch: Partial<ConfigV2> = {}): ConfigV2 => ({
        ...settings.loadSettings(),
        scenarios: { Plan: { name: 'Old' }, plan: { name: 'Old' }, Other: { name: 'Other' } },
        ...patch,
    });

    test('a draft replaces any stored scenario of its name, however it is cased, and is assigned to the challenge', () => {
        const before = config({ challenges: { '7': { suppressRuleProfile: true } } });
        const frozen = structuredClone(before);
        const patched = simulatedSettings(doc('PLAN'), 'draft', { kind: 'active', challengeId: '7' })(before);
        expect(Object.keys(patched.scenarios).sort()).toEqual(['Other', 'PLAN']);
        expect(patched.scenarios.PLAN).toEqual(doc('PLAN'));
        expect(patched.challenges['7']).toEqual({ suppressRuleProfile: true, values: { scenario: 'PLAN' } });
        expect(before).toEqual(frozen);
    });

    test('a stored scenario is only assigned; an existing record’s own values are kept', () => {
        const before = config({ challenges: { '7': { values: { exposure: 50 } } } });
        const patched = simulatedSettings(doc('Plan'), 'stored', { kind: 'completed', challengeId: '7' })(before);
        expect(patched.scenarios).toBe(before.scenarios);
        expect(patched.challenges['7'].values).toEqual({ exposure: 50, scenario: 'Plan' });
        const fresh = simulatedSettings(doc('Plan'), 'stored', { kind: 'candidate', challengeId: '8' })(before);
        expect(fresh.challenges['8']).toEqual({ values: { scenario: 'Plan' } });
    });

    test('for the installation it is the installation scenario of this runtime, at generation 0', () => {
        const patched = simulatedSettings({ ...doc('Whole'), scope: 'installation' }, 'draft', {
            kind: 'installation',
        })(config());
        expect(patched.installationScenario).toMatchObject({ scenario: 'Whole', generation: 0 });
        expect(patched.installationScenario?.executor).toEqual(expect.any(String));
    });
});

describe('how a run ends', () => {
    const scenario: ScenarioDocument = { name: 'Plan', version: 1, start: 'main', phases: { main: {} } };
    const input = (patch: Partial<simulationModule.SimulationInput> = {}): simulationModule.SimulationInput => ({
        scenario,
        source: 'draft',
        subject: { kind: 'active', challengeId: '7' },
        evidence: { provenance: 'active-list', challenge: active(), bankroll: BANKROLL },
        start: NOW,
        until: NOW + 600,
        assumptions: {},
        ...patch,
    });
    type Fake = (client: ReturnType<typeof controlledEndpoints>['client']) => Promise<unknown>;
    const fakeStrategy = (pass: Fake) =>
        strategyModule.createMockStrategy.mockImplementationOnce((client) =>
            invalid({ fetchChallengesAndVote: () => pass(client) }),
        );

    test('a time zone that cannot be read runs nothing, and says so', async () => {
        timezone.captureInstallationTimezone.mockReturnValueOnce(null);
        const run = await runSimulation(input());
        expect(run).toMatchObject({
            ok: true,
            result: { stopReason: 'halted', halted: 'timezone-unavailable', events: [], finalState: null, passes: [] },
        });
        expect(strategyModule.createMockStrategy).not.toHaveBeenCalled();
    });

    test('a second simulation while one runs is refused as busy, and the first still finishes', async () => {
        const release: { now: () => void } = { now: () => {} };
        fakeStrategy(
            () =>
                new Promise((resolve) => {
                    release.now = () => resolve({ success: true });
                }),
        );
        const first = runSimulation(input());
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(await runSimulation(input())).toEqual({ ok: false, error: 'simulation-busy' });
        release.now();
        expect(await first).toMatchObject({ ok: true, result: { stopReason: 'idle' } });
    });

    test('a pass that waits for a timer breaches the scope: halted, and nothing it computed is kept', async () => {
        fakeStrategy(async (client) => {
            await client.submitToChallenge(7, ['p1'], 'tok');
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { success: true };
        });
        const run = await runSimulation(input({ assumptions: { outcomes: { submit: 'success' } } }));
        expect(run).toEqual({
            ok: true,
            result: expect.objectContaining({
                stopReason: 'halted',
                halted: 'simulation-isolation-breached',
                events: [],
                finalState: null,
            }),
        });
    });

    test('a failure that is not an isolation breach is thrown on, after the scope is closed', async () => {
        fakeStrategy(async () => {
            throw new Error('boom');
        });
        await expect(runSimulation(input())).rejects.toThrow('boom');
        fakeStrategy(async () => {
            throw new Error('');
        });
        await expect(runSimulation(input())).rejects.toThrow();
        fakeStrategy(async () => ({ success: true }));
        await expect(runSimulation(input())).resolves.toMatchObject({ ok: true });
    });

    test('a cycle that did not succeed halts the run with its error, or with its own words when it gave none', async () => {
        fakeStrategy(async () => ({ success: false, error: 'the pass broke' }));
        expect(await runSimulation(input())).toMatchObject({
            ok: true,
            result: { stopReason: 'halted', halted: 'the pass broke' },
        });
        fakeStrategy(async () => ({ success: false }));
        expect(await runSimulation(input())).toMatchObject({
            ok: true,
            result: { stopReason: 'halted', halted: 'the cycle failed' },
        });
    });

    test('the pass that needed an outcome is undone even when it started the record: nothing of it is left', async () => {
        fakeStrategy(async (client) => {
            ledgerFor(false).set('7', initialState('Plan', 'main', NOW));
            await client.submitToChallenge(7, ['p1'], 'tok');
            return { success: true };
        });
        const run = await runSimulation(input());
        expect(run).toMatchObject({
            ok: true,
            result: {
                stopReason: 'needsEvidence',
                needs: { operation: 'submit', subject: '7', at: NOW },
                finalState: null,
                events: [],
            },
        });
    });

    test('a scenario that halts stops the run with its reason, from the runner’s own signal', async () => {
        fakeStrategy(async () => {
            // The runner records a halt like this: the state, its notice, and the signal to an open simulation.
            noteSimulatedHalt('7', 'Phase gone');
            ledgerFor(false).set('7', {
                ...initialState('Plan', 'main', NOW),
                outbox: [{ id: 'n', at: NOW, message: 'Halted: Phase gone' }],
            });
            return { success: true };
        });
        expect(await runSimulation(input())).toMatchObject({
            ok: true,
            result: { stopReason: 'halted', halted: 'Phase gone' },
        });
    });

    test.each([
        ['the installation’s', '@installation'],
        ['another challenge’s', '8'],
    ])('%s halt, told while this challenge runs, is not this run’s stop reason', async (_label, subject) => {
        fakeStrategy(async () => {
            // A challenge run still runs the installation's stage (and any other challenge of the pass): their halts are theirs.
            noteSimulatedHalt(subject, 'balance binding could not resolve');
            return { success: true };
        });
        const run = await runSimulation(input());
        expect(run.ok && run.result.stopReason).not.toBe('halted');
        expect(run.ok && run.result.halted).toBeNull();
    });

    test('a notice the scenario wrote is never a halt, whatever its text says', async () => {
        fakeStrategy(async () => {
            ledgerFor(false).set('7', {
                ...initialState('Plan', 'main', NOW),
                outbox: [{ id: 'n', at: NOW, message: 'Halted: Check the light' }],
            });
            return { success: true };
        });
        const run = await runSimulation(input());
        expect(run.ok && run.result.stopReason).not.toBe('halted');
        expect(run.ok && run.result.halted).toBeNull();
        expect(run.ok && run.result.events).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: 'notice', message: 'Halted: Check the light' })]),
        );
    });

    test('what the run used is stated, with where each value came from; an unreadable bankroll is said to be unknown', async () => {
        fakeStrategy(async () => ({ success: true }));
        const run = await runSimulation(
            input({ evidence: { provenance: 'active-list', challenge: active(), bankroll: null } }),
        );
        expect(run.ok && run.result.diagnostics).toEqual(
            expect.arrayContaining([
                { key: 'bankroll', value: 'unknown', provenance: 'read failed; not assumed' },
                { key: 'subject', value: '7', provenance: 'active-list' },
                { key: 'scenario', value: 'Plan', provenance: 'draft' },
            ]),
        );
        fakeStrategy(async () => ({ success: true }));
        const read = await runSimulation(input({ source: 'stored' }));
        expect(read.ok && read.result.diagnostics).toEqual(
            expect.arrayContaining([
                { key: 'bankroll', value: 'read', provenance: 'account read before the run' },
                { key: 'scenario', value: 'Plan', provenance: 'saved scenario' },
            ]),
        );
    });

    test('a run that fills its event bound ends as limit', async () => {
        fakeStrategy(async (client) => {
            for (let index = 0; index < 50; index++) await client.submitToChallenge(7, [`p${index}`], 'tok');
            return { success: true };
        });
        const run = await runSimulation(input({ assumptions: { outcomes: { submit: 'success' } } }));
        expect(run).toMatchObject({ ok: true, result: { stopReason: 'limit' } });
        expect(run.ok && run.result.events).toHaveLength(200);
    });

    test('a snapshot is a boundary of its own: the run goes to its instant and the pass there sees it', async () => {
        const seen: number[] = [];
        fakeStrategy(async (client) => {
            seen.push((await client.getBankroll('tok'))?.coins ?? -1);
            return { success: true };
        });
        const run = await runSimulation(
            input({ assumptions: { snapshots: [{ at: NOW + 60, facts: { bankroll: { ...BANKROLL, coins: 7 } } }] } }),
        );
        expect(run).toMatchObject({ ok: true, result: { passes: [NOW, NOW + 60] } });
        expect(seen).toEqual([50, 7]);
    });
});
