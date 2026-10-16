/**
 * The live settings code behind the oracle's method surface (tests/helpers/v1Oracle), so the equivalence harness
 * compares the two call for call. A reader is built from the text of a format-1 `settings.json` and an environment (the
 * active challenge list, the scenario ledger) by `liveFromV1Raw`: the real upgrade path. The text is put where
 * `settings.json` lives and there is no `config.json`, so the first read through the settings facade runs the
 * one-time import (title pins, the configuration and the marker land in the stores) and every later read is of the
 * configuration that made.
 *
 * The live code is read through the settings facade and the live services, with the storage of the Android background
 * service pointed at an in-memory bridge (so no file is touched), the scenario ledger replaced by the environment's,
 * and the modules reloaded for every reader (their caches would otherwise carry from one blob to the next). Setting
 * names go through `liveKey`.
 */

import { V1_KEY_RENAMES } from '../../../src/ts/settings/importV1';
import { invalid } from '../../helpers/invalid';

import type * as joinModule from '../../../src/ts/services/joinChallenges/settingsResolution';
import type * as scenarioStatusModule from '../../../src/ts/services/scenarioStatus';
import type * as settingsModule from '../../../src/ts/settings';
import type * as challengeFactsModule from '../../../src/ts/settings/challengeFacts';
import type * as ruleBehaviourModule from '../../../src/ts/settings/ruleBehaviour';
import type { AndroidHeadlessStore } from '../../../src/ts/types/settings';
import type { ScenarioStateLedger } from '../../../src/ts/types/votingPass';
import type { Customization, OracleEnv, V1Oracle } from '../../helpers/v1Oracle';

/** The live name of a format-1 setting key: the harness always compares `live[liveKey(k)]` with `oracle[k]`. */
const liveKey = (v1Key: string): string => (Object.hasOwn(V1_KEY_RENAMES, v1Key) ? V1_KEY_RENAMES[v1Key] : v1Key);

/**
 * The native side of the Android service, in memory: `settings.json` under its Preferences key, nothing else stored.
 * `read` / `write` are the configuration's dedicated pair (a write saves only while the key holds what the latest read
 * answered); the keyed calls are the legacy settings and the marker and pin stores.
 */
const memoryBridge = (legacyText: string): AndroidHeadlessStore => {
    const keys = new Map<string, string>([['gurushots-settings', legacyText]]);
    let lastRead: string | null = null;
    return {
        read: () => {
            lastRead = keys.get('gurushots-config') ?? null;
            return lastRead;
        },
        write: (data) => {
            if ((keys.get('gurushots-config') ?? null) !== lastRead) return false;
            keys.set('gurushots-config', data);
            lastRead = data;
            return true;
        },
        lastWriteRefusal: () => '',
        readKey: (key) => keys.get(key) ?? null,
        writeKey: (key, data) => {
            keys.set(key, data);
            return true;
        },
        compareAndWriteKey: (key, expected, data) => {
            if ((keys.get(key) ?? '') !== expected) return false;
            keys.set(key, data);
            return true;
        },
    };
};

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
    const store = memoryBridge(text);
    // Every call points the global storage and the ledger at this reader first: readers are used one at a time but
    // the globals are shared.
    const live = <A extends unknown[], R>(call: (...args: A) => R) => {
        return (...args: A): R => {
            headless.__GS_HEADLESS__ = true;
            headless.AndroidHeadlessStore = store;
            active.ledger = env.ledger;
            const result = call(...args);
            // A fixture whose import failed silently would read defaults, and defaults can equal the oracle's answer.
            const recovery = settings.getSettingsRecovery();
            if (recovery) throw new Error(`the import of the fixture did not complete: ${JSON.stringify(recovery)}`);
            return result;
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
            const title = challengeFacts.challengeTargetForId(challengeId).title;
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

/** The live app upgrading from `raw`, a format-1 `settings.json`, and reading what it made of it. */
const liveFromV1Raw = (raw: string, env: OracleEnv): V1Oracle => openLive(raw, env);

/**
 * The `settings.json` the live app leaves for `raw` once it has imported it and saved: the mirror an older build reads.
 */
const mirrorOfRaw = (raw: string): string => {
    const { settings } = loadModules();
    const store = memoryBridge(raw);
    headless.__GS_HEADLESS__ = true;
    headless.AndroidHeadlessStore = store;
    try {
        settings.loadSettings();
        // A save of what is there: the configuration is written and the mirror made from it.
        settings.saveAppSettings({});
        const recovery = settings.getSettingsRecovery();
        if (recovery) throw new Error(`the import of the fixture did not complete: ${JSON.stringify(recovery)}`);
        return store.readKey?.('gurushots-settings') ?? '';
    } finally {
        releaseLive();
    }
};

export { liveFromV1Raw, liveKey, mirrorOfRaw, releaseLive };
