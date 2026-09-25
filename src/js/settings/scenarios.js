/**
 * User-defined scenarios (see scenarios/vocabulary.js): list, save, rename,
 * delete, and the JSON import/export players use to share them. Stored in the
 * settings blob as `challengeSettings.scenarios` — name-keyed like profiles,
 * because challenge ids rotate — so the Android background service, which
 * persists only the settings blob, has the definitions too.
 *
 * Every stored document is re-validated on read: the blob may be hand-edited
 * or older than the current vocabulary, and the engine must never run a
 * document the validator would refuse.
 */

const logger = require('../logger');
const { SCENARIO_CAPS, SPENDING_ACTIONS } = require('../scenarios/vocabulary');
const { loadSettings, saveSettings } = require('./persistence');
const { ensureChallengeSettings, globalChallengeValues } = require('./defaults');
const { normalizeProfileName, profileNameForLog, findProfileKey } = require('./profileStore');
const { validateScenario, parseScenarioJson } = require('./scenarioSchema');
const { sanitizeTitleRuleInline } = require('./titleRuleSanitize');

const MAX_SCENARIOS = SCENARIO_CAPS.scenarios;

const log = () => logger.withCategory('settings');

/** The stored scenarios map when it is a plain object, else `{}`. */
const readScenariosMap = (settings) => {
    const stored = settings.challengeSettings?.scenarios;
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
};

// Read-side validation runs on every lookup (the engine resolves a scenario
// per challenge per pass), so results are memoized by the stored document and
// the global defaults its phase settings are checked against.
const VALIDATION_CACHE_LIMIT = 200;
const validationCache = new Map();

const validateStored = (raw, globalDefaults) => {
    const key = JSON.stringify([raw, globalDefaults]);
    if (!validationCache.has(key)) {
        if (validationCache.size >= VALIDATION_CACHE_LIMIT) validationCache.clear();
        validationCache.set(key, validateScenario(raw, globalDefaults));
    }
    return validationCache.get(key);
};

/**
 * The valid stored scenario named `name` (case-insensitive) in an already
 * loaded settings object, or null. Not a copy — callers only read it. Used by
 * the phase-settings overlay, which must not load settings a second time.
 */
const findStoredScenario = (settings, name) => {
    const stored = readScenariosMap(settings);
    const key = findProfileKey(stored, normalizeProfileName(name));
    if (key === null) return null;
    const result = validateStored(stored[key], globalChallengeValues(settings));
    return result.ok ? result.scenario : null;
};

/** True when any scenario is stored at all — lets hot paths skip the overlay cheaply. */
const hasStoredScenarios = (settings) => Object.keys(readScenariosMap(settings)).length > 0;

/**
 * Valid stored scenarios as `{ [name]: document }` (defensive copies). A
 * stored document that no longer validates is left out — and logged — rather
 * than run.
 */
const getScenarios = () => {
    const settings = loadSettings();
    const globalDefaults = globalChallengeValues(settings);
    const scenarios = {};
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

/** One valid scenario by name (case-insensitive), or null. */
const getScenario = (name) => {
    const normalized = normalizeProfileName(name);
    if (!normalized) return null;
    const scenarios = getScenarios();
    const key = findProfileKey(scenarios, normalized);
    return key === null ? null : scenarios[key];
};

const failure = (issues) => ({ ok: false, issues });

const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

// A rule keeps its row only while it still contributes something: a profile,
// tags, or a valid inline value.
const ruleHasBehaviour = (rule) => {
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
const reassignScenario = (settings, fromName, toName) => {
    const from = normalizeProfileName(fromName);
    const assigned = (value) => typeof value === 'string' && normalizeProfileName(value) === from;
    const challengeSettings = ensureChallengeSettings(settings);
    const valueMaps = [
        ...Object.values(plainObject(challengeSettings.perChallenge)),
        ...Object.values(plainObject(challengeSettings.profiles)),
    ];
    for (const values of valueMaps) {
        if (!values || !assigned(values.scenario)) continue;
        if (toName) values.scenario = toName;
        else delete values.scenario;
    }
    if (Array.isArray(challengeSettings.titleRules)) {
        challengeSettings.titleRules = challengeSettings.titleRules.flatMap((rule) => {
            if (!assigned(rule?.scenario)) return [rule];
            if (toName) return [{ ...rule, scenario: toName }];
            const kept = { ...rule };
            delete kept.scenario;
            return ruleHasBehaviour(kept) ? [kept] : [];
        });
    }
};

/**
 * Validate and store a scenario. `overwrite: false` refuses a name that
 * already exists; `replaces` names a stored scenario this document takes the
 * place of (a rename), which frees that name.
 *
 * @returns {{ok: true, name: string} | {ok: false, issues: Array<{path: string, message: string}>}}
 */
const storeScenario = (doc, { overwrite, replaces = null, beforeSave = null }) => {
    const settings = loadSettings();
    const result = validateScenario(doc, globalChallengeValues(settings));
    if (!result.ok) return failure(result.issues);
    const { scenario } = result;

    const stored = readScenariosMap(settings);
    const scenarios = {};
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
    ensureChallengeSettings(settings).scenarios = scenarios;
    if (beforeSave) beforeSave(settings, scenario.name);
    if (!saveSettings(settings)) return failure([{ path: '', message: 'The settings file could not be saved' }]);
    log().info(`Scenario saved: "${profileNameForLog(scenario.name)}"`, null);
    return { ok: true, name: scenario.name };
};

const saveScenario = (doc, { overwrite = true } = {}) => storeScenario(doc, { overwrite });

/**
 * Rename a stored scenario and every assignment of it. The new name must be
 * free (a casing-only change is fine).
 */
const renameScenario = (oldName, newName) => {
    const existing = getScenario(oldName);
    if (!existing) return failure([{ path: 'name', message: `No scenario named "${oldName}"` }]);
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
const deleteScenario = (name) => {
    const settings = loadSettings();
    const stored = readScenariosMap(settings);
    const key = findProfileKey(stored, normalizeProfileName(name));
    if (key === null) return false;
    const scenarios = { ...stored };
    delete scenarios[key];
    ensureChallengeSettings(settings).scenarios = scenarios;
    reassignScenario(settings, key, '');
    if (!saveSettings(settings)) return false;
    log().info(`Scenario deleted: "${profileNameForLog(key)}"`, null);
    return true;
};

/**
 * What a scenario will do, for the import confirmation: its phases, every
 * action that spends currency or a one-per-challenge power, and its limits.
 */
const describeScenario = (scenario) => {
    const phases = [];
    const spending = [];
    for (const [phaseName, phase] of Object.entries(scenario.phases)) {
        const rules = phase.rules ?? [];
        phases.push({ name: phaseName, settings: Object.keys(phase.settings ?? {}), rules: rules.length });
        for (const rule of rules) {
            for (const action of rule.do) {
                if (SPENDING_ACTIONS.includes(action.type)) {
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
 * Parse and validate shared scenario JSON without storing it — the preview
 * step. `exists` tells the caller a save would replace a scenario.
 */
const previewScenarioImport = (text) => {
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

/** Parse, validate and store shared scenario JSON. */
const importScenario = (text, { overwrite = false } = {}) => {
    const parsed = parseScenarioJson(text);
    if (!parsed.ok) return failure(parsed.issues);
    return storeScenario(parsed.value, { overwrite });
};

/** A stored scenario as pretty-printed JSON, or null when there is none. */
const exportScenario = (name) => {
    const scenario = getScenario(name);
    return scenario ? `${JSON.stringify(scenario, null, 2)}\n` : null;
};

module.exports = {
    MAX_SCENARIOS,
    findStoredScenario,
    hasStoredScenarios,
    getScenarios,
    getScenario,
    saveScenario,
    renameScenario,
    deleteScenario,
    describeScenario,
    previewScenarioImport,
    importScenario,
    exportScenario,
};
