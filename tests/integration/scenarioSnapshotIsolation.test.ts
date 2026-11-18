/**
 * The settings a scenario phase publishes, end to end over the REAL settings, ledger, runner step and voting pass:
 *   - an awaited pass keeps reading the overlay it published while a private preview with other evidence is built and
 *     disposed (a preview never publishes, replaces or clears it);
 *   - a second settings runtime over the same storage reads the owner's publication and never publishes;
 *   - a phase whose bindings cannot be resolved exposes no inherited value: the getter throws, the typed read is
 *     unknown, and the voting pass skips that challenge without abandoning the others.
 * The Android WebView store adapters are the headless transport the helpers install (the same store the service writes).
 */

const mockLogs: Array<{ level: string; msg: string }> = [];

jest.mock('../../src/ts/core/logger', () => {
    const category = new Proxy(
        {},
        {
            get:
                (_target, level: string) =>
                (msg: unknown, ...rest: unknown[]) => {
                    mockLogs.push({ level, msg: String(msg) + (typeof rest[0] === 'string' ? ` ${rest[0]}` : '') });
                },
        },
    );
    const named = {
        __esModule: true,
        withCategory: () => category,
        challengeTag: (challenge: { id?: unknown; title?: unknown } | null | undefined) =>
            `[Challenge ${challenge?.id}: ${challenge?.title}]`,
    };
    // Anything else the pass reaches for on the logger is a no-op.
    return new Proxy(named, { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}) });
});

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import { installHeadlessTestPlatform } from '../helpers/platform';
import { invalid } from '../helpers/invalid';
import { buildChallenge } from '../helpers/challengeFixtures';
import settings = require('../../src/ts/core/settings');
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as votingOrchestratorModule from '../../src/ts/core/services/votingOrchestrator';
import type * as expressionsModule from '../../src/ts/core/scenarios/expressions';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioExpr } from '../../src/ts/core/types/scenario';
import type { ScenarioState } from '../../src/ts/core/types/stores';
import type { VotingPassDeps } from '../../src/ts/core/types/votingPass';
import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';

const { scenarioStateLedger } = require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const { runVotingPass } = require('../../src/ts/core/services/votingOrchestrator') as typeof votingOrchestratorModule;
const { known } = require('../../src/ts/core/scenarios/expressions') as typeof expressionsModule;

const NOW = Math.floor(Date.now() / 1000);
const OWNED = 7;
const SIBLING = 8;

const percent = (value: number) => invalid<ScenarioExpr>({ kind: 'literal', value, quantity: 'percent' });
const plus = (key: string, amount: number) =>
    invalid<ScenarioExpr>({
        kind: 'add',
        left: { kind: 'setting', key, view: 'base' },
        right: percent(amount),
    });

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

/** Lets the pass run until `condition` holds (it stops at the held read). */
const until = async (condition: () => boolean) => {
    for (let turn = 0; turn < 200 && !condition(); turn++) await new Promise<void>((done) => setImmediate(done));
    expect(condition()).toBe(true);
};

const quiet = (id: number, title: string): Challenge =>
    buildChallenge({
        id,
        title,
        type: 'regular',
        start_time: NOW - 3600,
        close_time: NOW + 5 * 86400,
        max_photo_submits: 4,
        member: {
            ranking: {
                entries: [{ id: `e-${id}`, member_id: 'm', votes: 5 }],
                exposure: { exposure_factor: 100 },
                swaps: [],
            },
        },
    });

/**
 * A plan whose bound phase tells once, then looks again (a rule that reads the missions): the second look awaits the
 * evidence read the test holds, with the first publication standing.
 */
const plan = (
    bindings: Record<string, ScenarioExpr> = { exposure: plus('exposure', 20) },
    literals: Record<string, unknown> = { exposureTarget: 90 },
) => ({
    name: 'Plan',
    version: 1,
    start: 'push',
    phases: {
        push: {
            settings: literals,
            bindings,
            rules: [
                { id: 'tell', repeat: 'once', do: [{ type: 'notify', message: 'started' }] },
                {
                    id: 'watch',
                    if: [
                        {
                            type: 'compare',
                            left: { kind: 'fact', name: 'missions.joinNeed' },
                            op: '>',
                            right: { kind: 'literal', value: 0, quantity: 'count' },
                        },
                    ],
                    do: [{ type: 'notify', message: 'missions' }],
                },
            ],
        },
    },
});

const state = () => scenarioStateLedger.get(OWNED).state as ScenarioState;
const rawLedger = (store: MemoryStore) => store.keys.get('gs_scenario_state');

/** A pass over `challenges`, with the missions read answered by `getMyMissions`. */
const passDeps = (
    challenges: Challenge[],
    getMyMissions: jest.Mock<Promise<unknown[]>, []> = jest.fn(async () => []),
): VotingPassDeps =>
    invalid<VotingPassDeps>({
        api: new Proxy(
            {
                getActiveChallenges: async () => ({ challenges }),
                getMyMissions,
                getVoteImages: async () => [],
            },
            {
                get: (target, key: string) =>
                    key in target ? target[key as keyof typeof target] : jest.fn(async () => null),
            },
        ),
        interChallengeDelay: async () => {},
        cleanupStaleMetadata: null,
        entryTracker: null,
        entryAges: null,
        currency: {
            strategy: { getBankroll: async () => null },
            swapLedger: null,
            spendLedger: null,
        },
        scenarios: { ledger: scenarioStateLedger },
    });

describe('published scenario settings', () => {
    let store: MemoryStore;

    beforeEach(async () => {
        mockLogs.length = 0;
        store = installHeadlessStore();
        // the ledger's cache outlives the store: start every test from no progress
        await scenarioStateLedger.removeAll();
        settings.setGlobalDefault('exposure', 30);
        settings.setGlobalDefault('exposureTarget', 100);
        settings.setChallengeOverride('exposure', String(OWNED), 40);
        settings.rememberChallengeTitles([
            { id: OWNED, title: 'Owned', type: 'regular' },
            { id: SIBLING, title: 'Sibling', type: 'regular' },
        ]);
    });

    afterEach(() => {
        removeHeadlessStore();
        settings.rememberChallengeTitles([]);
    });

    const assign = (doc: unknown = plan()) => {
        // A replacement states the revision of the collection it was edited on.
        expect(
            settings.saveScenario(doc, {
                expectedDefinitionRevision: settings.getScenarioLibrary().revision as number,
            }),
        ).toEqual({ ok: true, name: 'Plan' });
        settings.setChallengeOverride('scenario', String(OWNED), 'Plan');
    };

    test('a pass publishes the overlay of its phase, and every route reads it', async () => {
        assign();
        const result = await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(result.success).toBe(true);
        expect(state().published).toMatchObject({ revision: 2, phase: 'push', bindings: { exposure: 60 } });
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(60);
        expect(settings.getEffectiveSetting('exposureTarget', OWNED)).toBe(90);
        // the base view, and the stored override, are untouched
        expect(settings.readScenarioSetting('exposure', 'base', OWNED)).toMatchObject({ value: { value: 40 } });
        expect(settings.getChallengeOverrides(String(OWNED))).toMatchObject({ exposure: 40 });
    });

    test('an awaited pass keeps its own publication while a private preview with other evidence is built and disposed', async () => {
        assign();
        const release = deferred<unknown[]>();
        // the first look is quick; the second (after the rule fired) is held
        const getMyMissions = jest
            .fn<Promise<unknown[]>, []>()
            .mockResolvedValueOnce([])
            .mockImplementationOnce(() => release.promise);
        const pass = runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')], getMyMissions));
        await until(() => getMyMissions.mock.calls.length === 2);

        // the pass is mid-step: its first publication stands, and it is what a read gives
        const during = scenarioStateLedger.get(OWNED).state?.published;
        expect(during).toMatchObject({ revision: 1, bindings: { exposure: 60 } });
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(60);
        const before = rawLedger(store);

        // a private preview with different evidence: it prepares its own snapshot and drops it
        const scenario = settings.getScenario('Plan') as ScenarioDocument;
        const preview = settings.prepareScenarioSnapshot(
            OWNED,
            scenario,
            state(),
            () => ({
                bound: { exposure: known({ kind: 'number', value: 77, quantity: 'percent' }) },
                validUntil: null,
            }),
            NOW,
        );
        expect(preview).toMatchObject({ ok: true });
        if (!preview.ok) throw new Error('prepared');
        expect(preview.snapshot.readSetting('exposure', 'effective')).toMatchObject({ value: { value: 77 } });
        expect(preview.snapshot.publication).toMatchObject({ revision: 2, bindings: { exposure: 77 } });
        // a status read, and the typed read, are private as well
        expect(settings.scenarioOverlayStatus(OWNED)).toMatchObject({
            available: true,
            published: { revision: 1 },
        });
        expect(settings.readScenarioSetting('exposure', 'effective', OWNED)).toMatchObject({ value: { value: 60 } });

        // disposed: nothing written, replaced or cleared, and the pass still reads what it published
        expect(rawLedger(store)).toBe(before);
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(60);
        expect(scenarioStateLedger.get(OWNED).state?.published).toEqual(during);

        release.resolve([]);
        await expect(pass).resolves.toMatchObject({ success: true });
        // only the owner republished, from its own evidence
        expect(state().published).toMatchObject({ revision: 2, bindings: { exposure: 60 } });
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(60);
    });

    test('a second settings runtime over the same storage reads the publication and never publishes', async () => {
        assign();
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        const before = rawLedger(store);
        expect(before).toContain('"published"');

        let other!: typeof settings;
        let otherLedger!: typeof scenarioStateLedger;
        jest.isolateModules(() => {
            installHeadlessTestPlatform();
            other = require('../../src/ts/core/settings') as typeof settings;
            otherLedger = (require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule)
                .scenarioStateLedger;
        });
        // a runtime of its own: modules, caches and platform are not the first one's
        expect(other).not.toBe(settings);
        expect(otherLedger).not.toBe(scenarioStateLedger);

        expect(other.getEffectiveSetting('exposure', OWNED)).toBe(60);
        expect(other.getEffectiveSetting('exposureTarget', OWNED)).toBe(90);
        expect(other.scenarioSubjectAvailable(OWNED)).toBe(true);
        expect(other.readScenarioSetting('exposure', 'effective', OWNED)).toMatchObject({ value: { value: 60 } });
        // it may prepare a private snapshot, and drop it
        const scenario = other.getScenario('Plan') as ScenarioDocument;
        const prepared = other.prepareScenarioSnapshot(
            OWNED,
            scenario,
            otherLedger.get(OWNED).state as ScenarioState,
            () => ({
                bound: { exposure: known({ kind: 'number', value: 55, quantity: 'percent' }) },
                validUntil: null,
            }),
            NOW,
        );
        expect(prepared).toMatchObject({ ok: true });
        // nothing it did wrote the shared ledger
        expect(rawLedger(store)).toBe(before);
        expect(scenarioStateLedger.get(OWNED).state?.published).toMatchObject({ bindings: { exposure: 60 } });
    });

    const exposureIs = (value: number) => ({
        type: 'compare',
        left: { kind: 'setting', key: 'exposure', view: 'effective' },
        op: '=',
        right: { kind: 'literal', value, quantity: 'percent' },
    });

    test('a phase change republishes before the next phase evaluates, in the same pass', async () => {
        assign({
            name: 'Plan',
            version: 1,
            start: 'push',
            phases: {
                push: {
                    settings: { exposureTarget: 90 },
                    bindings: { exposure: plus('exposure', 20) },
                    rules: [{ id: 'go', repeat: 'once', do: [{ type: 'goto', phase: 'next' }] }],
                },
                next: {
                    settings: { exposureTarget: 95 },
                    bindings: { exposure: plus('exposure', 30) },
                    // its condition reads the effective exposure: only the new phase's overlay makes it 70
                    rules: [
                        { id: 'seen', repeat: 'once', if: [exposureIs(70)], do: [{ type: 'notify', message: 'x' }] },
                    ],
                },
            },
        });
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(Object.keys(state().fired).sort()).toEqual(['go', 'seen']);
        expect(state().phase).toBe('next');
        // published for the first phase, for the second, and once more after its rule landed
        expect(state().published).toMatchObject({ revision: 3, phase: 'next', bindings: { exposure: 70 } });
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(70);
        expect(settings.getEffectiveSetting('exposureTarget', OWNED)).toBe(95);
    });

    test('leaving a bound phase for one with literals only clears the publication; its rules read the effective values', async () => {
        assign({
            name: 'Plan',
            version: 1,
            start: 'push',
            phases: {
                push: {
                    bindings: { exposure: plus('exposure', 20) },
                    settings: { exposureTarget: 90 },
                    rules: [{ id: 'go', repeat: 'once', do: [{ type: 'goto', phase: 'plain' }] }],
                },
                plain: {
                    settings: { exposure: 10, exposureTarget: 12 },
                    rules: [
                        { id: 'seen', repeat: 'once', if: [exposureIs(10)], do: [{ type: 'notify', message: 'x' }] },
                    ],
                },
            },
        });
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(state().fired.seen).toBeDefined();
        expect(state().published).toBeUndefined();
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(true);
        expect(settings.getEffectiveSetting('exposure', OWNED)).toBe(10);
    });

    test('a conflict between the resolved values blocks the phase', async () => {
        // exposure 40 + 70 = 110% is not a percentage
        assign(plan({ exposure: plus('exposure', 70) }));
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(state().published).toBeUndefined();
        expect(state().lastError?.message).toContain('exposure');
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(false);
    });

    test('the publication is valid until the next instant its bindings stand for', async () => {
        const unit = (value: number, name: string) => ({ kind: 'literal', value, quantity: 'duration', unit: name });
        const hours = (value: number) => unit(value, 'hours');
        const seconds = (value: number) => unit(value, 'seconds');
        const end = { kind: 'fact', name: 'challenge.end' };
        const beforeEnd = (by: number) => ({ kind: 'offset', from: end, by: hours(by), direction: 'before' });
        const expressions: Record<string, unknown> = {
            // two hours between "two hours before the end" and the end
            boostTime: { kind: 'difference', from: beforeEnd(2), to: end },
            // the smaller of two waits, the larger of two thresholds, a difference of durations
            boostFreshEntryWait: { kind: 'min', of: [seconds(60), seconds(30)] },
            lastMinuteThreshold: { kind: 'max', of: [unit(5, 'minutes'), unit(7, 'minutes')] },
            turboTime: { kind: 'subtract', left: seconds(100), right: seconds(40) },
            // one hour between the earlier and the later of two instants
            keyUnlockedBoostTime: {
                kind: 'difference',
                from: { kind: 'earlier', of: [end, beforeEnd(1)] },
                to: { kind: 'later', of: [end, beforeEnd(1)] },
            },
        };
        assign(plan(invalid<Record<string, ScenarioExpr>>(expressions), {}));
        const owned = quiet(OWNED, 'Owned');
        await runVotingPass('tok', null, passDeps([owned]));
        expect(state().published).toMatchObject({
            validUntil: owned.close_time - 7200,
            bindings: {
                boostTime: 7200,
                boostFreshEntryWait: 30,
                lastMinuteThreshold: 7,
                turboTime: 60,
                keyUnlockedBoostTime: 3600,
            },
        });
        expect(settings.getEffectiveSetting('boostTime', OWNED)).toBe(7200);
        expect(settings.getEffectiveSetting('lastMinuteThreshold', OWNED)).toBe(7);
    });

    /** The real ledger, but a write the test names fails (as a held lock or a full disk would make it). */
    const failingLedger = (fails: (written: ScenarioState) => boolean) => ({
        ...scenarioStateLedger,
        set: (id: string | number, written: ScenarioState) =>
            fails(written) ? ('failed' as const) : scenarioStateLedger.set(id, written),
    });

    const passWith = (ledger: ReturnType<typeof failingLedger>) => {
        const deps = passDeps([quiet(OWNED, 'Owned')]);
        return runVotingPass('tok', null, { ...deps, scenarios: { ledger } });
    };

    test('a publication that could not be saved leaves no rule run and the challenge unavailable', async () => {
        assign();
        await expect(passWith(failingLedger((written) => written.published !== undefined))).resolves.toMatchObject({
            success: true,
        });
        expect(state().published).toBeUndefined();
        expect(state().fired).toEqual({});
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(false);
    });

    test('a stale publication that could not be cleared is still never read: the document changed', async () => {
        assign();
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        const stale = state().published;
        assign(blockedPlan({ profile: 'Missing' }));
        // only the write that clears it fails
        await passWith(failingLedger((written) => written.published === undefined));
        expect(state().published).toEqual(stale);
        expect(state().lastError).toBeNull();
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(false);
        expect(() => settings.getEffectiveSetting('exposure', OWNED)).toThrow(settings.ScenarioSettingUnavailableError);
    });

    test('bindings that stand for no future instant never expire', async () => {
        assign();
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(state().published?.validUntil).toBeNull();
    });

    /** The phase's bindings and profile are the whole difference between the blocked plans below. */
    const blockedPlan = (phase: Record<string, unknown>) => ({
        name: 'Plan',
        version: 1,
        start: 'push',
        phases: { push: { rules: [{ id: 'tell', do: [{ type: 'notify', message: 'never' }] }], ...phase } },
    });

    const expectBlocked = async (reason: string) => {
        const challenges = [quiet(OWNED, 'Owned'), quiet(SIBLING, 'Sibling')];
        const result = await runVotingPass('tok', null, passDeps(challenges));
        expect(result.success).toBe(true);

        // nothing is published, the reason is recorded, no rule ran
        expect(state().published).toBeUndefined();
        expect(state().lastError?.message).toContain(reason);
        expect(state().outbox?.some((notice) => notice.message.includes(reason))).toBe(true);

        // no inherited value anywhere: the getter throws, the typed read is unknown, the status says why
        expect(() => settings.getEffectiveSetting('exposure', OWNED)).toThrow(settings.ScenarioSettingUnavailableError);
        expect(settings.readScenarioSetting('exposure', 'effective', OWNED)).toMatchObject({ state: 'unknown' });
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(false);
        expect(settings.scenarioOverlayStatus(OWNED)).toMatchObject({ bound: true, available: false });

        // the pass skipped that challenge, said so, and went on to the next
        expect(mockLogs.some((line) => line.msg.includes('Owned') && line.msg.includes('settings unavailable'))).toBe(
            true,
        );
        expect(mockLogs.some((line) => line.msg.includes('Processing challenge 2/2: Sibling'))).toBe(true);
        expect(mockLogs.some((line) => line.msg.includes('Skipped after an unexpected error'))).toBe(false);
    };

    test('a binding that cannot be resolved exposes no inherited value, and the pass skips only that challenge', async () => {
        // the balance cannot be read, so the swap cap bound to it is unknown
        assign(blockedPlan({ bindings: { autoSwapMax: { kind: 'fact', name: 'balance.swaps' } } }));
        await expectBlocked('autoSwapMax');
        // no rule ran for the blocked phase
        expect(state().fired).toEqual({});
    });

    test('a stale publication is cleared when the phase can no longer be prepared', async () => {
        assign();
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(state().published).toBeDefined();
        // the plan is edited so that its phase names a profile that does not exist
        assign(blockedPlan({ profile: 'Missing' }));
        await expectBlocked('profile-unavailable: Missing');
    });

    test('once the cause is gone the next pass publishes again and the challenge is back', async () => {
        assign(blockedPlan({ profile: 'Tactic' }));
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(false);
        expect(settings.saveChallengeProfile('Tactic', { boostTime: 120 })).toBe(true);
        await runVotingPass('tok', null, passDeps([quiet(OWNED, 'Owned')]));
        expect(settings.scenarioSubjectAvailable(OWNED)).toBe(true);
        expect(settings.getEffectiveSetting('boostTime', OWNED)).toBe(120);
        expect(state().published).toMatchObject({ profile: 'Tactic' });
    });
});
