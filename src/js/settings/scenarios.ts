/**
 * User-defined scenarios (see scenarios/vocabulary.ts): list, save, rename,
 * delete, and the JSON import/export players use to share them. Stored in the
 * settings blob as `challengeSettings.scenarios` — name-keyed like profiles,
 * because challenge ids rotate — so the Android background service, which
 * persists only the settings blob, has the definitions too.
 *
 * Every stored document is re-validated on read: the blob may be hand-edited
 * or older than the current vocabulary, and the engine must never run a
 * document the validator would refuse.
 */

import * as logger from '../logger';
import { SCENARIO_CAPS, SPENDING_ACTIONS, isOneOf } from '../scenarios/vocabulary';
import { loadSettings, saveSettings } from './persistence';
import { globalChallengeValues } from './defaults';
import { normalizeProfileName, profileNameForLog, findProfileKey } from './profileStore';
import { validateScenario, parseScenarioJson } from './scenarioSchema';
import { sanitizeTitleRuleInline } from './titleRuleSanitize';
import { isPlainObject } from '../plainObject';

import type { AppSettings, ChallengeValues, TitleRule } from '../types/settings';
import type { ScenarioDocument, ScenarioIssue } from './scenarioSchema';

type ScenarioSaveResult = { ok: true; name: string } | { ok: false; issues: ScenarioIssue[] };

const MAX_SCENARIOS = SCENARIO_CAPS.scenarios;

const log = () => logger.withCategory('settings');

/**
 * The stored scenarios map when it is a plain object, else `{}`.
 */
const readScenariosMap = (settings: AppSettings): Record<string, unknown> => {
    const stored = settings.challengeSettings?.scenarios;
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
};

// Read-side validation runs on every lookup (the engine resolves a scenario
// per challenge per pass), so results are memoized by the stored document and
// the global defaults its phase settings are checked against.
const VALIDATION_CACHE_LIMIT = 200;
const validationCache: Map<string, ReturnType<typeof validateScenario>> = new Map();

const validateStored = (raw: unknown, globalDefaults: ChallengeValues): ReturnType<typeof validateScenario> => {
    const key = JSON.stringify([raw, globalDefaults]);
    if (!validationCache.has(key)) {
        if (validationCache.size >= VALIDATION_CACHE_LIMIT) validationCache.clear();
        validationCache.set(key, validateScenario(raw, globalDefaults));
    }
    return validationCache.get(key) as ReturnType<typeof validateScenario>;
};

/**
 * The valid stored scenario named `name` (case-insensitive) in an already
 * loaded settings object, or null. Not a copy — callers only read it. Used by
 * the phase-settings overlay, which must not load settings a second time.
 */
const findStoredScenario = (settings: AppSettings, name: unknown): ScenarioDocument | null => {
    const stored = readScenariosMap(settings);
    const key = findProfileKey(stored, normalizeProfileName(name));
    if (key === null) return null;
    const result = validateStored(stored[key], globalChallengeValues(settings));
    return result.ok ? result.scenario : null;
};

/**
 * True when any scenario is stored at all — lets hot paths skip the overlay cheaply.
 */
const hasStoredScenarios = (settings: AppSettings): boolean => Object.keys(readScenariosMap(settings)).length > 0;

/**
 * Valid stored scenarios as `{ [name]: document }` (defensive copies). A
 * stored document that no longer validates is left out — and logged — rather
 * than run.
 */
const getScenarios = (): Record<string, ScenarioDocument> => {
    const settings = loadSettings();
    const globalDefaults = globalChallengeValues(settings);
    const scenarios: Record<string, ScenarioDocument> = {};
    for (const [name, raw] of Object.entries(readScenariosMap(settings))) {
        const result = validateStored(raw, globalDefaults);
        if (result.ok) {
            scenarios[result.scenario.name] = structuredClone(result.scenario);
        } else {
            log().warning(`Stored scenario "${profileNameForLog(name)}" is invalid and was skipped`, result.issues);
        }
    }
    return scenarios;
};

/**
 * One valid scenario by name (case-insensitive), or null.
 */
const getScenario = (name: unknown): ScenarioDocument | null => {
    if (!normalizeProfileName(name)) return null;
    // Looks up and copies just this one — the engine and the scheduler call it
    // per challenge per pass.
    const scenario = findStoredScenario(loadSettings(), name);
    return scenario ? structuredClone(scenario) : null;
};

const failure = (issues: ScenarioIssue[]): { ok: false; issues: ScenarioIssue[] } => ({ ok: false, issues });

const plainObject = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {});

// A rule keeps its row only while it still contributes something: a profile,
// tags, or a valid inline value.
const ruleHasBehaviour = (rule: TitleRule): boolean => {
    const hasTags = ['mustIncludeTags', 'shouldIncludeTags'].some(
        (key) => Array.isArray(rule[key]) && rule[key].length > 0,
    );
    const inline = sanitizeTitleRuleInline(rule);
    return Boolean(rule.profile) || hasTags || (inline !== null && Object.keys(inline).length > 0);
};

/**
 * Point every assignment of scenario `fromName` — per-challenge overrides,
 * profiles and challenge rules — at `toName`, or clear it when `toName` is
 * ''. A deleted scenario must not linger as an assignment that silently runs
 * nothing, and a rename must not orphan its challenges.
 */
const reassignScenario = (settings: AppSettings, fromName: string, toName: string) => {
    const from = normalizeProfileName(fromName);
    /** @param value */
    const assigned = (value: unknown) => typeof value === 'string' && normalizeProfileName(value) === from;
    const challengeSettings = settings.challengeSettings;
    // Overrides are validated on load; stored profiles are checked here.
    const valueMaps = [
        ...Object.values(challengeSettings.perChallenge),
        ...Object.values(plainObject(challengeSettings.profiles)),
    ];
    for (const values of valueMaps) {
        if (!isPlainObject(values) || !assigned(values.scenario)) continue;
        if (toName) values.scenario = toName;
        else delete values.scenario;
    }
    challengeSettings.titleRules = challengeSettings.titleRules.flatMap((rule) => {
        if (!assigned(rule?.scenario)) return [rule];
        if (toName) return [{ ...rule, scenario: toName }];
        const kept = { ...rule };
        delete kept.scenario;
        return ruleHasBehaviour(kept) ? [kept] : [];
    });
};

/**
 * Validate and store a scenario. `overwrite: false` refuses a name that
 * already exists; `replaces` names a stored scenario this document takes the
 * place of (a rename), which frees that name.
 */
const storeScenario = (
    doc: unknown,
    {
        overwrite,
        replaces = null,
        beforeSave = null,
    }: {
        overwrite: boolean;
        replaces?: string | null;
        beforeSave?: ((settings: AppSettings, storedName: string) => void) | null;
    },
): ScenarioSaveResult => {
    const settings = loadSettings();
    const result = validateScenario(doc, globalChallengeValues(settings));
    if (!result.ok) return failure(result.issues);
    const { scenario } = result;

    const stored = readScenariosMap(settings);
    const scenarios: Record<string, unknown> = {};
    const target = normalizeProfileName(scenario.name);
    const replaced = replaces === null ? null : normalizeProfileName(replaces);
    let exists = false;
    for (const name of Object.keys(stored)) {
        const key = normalizeProfileName(name);
        if (key === replaced) continue;
        if (key === target) {
            exists = true;
            continue;
        }
        scenarios[name] = stored[name];
    }
    if (exists && !overwrite) {
        return failure([{ path: 'name', message: `A scenario named "${scenario.name}" already exists` }]);
    }
    if (!exists && Object.keys(scenarios).length >= MAX_SCENARIOS) {
        return failure([{ path: '', message: `You already have ${MAX_SCENARIOS} scenarios — delete one first` }]);
    }
    scenarios[scenario.name] = scenario;
    settings.challengeSettings.scenarios = scenarios;
    if (beforeSave) beforeSave(settings, scenario.name);
    if (!saveSettings(settings)) return failure([{ path: '', message: 'The settings file could not be saved' }]);
    log().info(`Scenario saved: "${profileNameForLog(scenario.name)}"`, null);
    return { ok: true, name: scenario.name };
};

const saveScenario = (doc: unknown, { overwrite = true }: { overwrite?: boolean } = {}): ScenarioSaveResult =>
    storeScenario(doc, { overwrite });

/**
 * Rename a stored scenario and every assignment of it. The new name must be
 * free (a casing-only change is fine).
 */
const renameScenario = (oldName: unknown, newName: unknown): ScenarioSaveResult => {
    const existing = getScenario(oldName);
    if (!existing) return failure([{ path: 'name', message: `No scenario named "${profileNameForLog(oldName)}"` }]);
    const sameName = normalizeProfileName(oldName) === normalizeProfileName(newName);
    return storeScenario(
        { ...existing, name: newName },
        {
            overwrite: sameName,
            replaces: existing.name,
            beforeSave: (settings, storedName) => reassignScenario(settings, existing.name, storedName),
        },
    );
};

/**
 * Delete a stored scenario and clear every assignment of it. False when there
 * is none by that name.
 */
const deleteScenario = (name: unknown): boolean => {
    const settings = loadSettings();
    const stored = readScenariosMap(settings);
    const key = findProfileKey(stored, normalizeProfileName(name));
    if (key === null) return false;
    const scenarios = { ...stored };
    delete scenarios[key];
    settings.challengeSettings.scenarios = scenarios;
    reassignScenario(settings, key, '');
    if (!saveSettings(settings)) return false;
    log().info(`Scenario deleted: "${profileNameForLog(key)}"`, null);
    return true;
};

/**
 * What a scenario will do, for the import confirmation: its phases, every
 * action that spends currency or a one-per-challenge power, and its limits.
 */
const describeScenario = (scenario: ScenarioDocument) => {
    const phases: Array<{ name: string; settings: string[]; rules: number }> = [];
    const spending: Array<{ phase: string; rule: string | undefined; action: string }> = [];
    for (const [phaseName, phase] of Object.entries(scenario.phases)) {
        const rules = phase.rules ?? [];
        phases.push({ name: phaseName, settings: Object.keys(phase.settings ?? {}), rules: rules.length });
        for (const rule of rules) {
            for (const action of rule.do) {
                if (isOneOf(SPENDING_ACTIONS, action.type)) {
                    spending.push({ phase: phaseName, rule: rule.label || rule.id, action: action.type });
                }
            }
        }
    }
    return {
        name: scenario.name,
        description: scenario.description ?? '',
        start: scenario.start,
        phases,
        spending,
        limits: scenario.limits ?? {},
    };
};

/**
 * Validate a scenario document without storing it (the builder's draft, the
 * simulation of an unsaved edit).
 */
const checkScenario = (doc: unknown) => validateScenario(doc, globalChallengeValues(loadSettings()));

/**
 * Parse and validate shared scenario JSON without storing it — the preview
 * step. `exists` tells the caller a save would replace a scenario.
 */
const previewScenarioImport = (text: unknown) => {
    const parsed = parseScenarioJson(text);
    if (!parsed.ok) return failure(parsed.issues);
    const result = validateScenario(parsed.value, globalChallengeValues(loadSettings()));
    if (!result.ok) return failure(result.issues);
    return {
        ok: true,
        scenario: result.scenario,
        preview: describeScenario(result.scenario),
        exists: getScenario(result.scenario.name) !== null,
    };
};

/**
 * Parse, validate and store shared scenario JSON.
 */
const importScenario = (text: unknown, { overwrite = false }: { overwrite?: boolean } = {}): ScenarioSaveResult => {
    const parsed = parseScenarioJson(text);
    if (!parsed.ok) return failure(parsed.issues);
    return storeScenario(parsed.value, { overwrite });
};

/**
 * A stored scenario as pretty-printed JSON, or null when there is none.
 */
const exportScenario = (name: unknown): string | null => {
    const scenario = getScenario(name);
    return scenario ? `${JSON.stringify(scenario, null, 2)}\n` : null;
};

export {
    MAX_SCENARIOS,
    findStoredScenario,
    hasStoredScenarios,
    getScenarios,
    getScenario,
    saveScenario,
    renameScenario,
    deleteScenario,
    describeScenario,
    checkScenario,
    previewScenarioImport,
    importScenario,
    exportScenario,
};
