/**
 * The lifecycle of a scenario assignment: the gate every change of an assignment or a definition runs under, the
 * handoff to another scenario and its recovery, the revision of the collection of definitions, and the priority Stop
 * fence. Drives the in-memory headless seam, with the cross-process locks replaced by a registry the tests can hold.
 */

jest.mock('../../src/ts/core/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        api: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
        withCategory: jest.fn(() => category),
    };
});
jest.mock('../../src/ts/core/joinStateStore', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/joinStateStore')>('../../src/ts/core/joinStateStore'),
}));
jest.mock('../../src/ts/core/services/currencyActions', () => ({
    withSpendLock: jest.fn(async (spend: () => Promise<unknown>) => ({ busy: false, value: await spend() })),
    previewSwap: jest.fn(),
    swapEntry: jest.fn(),
    unlockBoostWithKey: jest.fn(),
    fillExposure: jest.fn(),
}));
jest.mock('../../src/ts/core/services/autoFill', () => ({
    submitNewEntryForAction: jest.fn(),
    refreshChallengeState: jest.fn(async () => 'refreshed'),
    reflectNewEntry: jest.fn(),
    reflectEntryFlag: jest.fn(),
    getSlotsRemaining: jest.fn(),
}));

import settings = require('../../src/ts/core/settings');
import joinStateStore = require('../../src/ts/core/joinStateStore');
import storageModule = require('../../src/ts/core/settings/storage');
import currencyActionsModule = require('../../src/ts/core/services/currencyActions');
const currencyActions = jest.mocked(currencyActionsModule);
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as scenarioLifecycleModule from '../../src/ts/core/settings/scenarioLifecycle';
import type * as runnerModule from '../../src/ts/core/services/scenarioRunner';
import type { ConfigV2 } from '../../src/ts/core/types/config';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioState } from '../../src/ts/core/types/stores';
import { isConfig } from '../helpers/storedShapes';
import { parseJsonAs, parseJsonObject } from '../helpers/parseJson';
import { isPlainObject } from '../../src/ts/core/plainObject';
import { invalid } from '../helpers/invalid';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';

const { scenarioStateLedger, mockScenarioStateLedger, initialState, INSTALLATION_KEY } =
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const { runScenarioStep } = require('../../src/ts/core/services/scenarioRunner') as typeof runnerModule;

const STATE_KEY = 'gs_scenario_state';
const FENCE_KEY = 'gs_scenario_stop_fence';
const NOW = Math.floor(Date.now() / 1000);

const simple = (name: string, extra: object = {}) => ({
    name,
    version: 1,
    start: 'main',
    phases: {
        main: { rules: [{ id: 'fill', do: [{ type: 'fillExposure' }, { type: 'notify', message: 'filled' }] }] },
    },
    ...extra,
});
const installationDoc = (name: string, extra: object = {}) => ({
    name,
    version: 1,
    scope: 'installation',
    start: 'main',
    phases: { main: { settings: { autoClaimPrizes: true } } },
    ...extra,
});

let store: MemoryStore;
// The cross-process locks, as a registry: a held id is busy; every grant is released again.
let held: Set<string>;
let events: string[];
// Something another writer does at the moment a lock is asked for (a change that lands between two steps of a change).
let onLock: ((id: string) => void) | null;

const blob = (): ConfigV2 => parseJsonAs(store.value!, isConfig);
const record = (key: string): ScenarioState | null => scenarioStateLedger.get(key).state;
const revision = (): number | null => settings.getScenarioLibrary().revision;
const seed = (key: string, patch: Partial<ScenarioState> = {}, scenario = 'Plan') => {
    const written = scenarioStateLedger.change(key, () => ({ ...initialState(scenario, 'main', NOW), ...patch }));
    expect(written.ok).toBe(true);
};

/** Makes the writes of one stored key fail, as the native bridge does when it does not persist them. */
const failWrites = (key: string, which: number[]) => {
    let seen = 0;
    const real = store.writeKey?.bind(store);
    store.writeKey = (written, data) => {
        if (written === key) {
            seen += 1;
            if (which.includes(seen)) return false;
        }
        return real?.(written, data) ?? false;
    };
};

const challenge = () =>
    invalid<Challenge>({
        id: 7,
        start_time: NOW - 86400,
        close_time: NOW + 5 * 86400,
        max_photo_submits: 4,
        member: {
            boost: { state: 'AVAILABLE' },
            turbo: { state: 'WON', mode: 'classic' },
            ranking: {
                entries: [{ id: 'a', votes: 10, rank: 20, member_id: 'm' }],
                exposure: { exposure_factor: 30 },
                swaps: [],
            },
        },
    });

/** One pass's step for challenge 7 over the real settings and the real ledger. */
const runStep = async () =>
    runScenarioStep(
        challenge(),
        NOW,
        invalid({
            token: 'tok',
            api: {},
            fillDeps: {},
            currency: { strategy: { getBankroll: jest.fn(async () => ({ keys: 5, swaps: 5, fills: 5, coins: 0 })) } },
            scenarios: { ledger: scenarioStateLedger },
        }),
    );

beforeEach(async () => {
    jest.clearAllMocks();
    store = installHeadlessStore();
    // The stores keep what they last read: a store of the last test is not this one's.
    await storageModule.discardPendingWrites();
    storageModule.resumeWrites();
    held = new Set();
    events = [];
    onLock = null;
    jest.spyOn(joinStateStore, 'acquireUnlockLock').mockImplementation((id) => {
        const key = String(id);
        onLock?.(key);
        if (held.has(key)) return { ok: false, release: () => {} };
        held.add(key);
        return {
            ok: true,
            release: () => {
                held.delete(key);
                events.push(`release ${key}`);
            },
        };
    });
    currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
    settings.rememberChallengeTitles([{ id: 7, title: 'Big show', type: 'exhibition' }]);
});

afterEach(() => {
    const leaked = [...held];
    jest.restoreAllMocks();
    removeHeadlessStore();
    settings.rememberChallengeTitles([]);
    // No change leaves a lock behind, whatever it came to.
    expect(leaked).toEqual([]);
});

/** Challenge 7 runs Plan, with progress. */
const assigned = (patch: Partial<ScenarioState> = {}) => {
    expect(settings.saveScenario(simple('Plan')).ok).toBe(true);
    expect(settings.saveScenario(simple('Next')).ok).toBe(true);
    expect(settings.setChallengeOverride('scenario', '7', 'Plan')).toBe(true);
    seed('7', patch);
};

describe('the lifecycle gate', () => {
    test('a change is refused while another holds the gate, and nothing is written', () => {
        assigned();
        held.add('scenario-mutation');
        const before = store.value;
        expect(settings.saveScenario(simple('Plan'), { expectedDefinitionRevision: revision()! })).toMatchObject({
            ok: false,
            reason: 'busy',
        });
        expect(store.value).toBe(before);
        held.delete('scenario-mutation');
    });

    test('a subject whose step is running makes the whole change busy, and every lock taken is let go', () => {
        assigned();
        // Challenge 8 names Plan too; its step lock is the one that is busy, after 7's was taken.
        settings.setChallengeOverride('scenario', '8', 'Plan');
        held.add('scenario-8');
        const before = store.value;
        events.length = 0;
        expect(settings.saveScenario(simple('Plan'), { expectedDefinitionRevision: revision()! })).toMatchObject({
            ok: false,
            reason: 'busy',
        });
        expect(store.value).toBe(before);
        // Released in the reverse of the order they were taken in: 7, then the gate (8 was never granted).
        expect(events.filter((event) => event !== 'release scenariostate')).toEqual([
            'release scenario-7',
            'release scenario-mutation',
        ]);
        held.delete('scenario-8');
    });

    test('the step locks are tried in a stable subject order: the installation first, then the challenges', () => {
        assigned();
        settings.setChallengeOverride('scenario', '12', 'Plan');
        settings.setChallengeOverride('scenario', '9', 'Plan');
        const taken: string[] = [];
        jest.mocked(joinStateStore.acquireUnlockLock).mockImplementation((id) => {
            taken.push(String(id));
            return { ok: true, release: () => {} };
        });
        settings.saveScenario(simple('Plan'), { expectedDefinitionRevision: revision()! });
        expect(taken.filter((id) => /^scenario-\d+$/.test(id))).toEqual(['scenario-12', 'scenario-7', 'scenario-9']);
    });

    test('an assignment that appears after the locks were taken makes the change busy', () => {
        assigned();
        // A writer outside the gate adds a reference while the first lock is being taken.
        jest.mocked(joinStateStore.acquireUnlockLock).mockImplementation((id) => {
            if (String(id) === 'scenario-7') {
                const raw = blob();
                raw.challenges['9'] = { values: { scenario: 'Plan' } };
                store.value = JSON.stringify(raw);
            }
            return { ok: true, release: () => {} };
        });
        const scenariosBefore = JSON.stringify(blob().scenarios);
        const revisionBefore = revision();
        expect(settings.saveScenario(simple('Plan'), { expectedDefinitionRevision: revisionBefore! })).toMatchObject({
            ok: false,
            reason: 'busy',
        });
        expect(JSON.stringify(blob().scenarios)).toBe(scenariosBefore);
        expect(revision()).toBe(revisionBefore);
    });

    test('progress that cannot be read refuses a change of a scenario that exists, whole-file or one record', () => {
        assigned();
        store.keys.set(STATE_KEY, '{broken');
        expect(settings.saveScenario(simple('Plan'), { expectedDefinitionRevision: revision()! })).toMatchObject({
            ok: false,
            reason: 'state-unreadable',
        });
        store.keys.set(STATE_KEY, JSON.stringify({ '8': { scenario: 5 } }));
        expect(settings.saveScenario(simple('Plan'), { expectedDefinitionRevision: revision()! })).toMatchObject({
            ok: false,
            reason: 'state-unreadable',
        });
    });

    test.each([
        ['a rule in progress', { inFlight: { ruleId: 'fill', actionIndex: 1 } }],
        ['a pending spend', { inFlight: { ruleId: 'fill', actionIndex: 0, pending: 'fillExposure' as const } }],
        ['an unclear spend', { inFlight: { ruleId: 'fill', actionIndex: 0, unclear: ['fillExposure' as const] } }],
        ['a rule stopped for an unclear spend', { fired: { fill: { at: 1, unclearHalt: 'fillExposure' as const } } }],
        ['a handoff begun', { handoff: { from: 'Plan', to: 'Next', generation: 0, at: NOW } }],
    ])('%s refuses the replacement; progress, scenarios and revision stay as they were', (label, patch) => {
        assigned(patch);
        const revisionBefore = revision();
        const ledgerBefore = store.keys.get(STATE_KEY);
        const configBefore = store.value;
        const reordered = simple('Plan', {
            phases: {
                main: {
                    rules: [{ id: 'fill', do: [{ type: 'notify', message: 'filled' }, { type: 'fillExposure' }] }],
                },
            },
        });
        expect(settings.saveScenario(reordered, { expectedDefinitionRevision: revisionBefore! })).toMatchObject({
            ok: false,
            reason: 'unresolved-work',
        });
        expect(store.keys.get(STATE_KEY)).toBe(ledgerBefore);
        expect(store.value).toBe(configBefore);
        expect(revision()).toBe(revisionBefore);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('an idle subject lets the replacement through', () => {
        assigned();
        const reordered = simple('Plan', {
            phases: {
                main: {
                    rules: [{ id: 'fill', do: [{ type: 'notify', message: 'filled' }, { type: 'fillExposure' }] }],
                },
            },
        });
        expect(settings.saveScenario(reordered, { expectedDefinitionRevision: revision()! }).ok).toBe(true);
        expect(settings.getScenario('Plan')?.phases.main.rules?.[0].do[0].type).toBe('notify');
    });

    test('a replacement by case-only name or import-overwrite is held the same way', () => {
        assigned({ inFlight: { ruleId: 'fill', actionIndex: 1 } });
        const text = JSON.stringify(simple('PLAN'));
        expect(
            settings.importScenario(text, { overwrite: true, expectedDefinitionRevision: revision()! }),
        ).toMatchObject({ ok: false, reason: 'unresolved-work' });
        expect(settings.saveScenario(simple('PLAN'), { expectedDefinitionRevision: revision()! })).toMatchObject({
            ok: false,
            reason: 'unresolved-work',
        });
        expect(Object.keys(settings.getScenarios()).sort()).toEqual(['Next', 'Plan']);
    });

    test('a progress record that names the scenario is held even when no assignment names it any more', () => {
        expect(settings.saveScenario(simple('Plan')).ok).toBe(true);
        seed('31', { inFlight: { ruleId: 'fill', actionIndex: 1 } });
        expect(settings.saveScenario(simple('Plan'), { expectedDefinitionRevision: revision()! })).toMatchObject({
            reason: 'unresolved-work',
        });
        // A record of another scenario is none of its business.
        seed('31', { inFlight: { ruleId: 'fill', actionIndex: 1 } }, 'Other');
        expect(settings.saveScenario(simple('Plan'), { expectedDefinitionRevision: revision()! }).ok).toBe(true);
    });

    test('a save that names a new scenario needs no subject and no progress read', () => {
        store.keys.set(STATE_KEY, '{broken');
        expect(settings.saveScenario(simple('Fresh')).ok).toBe(true);
    });

    test('a scope another reference cannot use is refused: challenges need a challenge scenario, the installation its own', () => {
        assigned();
        expect(
            settings.saveScenario(installationDoc('Plan'), { expectedDefinitionRevision: revision()! }),
        ).toMatchObject({ ok: false, reason: 'incompatible-scope' });
        expect(settings.saveScenario(installationDoc('Inst')).ok).toBe(true);
        expect(settings.setInstallationScenario('Inst', 'electron', 0).ok).toBe(true);
        expect(settings.saveScenario(simple('Inst'), { expectedDefinitionRevision: revision()! })).toMatchObject({
            ok: false,
            reason: 'incompatible-scope',
        });
        // An assignment to a name that is not stored yet is a reference too.
        settings.setChallengeOverride('scenario', '8', 'Later');
        expect(settings.saveScenario(installationDoc('Later'))).toMatchObject({
            ok: false,
            reason: 'incompatible-scope',
        });
        expect(settings.getScenario('Later')).toBeNull();
    });

    test('a profile and a rule that name the scenario are references too', () => {
        expect(settings.saveScenario(simple('Plan')).ok).toBe(true);
        settings.saveChallengeProfile('Tactic', { scenario: 'Plan' });
        expect(
            settings.saveScenario(installationDoc('Plan'), { expectedDefinitionRevision: revision()! }),
        ).toMatchObject({ reason: 'incompatible-scope' });
        settings.deleteChallengeProfile('Tactic');
        settings.setTitleRules([{ type: 'exhibition', scenario: 'Plan' }]);
        expect(
            settings.saveScenario(installationDoc('Plan'), { expectedDefinitionRevision: revision()! }),
        ).toMatchObject({ reason: 'incompatible-scope' });
    });
});

describe('the revision of the collection of definitions', () => {
    test('it starts at 0 and advances with every save, import over a name, rename and delete — in the same write', () => {
        expect(revision()).toBe(0);
        const writes = () => store.write.mock.calls.length;
        let before = writes();
        expect(settings.saveScenario(simple('A')).ok).toBe(true);
        expect(writes() - before).toBe(1);
        expect(revision()).toBe(1);
        // The scenario and its revision are in the one text that was written.
        expect(blob().scenarioDefinitionsRevision).toBe(1);
        expect(Object.keys(blob().scenarios)).toEqual(['A']);
        expect(settings.saveScenario(simple('A', { description: 'v2' }), { expectedDefinitionRevision: 1 }).ok).toBe(
            true,
        );
        expect(revision()).toBe(2);
        expect(
            settings.importScenario(JSON.stringify(simple('A', { description: 'v3' })), {
                overwrite: true,
                expectedDefinitionRevision: 2,
            }).ok,
        ).toBe(true);
        expect(revision()).toBe(3);
        before = writes();
        expect(settings.renameScenario('A', 'B').ok).toBe(true);
        expect(writes() - before).toBe(1);
        expect(revision()).toBe(4);
        expect(settings.deleteScenario('B')).toEqual({ ok: true });
        expect(revision()).toBe(5);
        expect(blob().scenarioDefinitionsRevision).toBe(5);
    });

    test('an overwrite names the revision it was edited on: a stale or missing one is a conflict and changes nothing', () => {
        expect(settings.saveScenario(simple('A')).ok).toBe(true);
        const before = store.value;
        expect(
            settings.saveScenario(simple('A', { description: 'x' }), { expectedDefinitionRevision: 0 }),
        ).toMatchObject({
            ok: false,
            reason: 'conflict',
        });
        expect(settings.saveScenario(simple('A', { description: 'x' }))).toMatchObject({ reason: 'conflict' });
        expect(
            settings.importScenario(JSON.stringify(simple('A')), { overwrite: true, expectedDefinitionRevision: 7 }),
        ).toMatchObject({ reason: 'conflict' });
        expect(store.value).toBe(before);
    });

    test('two editors that both loaded revision 1: the first save lands, the second is a conflict and loses nothing', () => {
        expect(settings.saveScenario(simple('A')).ok).toBe(true);
        const loadedByBoth = revision()!;
        expect(
            settings.saveScenario(simple('A', { description: 'first' }), { expectedDefinitionRevision: loadedByBoth })
                .ok,
        ).toBe(true);
        expect(
            settings.saveScenario(simple('A', { description: 'second' }), { expectedDefinitionRevision: loadedByBoth }),
        ).toMatchObject({ ok: false, reason: 'conflict' });
        expect(settings.getScenario('A')?.description).toBe('first');
        // The loser reloads and tries again on what the other left.
        expect(
            settings.saveScenario(simple('A', { description: 'second' }), { expectedDefinitionRevision: revision()! })
                .ok,
        ).toBe(true);
    });

    test('a new name needs no revision, an unexpected one on a rename or delete is checked when it is given', () => {
        expect(settings.saveScenario(simple('A')).ok).toBe(true);
        expect(settings.renameScenario('A', 'B', { expectedDefinitionRevision: 9 })).toMatchObject({
            reason: 'conflict',
        });
        expect(settings.deleteScenario('A', { expectedDefinitionRevision: 9 })).toEqual({
            ok: false,
            reason: 'conflict',
        });
        expect(settings.renameScenario('A', 'B', { expectedDefinitionRevision: revision()! }).ok).toBe(true);
        expect(settings.deleteScenario('B', { expectedDefinitionRevision: revision()! })).toEqual({ ok: true });
    });

    test.each([['abc'], [-1], [1.5], [Number.MAX_SAFE_INTEGER], [null]])(
        'a malformed revision (%p) is an error, never 0: every change of the collection is refused',
        (bad) => {
            expect(settings.saveScenario(simple('A')).ok).toBe(true);
            const raw = blob();
            Object.assign(raw, { scenarioDefinitionsRevision: bad });
            store.value = JSON.stringify(raw);
            const before = store.value;
            expect(settings.getScenarioLibrary().revision).toBeNull();
            expect(settings.saveScenario(simple('B'))).toMatchObject({ ok: false, reason: 'revision-unreadable' });
            expect(settings.saveScenario(simple('A'), { expectedDefinitionRevision: 0 })).toMatchObject({
                reason: 'revision-unreadable',
            });
            expect(settings.renameScenario('A', 'C')).toMatchObject({ reason: 'revision-unreadable' });
            expect(settings.deleteScenario('A')).toEqual({ ok: false, reason: 'revision-unreadable' });
            expect(store.value).toBe(before);
        },
    );

    test('a refused change keeps the caller draft: nothing is written, so a retry on the same draft can succeed', () => {
        assigned({ inFlight: { ruleId: 'fill', actionIndex: 1 } });
        const draft = simple('Plan', { description: 'edited' });
        const before = store.value;
        expect(settings.saveScenario(draft, { expectedDefinitionRevision: revision()! })).toMatchObject({
            reason: 'unresolved-work',
        });
        expect(store.value).toBe(before);
        seed('7', {});
        expect(settings.saveScenario(draft, { expectedDefinitionRevision: revision()! }).ok).toBe(true);
    });
});

describe('rename and delete', () => {
    test('a rename moves the progress record with its markers; nothing else of it changes', () => {
        assigned({
            memory: { held: 'z' },
            fired: { fill: { at: 5 } },
            spent: { swaps: 1, keys: 2, fills: 3 },
            history: { a: [[1, 2]] },
            lastAction: { at: 4, ruleId: 'fill', action: 'fillExposure', outcome: 'done' },
        });
        const generation = record('7')?.generation;
        const before = record('7')!;
        expect(settings.renameScenario('Plan', 'Moved').ok).toBe(true);
        const after = record('7')!;
        expect(after.scenario).toBe('Moved');
        expect({ ...after, scenario: '', updatedAt: 0, epoch: undefined }).toEqual({
            ...before,
            scenario: '',
            updatedAt: 0,
            epoch: undefined,
        });
        expect(after.generation).toBe(generation);
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Moved');
    });

    test('a rename moves the installation assignment and record, and keeps their generation', () => {
        expect(settings.saveScenario(installationDoc('Inst')).ok).toBe(true);
        expect(settings.setInstallationScenario('Inst', 'cli', 0).ok).toBe(true);
        expect(settings.renameScenario('Inst', 'Whole').ok).toBe(true);
        expect(settings.getInstallationScenario()).toEqual({ scenario: 'Whole', executor: 'cli', generation: 1 });
        expect(record(INSTALLATION_KEY)).toMatchObject({ scenario: 'Whole', generation: 1 });
    });

    test('a rename is refused while a subject has unresolved work, and moves nothing', () => {
        assigned({ inFlight: { ruleId: 'fill', actionIndex: 0, pending: 'fillExposure' } });
        const ledgerBefore = store.keys.get(STATE_KEY);
        expect(settings.renameScenario('Plan', 'Moved')).toMatchObject({ ok: false, reason: 'unresolved-work' });
        expect(store.keys.get(STATE_KEY)).toBe(ledgerBefore);
        expect(Object.keys(settings.getScenarios()).sort()).toEqual(['Next', 'Plan']);
    });

    test('a rename whose progress cannot be moved is undone: every record keeps its name, nothing is saved', () => {
        assigned();
        settings.setChallengeOverride('scenario', '8', 'Plan');
        seed('8');
        const configBefore = store.value;
        // Both records are moved by one write each; the second one fails.
        failWrites(STATE_KEY, [2]);
        expect(settings.renameScenario('Plan', 'Moved')).toMatchObject({ ok: false, reason: 'state-unreadable' });
        expect(record('7')?.scenario).toBe('Plan');
        expect(record('8')?.scenario).toBe('Plan');
        expect(store.value).toBe(configBefore);
    });

    test('a rename whose configuration cannot be saved gives the progress its name back', () => {
        assigned();
        store.write.mockReturnValueOnce(false);
        expect(settings.renameScenario('Plan', 'Moved')).toMatchObject({ ok: false });
        expect(record('7')?.scenario).toBe('Plan');
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Plan');
    });

    test('a rename onto a name another scenario has is refused; a casing change is fine', () => {
        assigned();
        expect(settings.renameScenario('Plan', 'Next')).toMatchObject({ ok: false });
        expect(settings.renameScenario('Plan', 'PLAN').ok).toBe(true);
        expect(settings.renameScenario('Missing', 'Other')).toMatchObject({ ok: false });
    });

    test('a delete clears the assignments of the scenario, and fences the installation owner', () => {
        assigned();
        expect(settings.saveScenario(installationDoc('Inst')).ok).toBe(true);
        expect(settings.setInstallationScenario('Inst', 'web', 0).ok).toBe(true);
        seed(INSTALLATION_KEY, { generation: 1, memory: { held: 'z' } }, 'Inst');
        expect(settings.deleteScenario('Plan')).toEqual({ ok: true });
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('');
        expect(record('7')?.scenario).toBe('Plan');
        expect(settings.deleteScenario('Inst')).toEqual({ ok: true });
        expect(settings.getInstallationScenario()).toBeNull();
        // The record keeps its progress; only its generation moved, so a former owner fails its next write.
        expect(record(INSTALLATION_KEY)).toMatchObject({ scenario: 'Inst', generation: 2, memory: { held: 'z' } });
        expect(settings.installationGeneration()).toBe(2);
    });

    test('a delete of the installation scenario with no record yet creates the counter record', () => {
        expect(settings.saveScenario(installationDoc('Inst')).ok).toBe(true);
        const raw = blob();
        raw.installationScenario = { scenario: 'Inst', executor: 'cli', generation: 3 };
        store.value = JSON.stringify(raw);
        expect(settings.deleteScenario('Inst')).toEqual({ ok: true });
        expect(record(INSTALLATION_KEY)).toMatchObject({ scenario: '', generation: 4 });
    });

    test('a delete of the installation scenario counts on from a record that has no generation yet', () => {
        expect(settings.saveScenario(installationDoc('Inst')).ok).toBe(true);
        const raw = blob();
        raw.installationScenario = { scenario: 'Inst', executor: 'cli', generation: 2 };
        store.value = JSON.stringify(raw);
        seed(INSTALLATION_KEY, {}, 'Inst');
        expect(settings.deleteScenario('Inst')).toEqual({ ok: true });
        expect(record(INSTALLATION_KEY)?.generation).toBe(3);
    });

    test('a delete whose fence cannot be written, or whose configuration cannot be saved, says so', () => {
        expect(settings.saveScenario(installationDoc('Inst')).ok).toBe(true);
        expect(settings.setInstallationScenario('Inst', 'web', 0).ok).toBe(true);
        const real = store.writeKey;
        store.writeKey = () => false;
        expect(settings.deleteScenario('Inst')).toEqual({ ok: false, reason: 'not-saved' });
        store.writeKey = real;
        held.add('scenariostate');
        expect(settings.deleteScenario('Inst')).toEqual({ ok: false, reason: 'busy' });
        held.delete('scenariostate');
        // The progress stops being readable while the fence is written.
        onLock = (id) => {
            if (id === 'scenariostate') store.keys.set(STATE_KEY, '{broken');
        };
        expect(settings.deleteScenario('Inst')).toEqual({ ok: false, reason: 'state-unreadable' });
        expect(settings.getScenario('Inst')).not.toBeNull();
    });

    test('a delete is held by unresolved work of a record that names the scenario', () => {
        expect(settings.saveScenario(simple('Plan')).ok).toBe(true);
        seed('31', { inFlight: { ruleId: 'fill', actionIndex: 1 } });
        expect(settings.deleteScenario('Plan')).toEqual({ ok: false, reason: 'unresolved-work' });
    });
});

describe('profile, rule and override writes of a scenario assignment', () => {
    test('the writes that do not move an assignment never take the gate', () => {
        assigned();
        jest.mocked(joinStateStore.acquireUnlockLock).mockClear();
        expect(settings.setChallengeOverride('exposure', '7', 70)).toBe(true);
        expect(settings.setTitleRules([{ type: 'exhibition', autoSubmit: true }])).toBe(true);
        expect(settings.saveChallengeProfile('Plain', { autoSubmit: true })).toBe(true);
        expect(settings.deleteChallengeProfile('Plain')).toBe(true);
        expect(joinStateStore.acquireUnlockLock).not.toHaveBeenCalled();
    });

    test('moving the scenario of a challenge with unresolved work is refused, by every write that can', () => {
        assigned({ inFlight: { ruleId: 'fill', actionIndex: 1 } });
        settings.saveChallengeProfile('Tactic', { scenario: 'Next' });
        const before = store.value;
        expect(settings.setChallengeOverride('scenario', '7', 'Next')).toBe(false);
        expect(settings.setChallengeOverrides('7', { scenario: 'Next' })).toBe(false);
        expect(settings.removeChallengeOverride('scenario', '7')).toBe(false);
        expect(settings.replaceChallengeOverrides('7', { scenario: 'Next' }, false)).toBe(false);
        expect(settings.applyChallengeProfile('Tactic', '7')).toBe(false);
        expect(store.value).toBe(before);
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Plan');
        // Idle again: the same write goes through.
        seed('7', {});
        expect(settings.setChallengeOverride('scenario', '7', 'Next')).toBe(true);
    });

    test('a profile that holds a scenario, and the rules that assign one, are held while a subject is not idle', () => {
        assigned();
        expect(settings.saveChallengeProfile('Tactic', { scenario: 'Plan' })).toBe(true);
        expect(settings.setTitleRules([{ type: 'exhibition', profile: 'Tactic' }])).toBe(true);
        // A step is now in the middle of the rule that Tactic assigns.
        seed('7', { inFlight: { ruleId: 'fill', actionIndex: 1 } });
        const before = store.value;
        expect(settings.saveChallengeProfile('Tactic', { scenario: 'Next' })).toBe(false);
        expect(settings.deleteChallengeProfile('Tactic')).toBe(false);
        expect(settings.setTitleRules([])).toBe(false);
        expect(settings.setTitleRules([{ type: 'exhibition', scenario: 'Next' }])).toBe(false);
        expect(store.value).toBe(before);
        seed('7', {});
        expect(settings.saveChallengeProfile('Tactic', { scenario: 'Next' })).toBe(true);
        expect(settings.deleteChallengeProfile('Tactic')).toBe(true);
    });
});

describe('handoff', () => {
    const handoff = (next: string | null = 'Next', generation = 0, subject = '7') =>
        settings.requestScenarioHandoff(subject, next, generation);

    test('every refusal says why, writes nothing and calls nothing', async () => {
        assigned();
        settings.saveScenario(installationDoc('Inst'));
        const refuse = async (reason: string, ...args: Parameters<typeof handoff>) => {
            const ledgerBefore = store.keys.get(STATE_KEY);
            const configBefore = store.value;
            expect(await handoff(...args)).toEqual({ ok: false, reason });
            expect(store.keys.get(STATE_KEY)).toBe(ledgerBefore);
            expect(store.value).toBe(configBefore);
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        };
        await refuse('stale-generation', 'Next', 3);
        await refuse('unknown-scenario', 'Missing');
        await refuse('incompatible-scope', 'Inst');
        await refuse('invalid-subject', 'Next', 0, '@all');
        await refuse('invalid-subject', 'Next', 0, '');
        await refuse('no-progress', 'Next', 0, '99');
        await refuse('no-installation', 'Inst', 0, INSTALLATION_KEY);
        store.keys.set(STATE_KEY, '{broken');
        await refuse('state-unreadable');
    });

    test('a spend that may have landed refuses, and the saved marker is the original', async () => {
        const pending = { ruleId: 'fill', actionIndex: 0, pending: 'fillExposure' as const };
        assigned({ inFlight: pending });
        const calls = currencyActions.fillExposure.mock.calls.length;
        expect(await settings.requestScenarioHandoff('7', 'Next', 0)).toMatchObject({
            ok: false,
            reason: 'unresolved-spend',
        });
        expect(record('7')?.inFlight).toEqual(pending);
        expect(currencyActions.fillExposure.mock.calls).toHaveLength(calls);
        seed('7', { inFlight: { ruleId: 'fill', actionIndex: 0, unclear: ['fillExposure'] } });
        expect(await handoff()).toMatchObject({ reason: 'unresolved-spend' });
        seed('7', { fired: { fill: { at: 1, unclearHalt: 'fillExposure' } } });
        expect(await handoff()).toMatchObject({ reason: 'unresolved-spend' });
    });

    test('a rule in progress, and a handoff already begun, refuse', async () => {
        assigned({ inFlight: { ruleId: 'fill', actionIndex: 1 } });
        expect(await handoff()).toMatchObject({ reason: 'rule-in-progress' });
        seed('7', { handoff: { from: 'Plan', to: 'Next', generation: 0, at: NOW } });
        expect(await handoff()).toMatchObject({ reason: 'handoff-pending' });
    });

    test('the step of a rule that asks for the handoff is the one rule in progress it may begin under', async () => {
        const from = { ruleId: 'fill', actionIndex: 1 };
        assigned({ inFlight: { ruleId: 'fill', actionIndex: 1 } });
        // a handoff of the same step goes through; one asked for by another step, or another rule, does not
        expect(await settings.requestScenarioHandoff('7', 'Next', 0, { ruleId: 'fill', actionIndex: 2 })).toEqual({
            ok: false,
            reason: 'rule-in-progress',
        });
        expect(await settings.requestScenarioHandoff('7', 'Next', 0, { ruleId: 'other', actionIndex: 1 })).toEqual({
            ok: false,
            reason: 'rule-in-progress',
        });
        expect(record('7')?.handoff).toBeUndefined();
        expect(await settings.requestScenarioHandoff('7', 'Next', 0, from)).toEqual({ ok: true, generation: 1 });
        expect(record('7')).toMatchObject({ scenario: 'Next', generation: 1, handoff: null, inFlight: null });
    });

    test('a spend that may have landed still refuses a handoff asked for by the step it belongs to', async () => {
        assigned({ inFlight: { ruleId: 'fill', actionIndex: 1, pending: 'fillExposure' } });
        expect(await settings.requestScenarioHandoff('7', 'Next', 0, { ruleId: 'fill', actionIndex: 1 })).toEqual({
            ok: false,
            reason: 'unresolved-spend',
        });
        expect(record('7')?.inFlight).toEqual({ ruleId: 'fill', actionIndex: 1, pending: 'fillExposure' });
    });

    test('what the old scenario patched for its phase does not outlive the handoff, whether another scenario follows or not', async () => {
        assigned({ phasePatch: { autoBoost: true }, phaseProfile: 'Calm' });
        expect(await handoff('Next')).toEqual({ ok: true, generation: 1 });
        expect(record('7')?.phasePatch).toBeUndefined();
        expect(record('7')?.phaseProfile).toBeUndefined();
        seed('7', { phasePatch: { autoBoost: true }, phaseProfile: null, generation: 1, scenario: 'Next' });
        expect(await handoff(null, 1)).toEqual({ ok: true, generation: 2 });
        expect(record('7')?.phasePatch).toBeUndefined();
        expect(record('7')?.phaseProfile).toBeUndefined();
        expect(record('7')?.inFlight).toBeNull();
    });

    test('a rule that assigns the scenario would still decide it: nothing is begun', async () => {
        assigned();
        settings.removeChallengeOverride('scenario', '7');
        settings.setTitleRules([{ type: 'exhibition', scenario: 'Plan' }]);
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Plan');
        expect(await handoff(null)).toMatchObject({ ok: false, reason: 'assignment-unchanged' });
        expect(record('7')?.handoff).toBeUndefined();
    });

    test('the gate and the subject step lock are tried first: busy writes nothing', async () => {
        assigned();
        held.add('scenario-7');
        expect(await handoff()).toEqual({ ok: false, reason: 'busy' });
        held.delete('scenario-7');
        expect(record('7')?.handoff).toBeUndefined();
    });

    test('success: the intent, the assignment and the finished record; the new scenario starts at its start phase', async () => {
        assigned({ memory: { held: 'z' }, fired: { fill: { at: 5 } } });
        expect(await handoff()).toEqual({ ok: true, generation: 1 });
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Next');
        const done = record('7')!;
        expect(done).toMatchObject({ scenario: 'Next', phase: 'main', generation: 1, memory: {}, fired: {} });
        expect(done.handoff).toBeNull();
        // The next pass runs the new scenario's rules from its start phase.
        await runStep();
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        expect(record('7')?.fired).toHaveProperty('fill');
    });

    test('the pause and the last request survive a handoff; the next scenario carries no old publication', async () => {
        assigned({
            paused: { at: NOW, reason: 'asked' },
            lastRequest: { id: 'r1', result: 'ok', at: NOW },
            published: {
                revision: 1,
                documentFingerprint: 'x',
                phase: 'main',
                phaseEnteredAt: NOW,
                observedAt: NOW,
                validUntil: null,
                bindings: {},
                profile: null,
            },
        });
        expect(await handoff()).toEqual({ ok: true, generation: 1 });
        expect(record('7')).toMatchObject({ paused: { reason: 'asked' }, lastRequest: { id: 'r1' } });
        expect(record('7')?.published).toBeUndefined();
    });

    test('a handoff to none clears the assignment and keeps the progress, one generation higher', async () => {
        assigned({ memory: { held: 'z' } });
        expect(await handoff(null)).toEqual({ ok: true, generation: 1 });
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('');
        expect(record('7')).toMatchObject({ scenario: 'Plan', memory: { held: 'z' }, generation: 1, handoff: null });
    });

    test('the installation scenario hands off to another installation scenario', async () => {
        settings.saveScenario(installationDoc('First'));
        settings.saveScenario(installationDoc('Second'));
        expect(settings.setInstallationScenario('First', 'electron', 0).ok).toBe(true);
        expect(await settings.requestScenarioHandoff(INSTALLATION_KEY, 'Second', 1)).toEqual({
            ok: true,
            generation: 2,
        });
        expect(settings.getInstallationScenario()).toEqual({ scenario: 'Second', executor: 'electron', generation: 2 });
        expect(record(INSTALLATION_KEY)).toMatchObject({ scenario: 'Second', generation: 2, handoff: null });
        expect(await settings.requestScenarioHandoff(INSTALLATION_KEY, null, 2)).toEqual({ ok: true, generation: 3 });
        expect(settings.getInstallationScenario()).toBeNull();
        expect(settings.installationGeneration()).toBe(3);
    });

    test('a handoff of the installation scenario keeps the withdrawal a Stop made: only an explicit re-arm lifts it', async () => {
        settings.saveScenario(installationDoc('First'));
        settings.saveScenario(installationDoc('Second'));
        expect(settings.setInstallationScenario('First', 'electron', 0).ok).toBe(true);
        expect(settings.withdrawInstallationPublication(4, 1700)).toEqual({ ok: true, changed: true });
        expect(await settings.requestScenarioHandoff(INSTALLATION_KEY, 'Second', 1)).toEqual({
            ok: true,
            generation: 2,
        });
        expect(record(INSTALLATION_KEY)).toMatchObject({ scenario: 'Second', withdrawn: { at: 1700, epoch: 4 } });
        expect(settings.restoreInstallationPublication()).toEqual({ ok: true, changed: true });
        expect(record(INSTALLATION_KEY)?.withdrawn).toBeUndefined();
    });

    describe('a storage failure at any step leaves nothing that can spend', () => {
        test('(a) the intent cannot be written: nothing changed at all', async () => {
            assigned();
            const ledgerBefore = store.keys.get(STATE_KEY);
            const configBefore = store.value;
            failWrites(STATE_KEY, [1]);
            expect(await handoff()).toEqual({ ok: false, reason: 'not-saved' });
            expect(store.keys.get(STATE_KEY)).toBe(ledgerBefore);
            expect(store.value).toBe(configBefore);
        });

        test('(b) the assignment cannot be saved: the intent holds the challenge and the runner redoes it', async () => {
            assigned();
            store.write.mockReturnValueOnce(false);
            expect(await handoff()).toEqual({ ok: false, reason: 'not-saved' });
            expect(record('7')?.handoff).toEqual({ from: 'Plan', to: 'Next', generation: 0, at: expect.any(Number) });
            expect(settings.getEffectiveSetting('scenario', '7')).toBe('Plan');
            // Passes run while it stands spend nothing; the one that finds the intent redoes the assignment and finishes.
            await runStep();
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
            expect(settings.getEffectiveSetting('scenario', '7')).toBe('Next');
            expect(record('7')).toMatchObject({ scenario: 'Next', generation: 1, handoff: null });
            await runStep();
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        });

        test('(c) the finished record cannot be written: held by the intent, finished by the next pass', async () => {
            assigned();
            failWrites(STATE_KEY, [2]);
            expect(await handoff()).toEqual({ ok: false, reason: 'not-saved' });
            expect(settings.getEffectiveSetting('scenario', '7')).toBe('Next');
            expect(record('7')).toMatchObject({ scenario: 'Plan', handoff: { to: 'Next' } });
            await runStep();
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
            expect(record('7')).toMatchObject({ scenario: 'Next', generation: 1, handoff: null });
        });

        test('every pass over a stuck intent spends nothing, however long the writes keep failing', async () => {
            assigned();
            store.write.mockReturnValueOnce(false);
            await handoff();
            failWrites(STATE_KEY, [1, 2, 3, 4, 5, 6]);
            await runStep();
            await runStep();
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
            expect(record('7')?.handoff).not.toBeNull();
        });
    });

    describe('an interrupted handoff is finished only while the assignment is one the intent names', () => {
        const intent = (patch: object = {}) => ({ from: 'Plan', to: 'Next', generation: 0, at: NOW, ...patch });

        test('no intent: nothing to settle', () => {
            assigned();
            expect(settings.settleHandoff('7', record('7')!)).toBe('finished');
        });

        test('the assignment already is `to`: finalized', () => {
            assigned({ handoff: intent() });
            settings.setChallengeOverride('scenario', '7', 'Next');
            expect(settings.settleHandoff('7', record('7')!)).toBe('finished');
            expect(record('7')).toMatchObject({ scenario: 'Next', generation: 1, handoff: null });
        });

        test('the assignment still is `from`: made again, then finalized', () => {
            assigned({ handoff: intent() });
            expect(settings.settleHandoff('7', record('7')!)).toBe('finished');
            expect(settings.getEffectiveSetting('scenario', '7')).toBe('Next');
        });

        // Another process or a hand edit assigns a third scenario while the intent stands: through the facade it is refused.
        const assignThird = () => {
            expect(settings.saveScenario(simple('Third')).ok).toBe(true);
            expect(settings.setChallengeOverride('scenario', '7', 'Third')).toBe(false);
            const raw = blob();
            raw.challenges['7'] = { values: { scenario: 'Third' } };
            store.value = JSON.stringify(raw);
        };

        test('a third assignment is a conflict: nothing is changed and the intent stands', () => {
            assigned({ handoff: intent() });
            assignThird();
            const before = store.keys.get(STATE_KEY);
            expect(settings.settleHandoff('7', record('7')!)).toBe('conflict');
            expect(store.keys.get(STATE_KEY)).toBe(before);
            expect(settings.getEffectiveSetting('scenario', '7')).toBe('Third');
        });

        test('a generation the intent was not begun at, and a scenario that is gone, are conflicts', () => {
            assigned({ handoff: intent({ generation: 5 }) });
            expect(settings.settleHandoff('7', record('7')!)).toBe('conflict');
            seed('7', { handoff: intent({ to: 'Gone' }) });
            expect(settings.settleHandoff('7', record('7')!)).toBe('conflict');
        });

        test('a conflict is reported by the runner as a halt, and nothing runs', async () => {
            assigned({ handoff: intent() });
            assignThird();
            await runStep();
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
            expect(record('7')?.lastError?.message).toBe('handoff-conflict');
        });

        test('an assignment that cannot be saved stays held, and is made again by the next pass', () => {
            assigned({ handoff: intent() });
            store.write.mockReturnValueOnce(false);
            expect(settings.settleHandoff('7', record('7')!)).toBe('failed');
            expect(record('7')?.handoff).not.toBeNull();
            expect(settings.getEffectiveSetting('scenario', '7')).toBe('Plan');
            expect(settings.settleHandoff('7', record('7')!)).toBe('finished');
        });

        test('a record that cannot be finished stays held, with the assignment already made', () => {
            assigned({ handoff: intent() });
            failWrites(STATE_KEY, [1]);
            expect(settings.settleHandoff('7', record('7')!)).toBe('failed');
            expect(record('7')?.handoff).not.toBeNull();
            expect(settings.getEffectiveSetting('scenario', '7')).toBe('Next');
            expect(settings.settleHandoff('7', record('7')!)).toBe('finished');
        });

        test('a rule that still assigns the scenario leaves nothing to finish: held, never finished by guessing', () => {
            assigned({ handoff: intent({ to: null }) });
            // Written by hand: the facade refuses a rule change while the intent stands.
            const raw = blob();
            raw.rules = [{ type: 'exhibition', scenario: 'Plan' }];
            delete raw.challenges['7'];
            store.value = JSON.stringify(raw);
            expect(settings.settleHandoff('7', record('7')!)).toBe('failed');
            expect(record('7')?.handoff).not.toBeNull();
        });

        test('the installation record is settled by the configuration assignment', () => {
            settings.saveScenario(installationDoc('First'));
            settings.saveScenario(installationDoc('Second'));
            settings.setInstallationScenario('First', 'cli', 0);
            scenarioStateLedger.change(INSTALLATION_KEY, (current) =>
                current
                    ? { ...current, handoff: { from: 'First', to: 'Second', generation: 1, at: NOW } }
                    : { refuse: 'x' },
            );
            expect(settings.settleHandoff(INSTALLATION_KEY, record(INSTALLATION_KEY)!)).toBe('finished');
            expect(settings.getInstallationScenario()).toEqual({ scenario: 'Second', executor: 'cli', generation: 2 });
            // Without any assignment record there is nothing to make again.
            const raw = blob();
            delete raw.installationScenario;
            store.value = JSON.stringify(raw);
            scenarioStateLedger.change(INSTALLATION_KEY, (current) =>
                current
                    ? { ...current, handoff: { from: 'Second', to: 'First', generation: 2, at: NOW } }
                    : { refuse: 'x' },
            );
            expect(settings.settleHandoff(INSTALLATION_KEY, record(INSTALLATION_KEY)!)).toBe('conflict');
        });
    });
});

describe('a scenario assigned over unresolved work', () => {
    test('is never started over it: the runner halts the challenge and spends nothing', async () => {
        assigned({ inFlight: { ruleId: 'fill', actionIndex: 0, pending: 'fillExposure' } });
        // Not through the facade (it would refuse): the file is edited by hand, as a crash or another build could leave it.
        const raw = blob();
        raw.challenges['7'] = { values: { scenario: 'Next' } };
        store.value = JSON.stringify(raw);
        await runStep();
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        expect(record('7')).toMatchObject({ scenario: 'Plan', inFlight: { pending: 'fillExposure' } });
        expect(record('7')?.lastError?.message).toBe('scenario-changed-with-unresolved-work');
    });
});

describe('a change that another writer interleaves', () => {
    /** Runs `act` once, the next time the ledger file's lock is asked for (inside one write of the ledger). */
    const atLedgerWrite = (act: () => void, nth = 1) => {
        let seen = 0;
        onLock = (id) => {
            if (id !== 'scenariostate') return;
            seen += 1;
            if (seen === nth) act();
        };
    };
    const editRecord = (change: (record: Record<string, unknown>) => void) => {
        const file = parseJsonObject(store.keys.get(STATE_KEY)!);
        const stored = file['7'];
        if (!isPlainObject(stored)) throw new Error('no record for challenge 7');
        change(stored);
        store.keys.set(STATE_KEY, JSON.stringify(file));
    };

    test('the intent is written only over the generation it was decided on, else the handoff is stale', async () => {
        assigned();
        atLedgerWrite(() => editRecord((record) => (record.generation = 1)));
        expect(await settings.requestScenarioHandoff('7', 'Next', 0)).toEqual({
            ok: false,
            reason: 'stale-generation',
        });
        expect(record('7')?.handoff).toBeUndefined();
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Plan');
        // The record gone altogether is as stale.
        atLedgerWrite(() => store.keys.set(STATE_KEY, '{}'));
        expect(await settings.requestScenarioHandoff('7', 'Next', 1)).toEqual({
            ok: false,
            reason: 'stale-generation',
        });
    });

    test('a finish that finds the intent gone is told stale, and nothing is finished over it', async () => {
        assigned();
        atLedgerWrite(
            () =>
                editRecord((record) => {
                    delete record.handoff;
                }),
            2,
        );
        expect(await settings.requestScenarioHandoff('7', 'Next', 0)).toEqual({
            ok: false,
            reason: 'stale-generation',
        });
        expect(record('7')).toMatchObject({ scenario: 'Plan' });
        expect(record('7')?.generation).toBeUndefined();
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Next');
    });

    test('a record that cannot be settled because the finish is refused stays held', () => {
        assigned({ handoff: { from: 'Plan', to: 'Next', generation: 0, at: NOW } });
        atLedgerWrite(() =>
            editRecord((record) => {
                delete record.handoff;
            }),
        );
        expect(settings.settleHandoff('7', record('7')!)).toBe('failed');
    });

    describe('an assignment that keeps the owner (a paired phone’s)', () => {
        test('names the owner the installation has: it goes through, with the owner unchanged and the generation moved on', () => {
            settings.saveScenario(installationDoc('Inst'));
            settings.saveScenario(installationDoc('Other'));
            expect(settings.setInstallationScenario('Inst', 'cli', 0).ok).toBe(true);
            expect(settings.setInstallationScenario('Other', 'cli', 1, { keepExecutor: true })).toMatchObject({
                ok: true,
                installation: { scenario: 'Other', executor: 'cli', generation: 2 },
            });
        });

        test('names another owner than the stored one: refused, and nothing changes', () => {
            settings.saveScenario(installationDoc('Inst'));
            settings.saveScenario(installationDoc('Other'));
            expect(settings.setInstallationScenario('Inst', 'cli', 0).ok).toBe(true);
            expect(settings.setInstallationScenario('Other', 'electron', 1, { keepExecutor: true })).toEqual({
                ok: false,
                reason: 'owner-policy',
                generation: 1,
            });
            expect(settings.getInstallationScenario()).toMatchObject({
                scenario: 'Inst',
                executor: 'cli',
                generation: 1,
            });
        });

        test('the owner is read under the same change as the generation: a transfer made after the phone looked is not undone', () => {
            settings.saveScenario(installationDoc('Inst'));
            settings.saveScenario(installationDoc('Other'));
            expect(settings.setInstallationScenario('Inst', 'electron', 0).ok).toBe(true);
            // The phone read owner electron at generation 1; then the user moved the installation to the CLI (generation 2).
            expect(settings.transferInstallationOwner('cli', 1).ok).toBe(true);
            // Its request names electron and (having read again) generation 2: the generation fence passes, the owner does not.
            expect(settings.setInstallationScenario('Other', 'electron', 2, { keepExecutor: true })).toEqual({
                ok: false,
                reason: 'owner-policy',
                generation: 2,
            });
            expect(settings.getInstallationScenario()).toMatchObject({ scenario: 'Inst', executor: 'cli' });
        });

        test('with no assignment there is no owner to keep: selecting is refused, clearing is not', () => {
            settings.saveScenario(installationDoc('Inst'));
            expect(settings.setInstallationScenario('Inst', 'electron', 0, { keepExecutor: true })).toEqual({
                ok: false,
                reason: 'owner-policy',
                generation: 0,
            });
            expect(settings.setInstallationScenario(null, 'electron', 0, { keepExecutor: true }).ok).toBe(true);
        });

        test('a stale generation still reads as stale, before the owner is judged', () => {
            settings.saveScenario(installationDoc('Inst'));
            expect(settings.setInstallationScenario('Inst', 'electron', 5, { keepExecutor: true })).toMatchObject({
                ok: false,
                reason: 'stale-generation',
            });
        });

        test('an option that is not keepExecutor changes nothing', () => {
            settings.saveScenario(installationDoc('Inst'));
            expect(settings.setInstallationScenario('Inst', 'cli', 0, {}).ok).toBe(true);
            expect(settings.getInstallationScenario()).toMatchObject({ executor: 'cli' });
        });
    });

    test('a ledger held by another process is busy, whatever change needed it', async () => {
        assigned();
        held.add('scenariostate');
        expect(await settings.requestScenarioHandoff('7', 'Next', 0)).toEqual({ ok: false, reason: 'busy' });
        settings.saveScenario(installationDoc('Inst'));
        expect(settings.setInstallationScenario('Inst', 'cli', 0)).toEqual({
            ok: false,
            reason: 'busy',
            generation: 0,
        });
        held.delete('scenariostate');
        expect(settings.getInstallationScenario()).toBeNull();
    });

    test('a ledger that stops being readable under a change is reported as unreadable', () => {
        settings.saveScenario(installationDoc('Inst'));
        atLedgerWrite(() => store.keys.set(STATE_KEY, '{broken'));
        expect(settings.setInstallationScenario('Inst', 'cli', 0)).toEqual({
            ok: false,
            reason: 'state-unreadable',
            generation: 0,
        });
        expect(settings.getInstallationScenario()).toBeNull();
    });
});

describe('the installation scenario under the gate', () => {
    test('a selection and a transfer are busy while the installation step lock, the gate or the ledger is held', () => {
        settings.saveScenario(installationDoc('Inst'));
        held.add('scenario-@installation');
        expect(settings.setInstallationScenario('Inst', 'cli', 0)).toEqual({ ok: false, reason: 'busy' });
        expect(settings.transferInstallationOwner('cli', 0)).toEqual({ ok: false, reason: 'busy' });
        held.delete('scenario-@installation');
        held.add('scenario-mutation');
        expect(settings.setInstallationScenario('Inst', 'cli', 0)).toEqual({ ok: false, reason: 'busy' });
        held.delete('scenario-mutation');
        expect(settings.setInstallationScenario('Inst', 'cli', 0)).toMatchObject({ ok: true });
    });
});

describe('a handoff that cannot make its assignment', () => {
    test('a challenge id the settings never store is held, not finished', () => {
        settings.saveScenario(simple('Next'));
        const state = {
            ...initialState('Plan', 'main', NOW),
            handoff: { from: '', to: 'Next', generation: 0, at: NOW },
        };
        expect(settings.settleHandoff('constructor', state)).toBe('failed');
    });

    test('an installation without an assignment record has nothing to hand over', () => {
        settings.saveScenario(installationDoc('First'));
        const state = {
            ...initialState('', 'main', NOW),
            handoff: { from: '', to: 'First', generation: 0, at: NOW },
        };
        expect(settings.settleHandoff(INSTALLATION_KEY, state)).toBe('failed');
    });
});

describe('the priority Stop fence', () => {
    const fenceText = () => store.keys.get(FENCE_KEY);

    test('missing, then initialized once; an existing fence is left as it is', async () => {
        expect(settings.readStopFence()).toEqual({ state: 'missing' });
        expect(settings.isArmAllowed(0)).toBe(false);
        expect(await settings.initializeStopFence()).toEqual({ ok: true, created: true });
        expect(settings.readStopFence()).toEqual({
            state: 'ok',
            fence: { stopEpoch: 0, blocked: false, lastStop: null, lastArm: null },
        });
        expect(settings.isArmAllowed(0)).toBe(true);
        const before = fenceText();
        expect(await settings.initializeStopFence()).toEqual({ ok: true, created: false });
        expect(fenceText()).toBe(before);
    });

    test('clearing the scenario progress alone never removes the fence', async () => {
        await settings.initializeStopFence();
        expect(await settings.recordFullStop('stop-1', 1700)).toEqual({ ok: true, epoch: 1 });
        const before = fenceText();
        seed('7');
        await scenarioStateLedger.removeAll();
        expect(record('7')).toBeNull();
        expect(fenceText()).toBe(before);
        expect(settings.readStopFence()).toMatchObject({ state: 'ok', fence: { stopEpoch: 1, blocked: true } });
    });

    test('the cache is read again on request (the Android native Stop writes the fence behind it), and answers what is stored', async () => {
        await settings.initializeStopFence();
        expect(settings.readStopFence()).toMatchObject({ state: 'ok', fence: { stopEpoch: 0, blocked: false } });
        // Another context (the native Stop) saved the fence; the next read of the cache answers it only once refreshed.
        store.keys.set(
            FENCE_KEY,
            JSON.stringify({
                stopEpoch: 3,
                blocked: true,
                lastStop: { requestId: 'native', at: 1, durable: true },
                lastArm: null,
            }),
        );
        await expect(
            (
                require('../../src/ts/core/settings/scenarioLifecycle') as typeof scenarioLifecycleModule
            ).refreshStopFenceAsync(),
        ).resolves.toBe(true);
        expect(settings.readStopFence()).toMatchObject({ state: 'ok', fence: { stopEpoch: 3, blocked: true } });
    });

    test('a fence that cannot be read is never initialized over, nor read as epoch 0', async () => {
        store.keys.set(FENCE_KEY, '{"stopEpoch":"0"}');
        expect(await settings.initializeStopFence()).toEqual({ ok: false, reason: 'unreadable' });
        expect(fenceText()).toBe('{"stopEpoch":"0"}');
    });

    test('a Stop raises the epoch by one and blocks; the same request again changes nothing', async () => {
        await settings.initializeStopFence();
        expect(await settings.recordFullStop('stop-1', 1700)).toEqual({ ok: true, epoch: 1 });
        expect(settings.readStopFence()).toEqual({
            state: 'ok',
            fence: {
                stopEpoch: 1,
                blocked: true,
                lastStop: { requestId: 'stop-1', at: 1700, durable: true },
                lastArm: null,
            },
        });
        const before = fenceText();
        expect(await settings.recordFullStop('stop-1', 1800)).toEqual({ ok: true, epoch: 1 });
        expect(fenceText()).toBe(before);
        expect(await settings.recordFullStop('stop-2', 1900)).toEqual({ ok: true, epoch: 2 });
        expect(settings.isArmAllowed(1)).toBe(false);
        expect(settings.isArmAllowed(2)).toBe(false);
    });

    test('a Stop on a missing fence creates it at epoch 1', async () => {
        expect(await settings.recordFullStop('first', 5)).toEqual({ ok: true, epoch: 1 });
        expect(settings.readStopFence()).toMatchObject({ state: 'ok', fence: { stopEpoch: 1, blocked: true } });
    });

    test('a Stop reads and writes only the fence: no other store is touched, whatever state it is in', async () => {
        await settings.initializeStopFence();
        store.keys.set(STATE_KEY, '{broken');
        const reads = jest.spyOn(store, 'readKey');
        const writes = jest.spyOn(store, 'compareAndWriteKey');
        const configReads = store.read.mock.calls.length;
        expect(await settings.recordFullStop('s', 1)).toEqual({ ok: true, epoch: 1 });
        expect(new Set(reads.mock.calls.map(([key]) => key))).toEqual(new Set([FENCE_KEY]));
        expect(new Set(writes.mock.calls.map(([key]) => key))).toEqual(new Set([FENCE_KEY]));
        expect(store.read.mock.calls).toHaveLength(configReads);
        expect(store.keys.get(STATE_KEY)).toBe('{broken');
    });

    test('a Stop that changed under another writer is made again on what is there', async () => {
        await settings.initializeStopFence();
        const real = store.compareAndWriteKey!;
        let raced = false;
        store.compareAndWriteKey = (key, expected, data) => {
            if (key === FENCE_KEY && !raced) {
                raced = true;
                // Another executor recorded a Stop first.
                store.keys.set(
                    FENCE_KEY,
                    JSON.stringify({
                        stopEpoch: 4,
                        blocked: true,
                        lastStop: { requestId: 'other', at: 2, durable: true },
                        lastArm: null,
                    }),
                );
                return false;
            }
            return real(key, expected, data);
        };
        expect(await settings.recordFullStop('mine', 3)).toEqual({ ok: true, epoch: 5 });
        expect(settings.readStopFence()).toMatchObject({ fence: { stopEpoch: 5, lastStop: { requestId: 'mine' } } });
    });

    test('a Stop that cannot be saved says so; a fence that cannot be read is not written over', async () => {
        await settings.initializeStopFence();
        const real = store.compareAndWriteKey!;
        store.compareAndWriteKey = () => false;
        expect(await settings.recordFullStop('s', 1)).toEqual({ ok: false, reason: 'not-saved' });
        store.compareAndWriteKey = real;
        store.keys.set(FENCE_KEY, '{"nope":1}');
        expect(await settings.recordFullStop('s', 1)).toEqual({ ok: false, reason: 'unreadable' });
        expect(fenceText()).toBe('{"nope":1}');
        expect(settings.isArmAllowed(0)).toBe(false);
    });

    test('the cell holds at most 1024 bytes: a longer request id is refused, nothing is written', async () => {
        await settings.initializeStopFence();
        const before = fenceText();
        expect(await settings.recordFullStop('x'.repeat(2000), 1)).toEqual({ ok: false, reason: 'oversize' });
        expect(fenceText()).toBe(before);
        // A stored fence past the boundary reads as unreadable, never as a fence.
        store.keys.set(
            FENCE_KEY,
            JSON.stringify({ stopEpoch: 1, blocked: true, lastStop: null, lastArm: null, pad: 'x'.repeat(1100) }),
        );
        expect(settings.readStopFence()).toEqual({ state: 'unreadable', reason: 'oversize' });
        const longest = 'y'.repeat(900);
        store.keys.set(FENCE_KEY, JSON.stringify({ stopEpoch: 0, blocked: false, lastStop: null, lastArm: null }));
        expect(await settings.recordFullStop(longest, 1)).toEqual({ ok: true, epoch: 1 });
    });

    test.each([
        ['not an object', '[]'],
        ['not JSON', '{'],
        ['an extra key', '{"stopEpoch":0,"blocked":false,"lastStop":null,"lastArm":null,"x":1}'],
        ['a missing key', '{"stopEpoch":0,"blocked":false,"lastArm":null}'],
        ['a missing lastArm', '{"stopEpoch":0,"blocked":false,"lastStop":null}'],
        ['a lastArm that is not an object', '{"stopEpoch":0,"blocked":false,"lastStop":null,"lastArm":3}'],
        [
            'a lastArm with an extra key',
            '{"stopEpoch":0,"blocked":false,"lastStop":null,"lastArm":{"epoch":0,"at":1,"x":1}}',
        ],
        [
            'a lastArm with a fractional epoch',
            '{"stopEpoch":0,"blocked":false,"lastStop":null,"lastArm":{"epoch":0.5,"at":1}}',
        ],
        [
            'a lastArm with a text time',
            '{"stopEpoch":0,"blocked":false,"lastStop":null,"lastArm":{"epoch":0,"at":"1"}}',
        ],
        ['a negative epoch', '{"stopEpoch":-1,"blocked":false,"lastStop":null,"lastArm":null}'],
        ['a fractional epoch', '{"stopEpoch":1.5,"blocked":false,"lastStop":null,"lastArm":null}'],
        ['a text block flag', '{"stopEpoch":0,"blocked":"no","lastStop":null,"lastArm":null}'],
        ['a lastStop that is not an object', '{"stopEpoch":0,"blocked":false,"lastStop":3,"lastArm":null}'],
        [
            'a lastStop with an extra key',
            '{"stopEpoch":0,"blocked":false,"lastStop":{"requestId":"a","at":1,"durable":true,"x":1},"lastArm":null}',
        ],
        [
            'a lastStop with a number id',
            '{"stopEpoch":0,"blocked":false,"lastStop":{"requestId":1,"at":1,"durable":true},"lastArm":null}',
        ],
        [
            'a lastStop with a text time',
            '{"stopEpoch":0,"blocked":false,"lastStop":{"requestId":"a","at":"1","durable":true},"lastArm":null}',
        ],
        [
            'a lastStop with a text durable flag',
            '{"stopEpoch":0,"blocked":false,"lastStop":{"requestId":"a","at":1,"durable":"y"},"lastArm":null}',
        ],
    ])('malformed data (%s) is unreadable: never epoch 0, nothing may arm', async (label, text) => {
        store.keys.set(FENCE_KEY, text);
        expect(settings.readStopFence()).toEqual({ state: 'unreadable', reason: 'malformed' });
        expect(settings.isArmAllowed(0)).toBe(false);
        expect(await settings.clearStopBlock(0)).toEqual({ ok: false, reason: 'unreadable' });
    });

    test('clearing a block needs the epoch the user saw; a Stop that came after keeps it blocked', async () => {
        await settings.initializeStopFence();
        expect(await settings.recordFullStop('s', 1)).toEqual({ ok: true, epoch: 1 });
        expect(await settings.clearStopBlock(0)).toEqual({ ok: false, reason: 'stale-epoch' });
        expect(settings.isArmAllowed(1)).toBe(false);
        expect(await settings.clearStopBlock(1)).toEqual({ ok: true });
        expect(settings.isArmAllowed(1)).toBe(true);
        // A request made before the Stop is obsolete for good.
        expect(settings.isArmAllowed(0)).toBe(false);
        // Already open: nothing to write.
        const before = fenceText();
        expect(await settings.clearStopBlock(1)).toEqual({ ok: true });
        expect(fenceText()).toBe(before);
    });

    test('clearing needs a fence to exist, and a save that lands', async () => {
        expect(await settings.clearStopBlock(0)).toEqual({ ok: false, reason: 'missing' });
        await settings.initializeStopFence();
        await settings.recordFullStop('s', 1);
        store.compareAndWriteKey = () => false;
        expect(await settings.clearStopBlock(1)).toEqual({ ok: false, reason: 'not-saved' });
    });

    test('an ordinary change of scenarios never reads or writes the fence', async () => {
        await settings.initializeStopFence();
        const before = fenceText();
        assigned();
        await handoffAfter();
        expect(fenceText()).toBe(before);
    });

    const handoffAfter = async () => {
        await settings.requestScenarioHandoff('7', 'Next', 0);
    };

    describe('armIfAllowed: the final arming decision, one compare-and-set', () => {
        const stored = () => parseJsonObject(fenceText()!);

        test('succeeds while the fence is readable, open and at the captured epoch, and records the arming', async () => {
            await settings.initializeStopFence();
            expect(await settings.armIfAllowed(0, 1700)).toEqual({ ok: true });
            expect(stored()).toEqual({ stopEpoch: 0, blocked: false, lastStop: null, lastArm: { epoch: 0, at: 1700 } });
            // A Stop keeps what was recorded of the last arming.
            expect(await settings.recordFullStop('s', 1800)).toEqual({ ok: true, epoch: 1 });
            expect(stored()).toMatchObject({ stopEpoch: 1, blocked: true, lastArm: { epoch: 0, at: 1700 } });
        });

        test('a blocked fence, a stale epoch, a missing or an unreadable one refuse, and nothing is written', async () => {
            expect(await settings.armIfAllowed(0, 1)).toEqual({ ok: false, reason: 'missing' });
            await settings.initializeStopFence();
            await settings.recordFullStop('s', 1);
            const blocked = fenceText();
            expect(await settings.armIfAllowed(1, 2)).toEqual({ ok: false, reason: 'blocked' });
            expect(await settings.clearStopBlock(1)).toEqual({ ok: true });
            expect(await settings.armIfAllowed(0, 2)).toEqual({ ok: false, reason: 'stale-epoch' });
            expect(fenceText()).not.toBe(blocked);
            const before = fenceText();
            expect(await settings.armIfAllowed(0, 3)).toEqual({ ok: false, reason: 'stale-epoch' });
            expect(fenceText()).toBe(before);
            store.keys.set(FENCE_KEY, '{"nope":1}');
            expect(await settings.armIfAllowed(0, 3)).toEqual({ ok: false, reason: 'unreadable' });
            expect(fenceText()).toBe('{"nope":1}');
        });

        test('a write that does not land, and one that would not fit the cell, are refused', async () => {
            await settings.initializeStopFence();
            const real = store.compareAndWriteKey!;
            store.compareAndWriteKey = () => false;
            expect(await settings.armIfAllowed(0, 1)).toEqual({ ok: false, reason: 'not-saved' });
            store.compareAndWriteKey = real;
            // A Stop whose text fills the cell leaves no room for the arming.
            const overhead = JSON.stringify({
                stopEpoch: 1,
                blocked: true,
                lastStop: { requestId: '', at: 1, durable: true },
                lastArm: null,
            }).length;
            expect(await settings.recordFullStop('z'.repeat(1020 - overhead), 1)).toEqual({ ok: true, epoch: 1 });
            expect(await settings.clearStopBlock(1)).toEqual({ ok: true });
            const full = fenceText();
            expect(await settings.armIfAllowed(1, 2)).toEqual({ ok: false, reason: 'oversize' });
            expect(fenceText()).toBe(full);
        });

        describe('against a Stop from another runtime over the same backing store', () => {
            type Lifecycle = typeof import('../../src/ts/core/settings/scenarioLifecycle');
            let other: Lifecycle;

            beforeEach(() => {
                // A second copy of the module: its own store handle, the same native store underneath.
                jest.isolateModules(() => {
                    (
                        require('../helpers/platform') as typeof import('../helpers/platform')
                    ).installHeadlessTestPlatform();
                    other = require('../../src/ts/core/settings/scenarioLifecycle') as Lifecycle;
                });
            });

            test('the arming first: it lands, the Stop after it advances the epoch, and the older epoch arms no more', async () => {
                await settings.initializeStopFence();
                expect(await settings.armIfAllowed(0, 10)).toEqual({ ok: true });
                expect(await other.recordFullStop('other', 11)).toEqual({ ok: true, epoch: 1 });
                expect(await settings.armIfAllowed(0, 12)).toEqual({ ok: false, reason: 'blocked' });
                expect(await other.armIfAllowed(0, 12)).toEqual({ ok: false, reason: 'blocked' });
                expect(stored()).toMatchObject({ stopEpoch: 1, blocked: true, lastArm: { epoch: 0, at: 10 } });
            });

            test('the Stop first: the arming from the older epoch is refused', async () => {
                await settings.initializeStopFence();
                expect(await other.recordFullStop('other', 10)).toEqual({ ok: true, epoch: 1 });
                expect(await settings.armIfAllowed(0, 11)).toEqual({ ok: false, reason: 'blocked' });
                expect(await settings.clearStopBlock(1)).toEqual({ ok: true });
                expect(await settings.armIfAllowed(0, 12)).toEqual({ ok: false, reason: 'stale-epoch' });
                expect(await other.armIfAllowed(1, 13)).toEqual({ ok: true });
            });

            test('a Stop that lands between the arming’s read and its write: the write loses, and is made again on what is there', async () => {
                await settings.initializeStopFence();
                const real = store.compareAndWriteKey!;
                let raced = false;
                store.compareAndWriteKey = (key, expected, data) => {
                    if (key === FENCE_KEY && !raced) {
                        raced = true;
                        // The other runtime's Stop is saved first.
                        store.keys.set(
                            FENCE_KEY,
                            JSON.stringify({
                                stopEpoch: 1,
                                blocked: true,
                                lastStop: { requestId: 'o', at: 5, durable: true },
                                lastArm: null,
                            }),
                        );
                        return false;
                    }
                    return real(key, expected, data);
                };
                expect(await settings.armIfAllowed(0, 6)).toEqual({ ok: false, reason: 'blocked' });
                expect(stored()).toMatchObject({ stopEpoch: 1, blocked: true, lastArm: null });
            });

            test('an arming that lands between the Stop’s read and its write: the Stop loses, is made again, and wins the epoch', async () => {
                await settings.initializeStopFence();
                const real = store.compareAndWriteKey!;
                let raced = false;
                store.compareAndWriteKey = (key, expected, data) => {
                    if (key === FENCE_KEY && !raced) {
                        raced = true;
                        store.keys.set(
                            FENCE_KEY,
                            JSON.stringify({
                                stopEpoch: 0,
                                blocked: false,
                                lastStop: null,
                                lastArm: { epoch: 0, at: 5 },
                            }),
                        );
                        return false;
                    }
                    return real(key, expected, data);
                };
                expect(await other.recordFullStop('mine', 6)).toEqual({ ok: true, epoch: 1 });
                expect(stored()).toMatchObject({ stopEpoch: 1, blocked: true, lastArm: { epoch: 0, at: 5 } });
                expect(await settings.armIfAllowed(0, 7)).toEqual({ ok: false, reason: 'blocked' });
            });
        });
    });

    test('the boot hydrates the fence and the teardown flushes it', async () => {
        const lifecycle =
            require('../../src/ts/core/settings/scenarioLifecycle') as typeof import('../../src/ts/core/settings/scenarioLifecycle');
        await expect(lifecycle.initializeStopFenceAsync()).resolves.toBeUndefined();
        await settings.recordFullStop('s', 1);
        await expect(lifecycle.flushStopFenceWrites()).resolves.toBeUndefined();
        expect(settings.readStopFence()).toMatchObject({ state: 'ok', fence: { stopEpoch: 1 } });
    });

    test('a fence the store has not loaded reads as unreadable', () => {
        const platform = require('../../src/ts/core/platform/port') as typeof import('../../src/ts/core/platform/port');
        jest.spyOn(platform.platform().storage, 'loaded').mockReturnValue(false);
        expect(settings.readStopFence()).toEqual({ state: 'unreadable', reason: 'not-loaded' });
    });

    test('a store that throws when read is unreadable, not missing', () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/ts/core/settings/storage', () => ({
                ...jest.requireActual<typeof import('../../src/ts/core/settings/storage')>(
                    '../../src/ts/core/settings/storage',
                ),
                createJsonStore: () => ({
                    readRaw: () => {
                        throw new Error('bridge down');
                    },
                }),
            }));
            const isolated =
                require('../../src/ts/core/settings/scenarioLifecycle') as typeof import('../../src/ts/core/settings/scenarioLifecycle');
            expect(isolated.readStopFence()).toEqual({ state: 'unreadable', reason: 'read-failed' });
            expect(isolated.isArmAllowed(0)).toBe(false);
        });
        jest.dontMock('../../src/ts/core/settings/storage');
    });

    test('a store whose write rejects makes every fence change not saved', async () => {
        let isolated: typeof import('../../src/ts/core/settings/scenarioLifecycle') | undefined;
        jest.isolateModules(() => {
            jest.doMock('../../src/ts/core/settings/storage', () => ({
                ...jest.requireActual<typeof import('../../src/ts/core/settings/storage')>(
                    '../../src/ts/core/settings/storage',
                ),
                createJsonStore: () => ({
                    readRaw: () => null,
                    updateThrough: () => Promise.reject(new Error('bridge down')),
                }),
            }));
            isolated =
                require('../../src/ts/core/settings/scenarioLifecycle') as typeof import('../../src/ts/core/settings/scenarioLifecycle');
        });
        jest.dontMock('../../src/ts/core/settings/storage');
        await expect(isolated!.initializeStopFence()).resolves.toEqual({ ok: false, reason: 'not-saved' });
        await expect(isolated!.recordFullStop('s', 1)).resolves.toEqual({ ok: false, reason: 'not-saved' });
        await expect(isolated!.clearStopBlock(0)).resolves.toEqual({ ok: false, reason: 'not-saved' });
        await expect(isolated!.armIfAllowed(0, 1)).resolves.toEqual({ ok: false, reason: 'not-saved' });
    });
});

describe('pause and resume by the user', () => {
    const pausing = () =>
        simple('Plan', {
            phases: {
                main: {
                    rules: [
                        {
                            id: 'p',
                            repeat: 'once',
                            do: [
                                { type: 'pauseScenario', reason: 'cooling off' },
                                { type: 'notify', message: 'after' },
                            ],
                        },
                    ],
                },
            },
        });

    test('a pause by the action stops the subject; the user’s resume lets its actions run again, from where it stopped', async () => {
        expect(settings.saveScenario(pausing()).ok).toBe(true);
        expect(settings.setChallengeOverride('scenario', '7', 'Plan')).toBe(true);
        await runStep();
        expect(record('7')?.paused).toEqual({ at: expect.any(Number), reason: 'cooling off' });
        expect(record('7')?.outbox).toEqual([]);
        // paused: the next passes run nothing
        await runStep();
        expect(record('7')?.outbox).toEqual([]);

        const manual = settings.getEffectiveSetting('manualPhotosOnly', '7');
        const ledgerBefore = store.keys.get(STATE_KEY);
        expect(settings.setScenarioPaused('7', false)).toEqual({ ok: true, paused: false });
        expect(record('7')?.paused).toBeUndefined();
        // progress kept, Manual Only and the stop fence untouched
        expect(record('7')?.inFlight).toEqual({ ruleId: 'p', actionIndex: 1 });
        expect(settings.getEffectiveSetting('manualPhotosOnly', '7')).toBe(manual);
        expect(store.keys.get(FENCE_KEY)).toBeUndefined();
        expect(store.keys.get(STATE_KEY)).not.toBe(ledgerBefore);

        await runStep();
        expect(record('7')?.outbox?.map((notice) => notice.message)).toEqual(['after']);
        expect(record('7')?.fired.p).toBeDefined();
    });

    test('the user pauses with a reason, and a pause again replaces it; progress is kept', () => {
        assigned({ memory: { held: 'z' }, fired: { fill: { at: 5 } } });
        expect(settings.setScenarioPaused('7', true, 'asleep')).toEqual({ ok: true, paused: true });
        expect(record('7')).toMatchObject({
            paused: { at: expect.any(Number), reason: 'asleep' },
            memory: { held: 'z' },
        });
        expect(record('7')?.fired).toEqual({ fill: { at: 5 } });
        expect(settings.setScenarioPaused('7', true)).toEqual({ ok: true, paused: true });
        expect(record('7')?.paused?.reason).toBe('');
    });

    test('resuming a subject that is not paused is a success that writes nothing', () => {
        assigned();
        const before = store.keys.get(STATE_KEY);
        expect(settings.setScenarioPaused('7', false)).toEqual({ ok: true, paused: false });
        expect(store.keys.get(STATE_KEY)).toBe(before);
    });

    test('the installation is paused and resumed the same way', () => {
        seed(INSTALLATION_KEY, { generation: 1 });
        expect(settings.setScenarioPaused(INSTALLATION_KEY, true, 'user')).toEqual({ ok: true, paused: true });
        expect(record(INSTALLATION_KEY)?.paused).toMatchObject({ reason: 'user' });
        expect(settings.setScenarioPaused(INSTALLATION_KEY, false)).toEqual({ ok: true, paused: false });
        expect(record(INSTALLATION_KEY)?.paused).toBeUndefined();
    });

    test('is busy while the subject’s step lock or the gate is held, and nothing is written', () => {
        assigned();
        for (const id of ['scenario-7', 'scenario-mutation']) {
            held.add(id);
            const before = store.keys.get(STATE_KEY);
            expect(settings.setScenarioPaused('7', true)).toEqual({ ok: false, reason: 'busy' });
            expect(store.keys.get(STATE_KEY)).toBe(before);
            held.delete(id);
        }
        expect(record('7')?.paused).toBeUndefined();
    });

    test('refuses a subject that is not one, has no progress, or whose progress cannot be read', () => {
        assigned();
        expect(settings.setScenarioPaused('', true)).toEqual({ ok: false, reason: 'invalid-subject' });
        expect(settings.setScenarioPaused('@all', true)).toEqual({ ok: false, reason: 'invalid-subject' });
        expect(settings.setScenarioPaused('99', true)).toEqual({ ok: false, reason: 'no-progress' });
        store.keys.set(STATE_KEY, '{broken');
        expect(settings.setScenarioPaused('7', true)).toEqual({ ok: false, reason: 'state-unreadable' });
    });

    test('a record that is gone when the write is made, or a write that is not saved, is reported', () => {
        assigned();
        const real = scenarioStateLedger.change.bind(scenarioStateLedger);
        jest.spyOn(scenarioStateLedger, 'change').mockImplementationOnce((key) =>
            real(key, () => ({ refuse: 'no-progress' })),
        );
        expect(settings.setScenarioPaused('7', true)).toEqual({ ok: false, reason: 'state-unreadable' });
        jest.spyOn(scenarioStateLedger, 'change').mockImplementationOnce((key, update) => {
            update(null);
            return { ok: false, reason: 'not-saved' };
        });
        expect(settings.setScenarioPaused('7', true)).toEqual({ ok: false, reason: 'not-saved' });
    });
});

describe('mock mode keeps its progress in memory: the persisted store is never read or written', () => {
    afterEach(async () => {
        await mockScenarioStateLedger.removeAll();
    });

    const mockAssigned = () => {
        expect(settings.saveScenario(simple('Plan')).ok).toBe(true);
        expect(settings.saveScenario(simple('Next')).ok).toBe(true);
        expect(settings.setChallengeOverride('scenario', '7', 'Plan')).toBe(true);
        settings.setSetting('mock', true);
        expect(mockScenarioStateLedger.change('7', () => initialState('Plan', 'main', NOW)).ok).toBe(true);
    };

    test('a handoff succeeds in the mock ledger and leaves the persisted store as it was', async () => {
        mockAssigned();
        const readSpy = jest.spyOn(scenarioStateLedger, 'get');
        const changeSpy = jest.spyOn(scenarioStateLedger, 'change');
        const before = store.keys.get(STATE_KEY);
        expect(await settings.requestScenarioHandoff('7', 'Next', 0)).toEqual({ ok: true, generation: 1 });
        expect(mockScenarioStateLedger.get('7').state).toMatchObject({
            scenario: 'Next',
            generation: 1,
            handoff: null,
        });
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Next');
        expect(store.keys.get(STATE_KEY)).toBe(before);
        expect(readSpy).not.toHaveBeenCalled();
        expect(changeSpy).not.toHaveBeenCalled();
    });

    test('an unresolved spend in the mock ledger refuses the handoff, as in the persisted one', async () => {
        mockAssigned();
        mockScenarioStateLedger.change('7', (current) => ({
            ...(current as ScenarioState),
            inFlight: { ruleId: 'fill', actionIndex: 0, pending: 'fillExposure' },
        }));
        expect(await settings.requestScenarioHandoff('7', 'Next', 0)).toEqual({
            ok: false,
            reason: 'unresolved-spend',
        });
        // the persisted ledger has no record of the subject: reading it would have said no-progress
        expect(scenarioStateLedger.get('7').state).toBeNull();
    });

    test('pause and resume, the installation selection and its generation use the mock ledger too', () => {
        mockAssigned();
        const readSpy = jest.spyOn(scenarioStateLedger, 'get');
        const changeSpy = jest.spyOn(scenarioStateLedger, 'change');
        expect(settings.setScenarioPaused('7', true, 'user')).toEqual({ ok: true, paused: true });
        expect(mockScenarioStateLedger.get('7').state?.paused).toMatchObject({ reason: 'user' });
        expect(settings.setScenarioPaused('7', false)).toEqual({ ok: true, paused: false });
        expect(settings.saveScenario(installationDoc('Inst')).ok).toBe(true);
        expect(settings.setInstallationScenario('Inst', 'cli', 0)).toMatchObject({ ok: true, generation: 1 });
        expect(settings.installationGeneration()).toBe(1);
        expect(mockScenarioStateLedger.get(INSTALLATION_KEY).state?.generation).toBe(1);
        expect(settings.transferInstallationOwner('electron', 1)).toMatchObject({ ok: true, generation: 2 });
        expect(readSpy).not.toHaveBeenCalled();
        expect(changeSpy).not.toHaveBeenCalled();
    });

    test('mock mode takes no step lock: one process runs it', () => {
        mockAssigned();
        held.add('scenario-7');
        expect(settings.setScenarioPaused('7', true)).toEqual({ ok: true, paused: true });
        held.delete('scenario-7');
    });
});
