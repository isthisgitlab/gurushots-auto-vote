/**
 * Parity guards across the scenario surfaces: a new setting, fact or action cannot silently lack a place on one of them.
 *
 * The other halves live where they are cheapest to keep: the capability catalogue against the schema
 * (tests/settings/scenario-capabilities.test.ts), the builder's forms and translations (tests/scenarios/builderSpec.test.ts),
 * the CLI command rows against the IPC manifest (tests/cli/cli-parity.test.ts), english against latvian
 * (tests/translations/translation-parity.test.ts) and the remote classification of every IPC channel
 * (tests/remote/allowlist.test.ts). This file adds what none of them states: the reference the CLI prints, the labels of the
 * settings the builder offers, the facts the builder can reach, and what a simulation does with each action.
 */

import spec = require('../../src/ts/core/scenarios/builderSpec');
import vocabulary = require('../../src/ts/core/scenarios/vocabulary');
import english = require('../../src/ts/core/translations/english');
import latvian = require('../../src/ts/core/translations/latvian');
import { invalid } from '../helpers/invalid';
import type * as factsModule from '../../src/ts/core/scenarios/facts';
import type * as settingsModule from '../../src/ts/core/settings';
import type * as actionsModule from '../../src/ts/core/services/scenarioRunner/actions';
import type * as phaseActionsModule from '../../src/ts/core/services/scenarioRunner/phaseActions';
import type { AccountContext } from '../../src/ts/core/services/scenarioRunner/types';
import type { ScenarioState } from '../../src/ts/core/types/stores';

const { FACTS } = require('../../src/ts/core/scenarios/facts') as typeof factsModule;
const settings = require('../../src/ts/core/settings') as typeof settingsModule;
const { ACTIONS } = require('../../src/ts/core/services/scenarioRunner/actions') as typeof actionsModule;
const { PHASE_ACTIONS } =
    require('../../src/ts/core/services/scenarioRunner/phaseActions') as typeof phaseActionsModule;

const rows = settings.getScenarioCapabilities().settings;
const referenced = (kind: string) =>
    new Set(vocabulary.VOCABULARY_REFERENCE.filter(([itemKind]) => itemKind === kind).map(([, type]) => type));

describe('the reference the CLI prints names every piece of the vocabulary', () => {
    test('every action a stage offers', () => {
        const listed = referenced('action');
        const missing = [...new Set(Object.values(vocabulary.STAGE_ACTIONS).flat())].filter(
            (type) => !listed.has(type),
        );
        expect(missing).toEqual([]);
    });

    test('every condition and selector the builder has a form for, and the ones that hold others', () => {
        const conditions = referenced('condition');
        const selectors = referenced('selector');
        expect(spec.CONDITION_TYPES.filter((type) => !conditions.has(type))).toEqual([]);
        expect(spec.SELECTOR_TYPES.filter((type) => !selectors.has(type))).toEqual([]);
        for (const type of ['all', 'any', 'not']) expect(conditions.has(type)).toBe(true);
    });

    test('every kind of live value', () => {
        const listed = referenced('expression');
        expect(spec.EXPRESSION_KINDS.filter((kind) => !listed.has(kind))).toEqual([]);
    });

    test('every fact: the fact row lists its name', () => {
        const row = vocabulary.VOCABULARY_REFERENCE.find(([kind, type]) => kind === 'expression' && type === 'fact');
        const missing = vocabulary.FACT_NAMES.filter((name) => !row?.[2].includes(name));
        expect(missing).toEqual([]);
    });

    test('no reference row names a piece the validator does not know', () => {
        const known = new Set<string>([
            ...Object.values(vocabulary.STAGE_ACTIONS).flat(),
            ...spec.CONDITION_TYPES,
            ...spec.SELECTOR_TYPES,
            ...spec.EXPRESSION_KINDS,
            'all',
            'any',
            'not',
        ]);
        const pieces = new Set(['condition', 'selector', 'action', 'expression']);
        const stray = vocabulary.VOCABULARY_REFERENCE.filter(([kind, type]) => pieces.has(kind) && !known.has(type));
        expect(stray).toEqual([]);
    });
});

describe('the settings the builder offers are named in both languages', () => {
    const offered = rows.filter(
        (row) => row.phaseWrite.length > 0 || (row.read === 'value' && row.value.kind !== 'other'),
    );

    test('the builder offers a setting a phase may write or a live value may read: both are non-empty sets', () => {
        expect(offered.length).toBeGreaterThan(0);
        expect(offered.some((row) => row.phaseWrite.includes('installation'))).toBe(true);
        expect(offered.some((row) => row.phaseWrite.includes('challenge'))).toBe(true);
    });

    // A setting without a label would show its raw key in the builder.
    test.each([
        ['english', english],
        ['latvian', latvian],
    ])('%s has a label for each', (_language, table) => {
        const labels = table.app as Record<string, unknown>;
        expect(offered.map((row) => row.key).filter((key) => typeof labels[key] !== 'string')).toEqual([]);
    });
});

describe('every fact can be picked in the builder', () => {
    // The expression editor lists a fact under an expected type when the fact gives that type and runs in the rule's stages.
    const expectations = [...vocabulary.QUANTITIES, 'boolean', 'string', 'list'] as const;

    test('each fact gives some type the editor asks for, and runs in at least one stage', () => {
        const unreachable = vocabulary.FACT_NAMES.filter(
            (name) =>
                FACTS[name].stages.length === 0 || !expectations.some((expected) => spec.factGives(name, expected)),
        );
        expect(unreachable).toEqual([]);
    });
});

const noController = invalid<AccountContext>({ autovote: null });
const noState = invalid<ScenarioState>({});

describe('a simulation runs every action, or says it does not', () => {
    const everyAction = [...new Set(Object.values(vocabulary.STAGE_ACTIONS).flat())].sort();

    // The actions that run in a simulation exactly as they do live: through the runner, over the memory stores.
    const SIMULATED = [
        'boost',
        'claimChallengeReward',
        'claimMissionReward',
        'clearPin',
        'clearSetting',
        'earnTurbo',
        'enterPhoto',
        'fillExposure',
        'forget',
        'goto',
        'join',
        'notify',
        'pauseScenario',
        'remember',
        'runAutomation',
        'setPin',
        'setSetting',
        'swap',
        'turbo',
        'unlockBoost',
        'useProfile',
        'vote',
    ];
    // The actions that reach beyond what a simulation may touch. handoffScenario fails its step in a simulation (pinned in
    // tests/integration/scenarioSimulationParity.test.ts); the two below are skipped, as no autovote controller is asked.
    const NOT_SIMULATED = ['handoffScenario', 'startAutovote', 'stopAutovote'];

    test('every action a stage offers is in exactly one of the two lists', () => {
        expect([...SIMULATED, ...NOT_SIMULATED].sort()).toEqual(everyAction);
        expect(SIMULATED.filter((type) => NOT_SIMULATED.includes(type))).toEqual([]);
    });

    test('the runner holds a handler for each of them: the one a simulation shares with a live pass', () => {
        expect(Object.keys(ACTIONS).sort()).toEqual(everyAction);
        for (const type of Object.keys(PHASE_ACTIONS)) expect(Object.keys(ACTIONS)).toContain(type);
    });

    test.each([
        ['startAutovote', () => PHASE_ACTIONS.startAutovote({ type: 'startAutovote' }, noController, noState)],
        ['stopAutovote', () => PHASE_ACTIONS.stopAutovote({ type: 'stopAutovote' }, noController, noState)],
    ])('%s asks no controller where there is none, and says so', async (_type, run) => {
        expect(await run()).toEqual({ status: 'skipped', message: 'this runtime has no autovote controller' });
    });
});
