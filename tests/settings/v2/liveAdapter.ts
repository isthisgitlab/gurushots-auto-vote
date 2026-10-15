/**
 * The live settings code behind the oracle's method surface (tests/helpers/v1Oracle), so the equivalence harness
 * compares the two call for call. A reader is built from the text of a 1.x `settings.json` and an environment (the
 * active challenge list, the scenario ledger) by one of two constructors:
 *
 *   - `liveFromV1Raw`: the live app reading that `settings.json` today.
 *   - `liveViaImporter`: the same code reading what `importV1Settings` made of it, mapped back to a 1.x-shaped blob
 *     by `v1ViewOf`, so it proves the importer loses nothing resolution depends on.
 *
 * The live code is read through the settings facade and the live services, with the raw text in the in-memory
 * store the Android background service uses (so no file is touched), the scenario ledger replaced by the
 * environment's, and the modules reloaded for every reader (their caches would otherwise carry from one blob to the
 * next). Setting names go through `liveKey`.
 */

import { isPlainObject } from '../../../src/ts/plainObject';
import { importV1Settings, V1_KEY_RENAMES } from '../../../src/ts/settings/importV1';
import { V1_MIGRATION_FLAGS } from '../../../src/ts/settings/importV1/migrations';
import { invalid } from '../../helpers/invalid';

import type * as joinModule from '../../../src/ts/services/joinChallenges/settingsResolution';
import type * as scenarioStatusModule from '../../../src/ts/services/scenarioStatus';
import type * as settingsModule from '../../../src/ts/settings';
import type * as challengeFactsModule from '../../../src/ts/settings/challengeFacts';
import type * as ruleBehaviourModule from '../../../src/ts/settings/ruleBehaviour';
import type { ConfigV2 } from '../../../src/ts/types/config';
import type { AndroidHeadlessStore } from '../../../src/ts/types/settings';
import type { ScenarioStateLedger } from '../../../src/ts/types/votingPass';
import type { Customization, OracleEnv, V1Oracle } from '../../helpers/v1Oracle';

/** The live name of a 1.x setting key: the harness always compares `live[liveKey(k)]` with `oracle[k]`. */
const liveKey = (v1Key: string): string => (Object.hasOwn(V1_KEY_RENAMES, v1Key) ? V1_KEY_RENAMES[v1Key] : v1Key);

const headless = globalThis as typeof globalThis & {
    __GS_HEADLESS__?: boolean;
    AndroidHeadlessStore?: AndroidHeadlessStore;
};

// The ledger the mocked scenario-state store answers from: the environment of the reader being called.
const active: { ledger: OracleEnv['ledger'] } = { ledger: {} };

const ledgerGet = (challengeId: string | number) => {
    const key = String(challengeId);
    const entry = Object.hasOwn(active.ledger, key) ? active.ledger[key] : { corrupt: false as const, state: null };
    return { corrupt: entry.corrupt, state: entry.state, epoch: { all: 0, gen: 0 } };
};
const ledger = invalid<ScenarioStateLedger>({ get: ledgerGet });

type Modules = {
    settings: typeof settingsModule;
    join: typeof joinModule;
    scenarioStatus: typeof scenarioStatusModule;
    ruleBehaviour: typeof ruleBehaviourModule;
    challengeFacts: typeof challengeFactsModule;
};

const loadModules = (): Modules => {
    // The facade resolves Electron's app paths; the real package would try to fetch its binary.
    jest.doMock('electron', () => ({}));
    jest.doMock('../../../src/ts/scenarioStateStore', () => ({
        __esModule: true,
        scenarioStateLedger: { get: ledgerGet },
        mockScenarioStateLedger: { get: ledgerGet },
        scenarioStepLock: () => ({ ok: true, release: () => {} }),
    }));
    let modules: Modules | null = null;
    jest.isolateModules(() => {
        modules = {
            settings: require('../../../src/ts/settings') as typeof settingsModule,
            join: require('../../../src/ts/services/joinChallenges/settingsResolution') as typeof joinModule,
            scenarioStatus: require('../../../src/ts/services/scenarioStatus') as typeof scenarioStatusModule,
            ruleBehaviour: require('../../../src/ts/settings/ruleBehaviour') as typeof ruleBehaviourModule,
            challengeFacts: require('../../../src/ts/settings/challengeFacts') as typeof challengeFactsModule,
        };
    });
    if (!modules) throw new Error('the live modules did not load');
    return modules;
};

/** Stop pointing the live storage at an in-memory store (the harness calls it when it is done). */
const releaseLive = () => {
    delete headless.__GS_HEADLESS__;
    delete headless.AndroidHeadlessStore;
    jest.useRealTimers();
};

/**
 * The live code reading `text` as its settings file. The one place the harness decides how the live app comes to
 * hold a blob.
 */
const openLive = (text: string, env: OracleEnv): V1Oracle => {
    jest.useFakeTimers({ now: env.now * 1000, doNotFake: ['performance', 'hrtime', 'nextTick', 'queueMicrotask'] });
    const { settings, join, scenarioStatus, ruleBehaviour, challengeFacts } = loadModules();
    let stored: string | null = text;
    const store: AndroidHeadlessStore = {
        read: () => stored,
        write: (data) => {
            stored = data;
        },
    };
    // Every call points the global storage and the ledger at this reader first: readers are used one at a time but
    // the globals are shared.
    const live = <A extends unknown[], R>(call: (...args: A) => R) => {
        return (...args: A): R => {
            headless.__GS_HEADLESS__ = true;
            headless.AndroidHeadlessStore = store;
            active.ledger = env.ledger;
            return call(...args);
        };
    };
    live(() => settings.rememberChallengeTitles(invalid(env.challenges)))();

    const titleProfile: V1Oracle['titleProfile'] = live((target, challengeId = null) =>
        settings.getTitleProfile(invalid(target), challengeId),
    );
    const customization: V1Oracle['customization'] = live((challengeId, title): Customization => {
        // The classification of react/hooks/useCustomizedChallengeIds.ts, over the live facade.
        const overrides = settings.getChallengeOverrides(challengeId);
        const rules = settings.getTitleProfile(title, challengeId);
        const manual = Object.keys(overrides).length > 0;
        const automatic = rules.profile != null && !rules.suppressed;
        if (manual) return automatic ? 'both' : 'manual';
        if (automatic) return 'profile';
        return ruleBehaviour.hasPostJoinInlineValue(rules.inlineValues) ? 'rule' : null;
    });

    return {
        effective: live((key, challengeId = null) => settings.getEffectiveSetting(key, challengeId)),
        ruleTags: live((key, challenge) => settings.getEffectiveTagSetting(key, invalid(challenge))),
        ignoreTitleWords: live((challenge) => settings.getEffectiveIgnoreTitleWords(invalid(challenge))),
        ruleValues: live((target, suppress = false) => {
            const info = settings.getTitleProfile(invalid(target));
            return suppress
                ? { values: info.inlineValues, sources: info.inlineSources, profile: null }
                : { values: info.ruleValues, sources: info.ruleSources, profile: info.profile };
        }),
        ruleProfile: live((target) => settings.getTitleProfile(invalid(target)).profile),
        titleProfile,
        profiles: live(() => settings.getChallengeProfiles()),
        challengeOverrides: live((challengeId) => settings.getChallengeOverrides(challengeId)),
        joinSetting: live((key, challenge) => join.resolveJoinSetting(key, invalid(challenge))),
        anyRuleEnablesAutoJoin: live(() => join.anyTitleRuleEnablesAutoJoin()),
        autoJoinActive: live(() => join.isAutoJoinActive()),
        ruleJoinOptIn: live((challenge) => settings.hasRuleJoinOptIn(invalid(challenge))),
        customization,
        scenarioStatus: live((challengeId) => {
            const status = scenarioStatus.getScenarioStatus(challengeId, ledger);
            const { scenario, state } = status;
            return {
                assigned: status.assigned,
                scenario: scenario?.name ?? null,
                phase: state?.phase ?? null,
                corrupt: status.corrupt,
                phaseMissing: Boolean(scenario && state && !status.corrupt && !scenario.phases[state.phase]),
            };
        }),
        entryPin: live((challengeId) => settings.getEntryPins(challengeId)),
        titleOf: live((challengeId) => {
            const title = challengeFacts.challengeTargetForId(settings.loadSettings(), challengeId).title;
            return typeof title === 'string' ? title : '';
        }),
        scenarios: live(() =>
            Object.fromEntries(
                Object.values(settings.getScenarios()).map((scenario) => [
                    scenario.name,
                    {
                        start: scenario.start,
                        phases: Object.fromEntries(
                            Object.entries(scenario.phases).map(([name, phase]) => [
                                name,
                                Object.keys(phase.settings ?? {}).sort(),
                            ]),
                        ),
                    },
                ]),
            ),
        ),
    };
};

/** The live app reading `raw` as its `settings.json`. */
const liveFromV1Raw = (raw: string, env: OracleEnv): V1Oracle => openLive(raw, env);

// 2.x key -> 1.x key.
const V1_KEY_OF: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(V1_KEY_RENAMES).map(([v1, v2]) => [v2, v1]),
);

const v1KeysOf = (values: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
        Object.entries(values).map(([key, value]) => [Object.hasOwn(V1_KEY_OF, key) ? V1_KEY_OF[key] : key, value]),
    );

const v1ValueOf = (value: unknown): unknown => (isPlainObject(value) ? v1KeysOf(value) : value);

const v1ScenarioOf = (doc: unknown): unknown => {
    if (!isPlainObject(doc) || !isPlainObject(doc.phases)) return doc;
    const phases = Object.fromEntries(
        Object.entries(doc.phases).map(([name, phase]) => [
            name,
            isPlainObject(phase) && isPlainObject(phase.settings)
                ? { ...phase, settings: v1KeysOf(phase.settings) }
                : phase,
        ]),
    );
    return { ...doc, phases };
};

const mapValues = (value: Record<string, unknown>, convert: (item: unknown) => unknown): Record<string, unknown> =>
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item)]));

/**
 * A 2.x configuration (and the title pins kept beside it) as the 1.x settings blob it came from: the keys renamed
 * back, `challenges` split again into `perChallenge`, `titleProfileSuppressions` and `entryPins`, the sign-in state
 * put back among the top-level keys, every migration marked done (the converted values are already migrated). Test
 * only: it exists to run the 1.x resolver over what the importer made.
 */
const v1ViewOf = (config: ConfigV2, titlePins: Record<string, string>): Record<string, unknown> => {
    const perChallenge: Record<string, unknown> = {};
    const titleProfileSuppressions: Record<string, unknown> = {};
    const entryPins: Record<string, unknown> = {};
    for (const [id, record] of Object.entries(config.challenges)) {
        if (record.values !== undefined) perChallenge[id] = v1KeysOf(record.values);
        if (record.suppressRuleProfile) titleProfileSuppressions[id] = true;
        if (record.pins !== undefined) entryPins[id] = record.pins;
    }
    return {
        ...v1KeysOf(config.app),
        ...config.auth,
        ...Object.fromEntries(V1_MIGRATION_FLAGS.map((flag) => [flag, true])),
        challengeSettings: {
            globalDefaults: v1KeysOf(config.defaults),
            perChallenge,
            titleRules: config.rules.map(v1ValueOf),
            titleProfileSuppressions,
            entryPins,
            profiles: mapValues(config.profiles, v1ValueOf),
            seededProfiles: config.seededProfiles,
            scenarios: mapValues(config.scenarios, v1ScenarioOf),
            titlePins,
        },
    };
};

/** The live code reading what the importer made of `raw`, mapped back to a 1.x-shaped blob. Deleted in phase B. */
const liveViaImporter = (raw: string, env: OracleEnv): V1Oracle => {
    const result = importV1Settings(raw);
    if (!result.ok) throw new Error(`the importer refused the file: ${result.code}: ${result.detail}`);
    return openLive(JSON.stringify(v1ViewOf(result.config, result.titlePins)), env);
};

export { liveFromV1Raw, liveKey, liveViaImporter, releaseLive, v1ViewOf };
