/**
 * User-defined scenarios (see scenarios/vocabulary.ts): list, save, rename,
 * delete, and the JSON import/export players use to share them. Stored in the
 * configuration as `scenarios` — name-keyed like profiles, because challenge
 * ids rotate — so the Android background service, which persists only the
 * configuration, has the definitions too.
 *
 * Every stored document is re-validated on read: the blob may be hand-edited
 * or older than the current vocabulary, and the engine must never run a
 * document the validator would refuse.
 */

import * as logger from '../logger';
import { SCENARIO_CAPS, SPENDING_ACTIONS, isOneOf, isPoolName } from '../scenarios/vocabulary';
import { loadSettings, saveSettings } from './persistence';
import { updatePhotoPools } from './entryPins';
import { globalChallengeValues } from './defaults';
import { normalizeProfileName, profileNameForLog, findProfileKey } from './profileStore';
import { validateScenario, parseScenarioJson } from './scenarioSchema';
import { ruleHasBehaviour as ruleHasBehaviourWith } from './ruleBehaviour';
import { validateSetting } from './schema';
import { findStoredScenario, validateStored } from './scenarioLookup';
import { definitionsRevision, referencesTo, runGated } from './scenarioMutationGate';
import type { TitleRule } from '../types/settings';
import { INSTALLATION_KEY, initialState, scenarioStateLedger } from '../scenarioStateStore';
import { isPlainObject } from '../plainObject';
import { renameV1ScenarioDocument } from './importV1/renames';

import type { ConfigV2 } from '../types/config';
import type { ScenarioDocument, ScenarioIssue } from './scenarioSchema';

/**
 * Why a change of the scenario collection was not made, besides an invalid document: `busy` (another change or a step
 * is running), `unresolved-work` (a plan that uses the scenario is in the middle of something), `state-unreadable`
 * (progress that could say is unreadable), `incompatible-scope` (a reference needs the other scope), `conflict` (the
 * collection changed since the caller loaded it), `revision-unreadable` (the stored revision is malformed).
 */
type ScenarioRefusal =
    | 'busy'
    | 'unresolved-work'
    | 'state-unreadable'
    | 'incompatible-scope'
    | 'conflict'
    | 'revision-unreadable';

/** A save that was refused: `issues` as ever, and `reason` when the refusal is one of ScenarioRefusal. */
type ScenarioFailure = { ok: false; issues: ScenarioIssue[]; reason?: ScenarioRefusal };

type ScenarioSaveResult = { ok: true; name: string } | ScenarioFailure;
/** What a store answers inside this module: the saved document too, for the import to read what it names. */
type ScenarioStoreResult = { ok: true; name: string; scenario: ScenarioDocument } | ScenarioFailure;
/** The store's answer as the public save and rename give it. */
const withoutDocument = (result: ScenarioStoreResult): ScenarioSaveResult =>
    result.ok ? { ok: true, name: result.name } : result;
type ScenarioDeleteResult = { ok: true } | { ok: false; reason: ScenarioRefusal | 'not-found' | 'not-saved' };
type ScenarioLibrary = { scenarios: Record<string, ScenarioDocument>; revision: number | null };
/**
 * `unboundPools`: the photo pools the scenario names that this account does not have saved: a binding the user still has to
 * make, not an error (the scenario is stored, and a pool-only phase waits until the pool exists).
 */
type ScenarioImportPreview =
    | {
          ok: true;
          scenario: ScenarioDocument;
          preview: ReturnType<typeof describeScenario>;
          exists: boolean;
          unboundPools: string[];
      }
    | { ok: false; issues: ScenarioIssue[] };
type ScenarioImportResult = { ok: true; name: string; unboundPools: string[] } | ScenarioFailure;

const MAX_SCENARIOS = SCENARIO_CAPS.scenarios;

// Phase settings the import preview points out: Only changes what a join and a
// fill do when no chosen photo is usable.
const FLAGGED_PHASE_SETTINGS = ['chosenPhotos', 'chosenPhotosOnly'] as const;
// Phase settings an export leaves out: photo ids may point at private photos,
// so a shared file must not carry them.
const EXPORT_OMITTED_SETTINGS: readonly string[] = ['chosenPhotos'];

const log = () => logger.withCategory('settings');

/**
 * True when any scenario is stored at all — lets hot paths skip the overlay cheaply.
 */
const hasStoredScenarios = (settings: ConfigV2): boolean => Object.keys(settings.scenarios).length > 0;

/**
 * Valid stored scenarios as `{ [name]: document }` (defensive copies) with the revision of the collection they were
 * read at (null: the stored revision is malformed, so nothing can be saved over it). A stored document that no longer
 * validates is left out — and logged — rather than run.
 */
const getScenarioLibrary = (): ScenarioLibrary => {
    const settings = loadSettings();
    const globalDefaults = globalChallengeValues(settings);
    const scenarios: Record<string, ScenarioDocument> = {};
    for (const [name, raw] of Object.entries(settings.scenarios)) {
        const result = validateStored(raw, globalDefaults);
        if (result.ok) {
            scenarios[result.scenario.name] = structuredClone(result.scenario);
        } else {
            log().warning(`Stored scenario "${profileNameForLog(name)}" is invalid and was skipped`, result.issues);
        }
    }
    return { scenarios, revision: definitionsRevision(settings) };
};

/** Valid stored scenarios as `{ [name]: document }`: getScenarioLibrary without the revision. */
const getScenarios = (): Record<string, ScenarioDocument> => getScenarioLibrary().scenarios;

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

const failure = (issues: ScenarioIssue[]): ScenarioFailure => ({ ok: false, issues });

// A refusal names its reason; the issue carries the reason too, for a caller that shows the first issue.
const refusal = (reason: ScenarioRefusal): ScenarioFailure => ({
    ok: false,
    reason,
    issues: [{ path: '', message: reason }],
});

const NOT_SAVED = 'The settings file could not be saved';

// A rule keeps its row only while it still contributes something: a profile, tags, or a valid inline value.
const ruleHasBehaviour = (rule: TitleRule): boolean => ruleHasBehaviourWith(rule, validateSetting);

/**
 * Point every assignment of scenario `fromName` — per-challenge overrides, profiles, challenge rules and the
 * installation scenario — at `toName`, or clear it when `toName` is '' (a rule left with nothing to do goes; the
 * installation assignment is cleared by deleteScenario, which fences its owner). A deleted scenario must not linger as
 * an assignment that silently runs nothing, and a rename must not orphan its challenges.
 */
const reassignScenario = (settings: ConfigV2, fromName: string, toName: string) => {
    const from = normalizeProfileName(fromName);
    /** @param value */
    const assigned = (value: unknown) => typeof value === 'string' && normalizeProfileName(value) === from;
    // Overrides are validated on load; stored profiles are checked here.
    const valueMaps = [
        ...Object.values(settings.challenges).map((record) => record.values),
        ...Object.values(settings.profiles),
    ];
    for (const values of valueMaps) {
        if (!isPlainObject(values) || !assigned(values.scenario)) continue;
        if (toName) values.scenario = toName;
        else delete values.scenario;
    }
    settings.rules = settings.rules.flatMap((rule) => {
        if (!assigned(rule?.scenario)) return [rule];
        if (toName) return [{ ...rule, scenario: toName }];
        const kept = { ...rule };
        delete kept.scenario;
        return ruleHasBehaviour(kept) ? [kept] : [];
    });
    if (toName && settings.installationScenario && assigned(settings.installationScenario.scenario)) {
        settings.installationScenario = { ...settings.installationScenario, scenario: toName };
    }
};

/**
 * The progress records that name scenario `from` named `to` instead, one write each (the record is a single subject's:
 * the generation, the markers and every other field stay). Returns the subjects moved, or why one could not be.
 */
const moveProgress = (
    subjects: readonly string[],
    from: string,
    to: string,
): { ok: true; moved: string[] } | { ok: false; reason: 'state-unreadable'; moved: string[] } => {
    const moved: string[] = [];
    for (const key of subjects) {
        const result = scenarioStateLedger.change(key, (current) =>
            current && normalizeProfileName(current.scenario) === normalizeProfileName(from)
                ? { ...current, scenario: to }
                : { refuse: 'unrelated' },
        );
        if (result.ok) moved.push(key);
        else if (result.reason !== 'unrelated') return { ok: false, reason: 'state-unreadable', moved };
    }
    return { ok: true, moved };
};

/**
 * Validate and store a scenario, under the lifecycle gate. `overwrite: false` refuses a name that already exists; an
 * overwrite names the revision of the collection the caller read (`expectedDefinitionRevision`) and is a `conflict`
 * when the collection moved. `rename` names the stored scenario this document takes the place of: it frees that name,
 * moves its assignments and its progress, and needs no revision.
 */
const storeScenario = (
    doc: unknown,
    {
        overwrite,
        expectedDefinitionRevision,
        rename = null,
    }: {
        overwrite: boolean;
        expectedDefinitionRevision?: number;
        rename?: string | null;
    },
): ScenarioStoreResult => {
    // An invalid document is told as it is, without the gate.
    const early = loadSettings();
    const checked = validateScenario(doc, globalChallengeValues(early), early.profiles);
    if (!checked.ok) return failure(checked.issues);
    const { scenario } = checked;
    const target = normalizeProfileName(scenario.name);
    const replaced = rename === null ? null : normalizeProfileName(rename);
    // The stored scenarios this change replaces or takes the name of: the plans that use them are the affected ones.
    const affected = (settings: ConfigV2): string[] =>
        Object.keys(settings.scenarios).filter((name) => [target, replaced].includes(normalizeProfileName(name)));
    const gated = runGated(
        (settings) => ({ names: affected(settings) }),
        (settings, subjects): ScenarioStoreResult => {
            const revision = definitionsRevision(settings);
            if (revision === null) return refusal('revision-unreadable');
            const stored = settings.scenarios;
            const scenarios: Record<string, unknown> = {};
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
            // Replacing a definition needs the revision it was edited on: another editor's change is not undone.
            if (exists && rename === null && expectedDefinitionRevision !== revision) return refusal('conflict');
            if (
                rename !== null &&
                expectedDefinitionRevision !== undefined &&
                expectedDefinitionRevision !== revision
            ) {
                return refusal('conflict');
            }
            if (!exists && Object.keys(scenarios).length >= MAX_SCENARIOS) {
                return failure([
                    { path: '', message: `You already have ${MAX_SCENARIOS} scenarios — delete one first` },
                ]);
            }
            // A scope another reference cannot use: refused before anything is written. A rename keeps its scope.
            if (rename === null) {
                const used = referencesTo(settings, scenario.name);
                const installation = scenario.scope === 'installation';
                if (installation ? used.challenge : used.installation) return refusal('incompatible-scope');
            }
            scenarios[scenario.name] = scenario;
            settings.scenarios = scenarios;
            settings.scenarioDefinitionsRevision = revision + 1;
            let moved: string[] = [];
            if (rename !== null) {
                reassignScenario(settings, rename, scenario.name);
                const progress = moveProgress(subjects, rename, scenario.name);
                moved = progress.moved;
                if (!progress.ok) {
                    moveProgress(moved, scenario.name, rename);
                    return refusal(progress.reason);
                }
            }
            if (!saveSettings(settings)) {
                if (rename !== null) moveProgress(moved, scenario.name, rename);
                return failure([{ path: '', message: NOT_SAVED }]);
            }
            log().info(`Scenario saved: "${profileNameForLog(scenario.name)}"`, null);
            return { ok: true, name: scenario.name, scenario };
        },
    );
    return gated.ok ? gated.value : refusal(gated.reason);
};

const saveScenario = (
    doc: unknown,
    { overwrite = true, expectedDefinitionRevision }: { overwrite?: boolean; expectedDefinitionRevision?: number } = {},
): ScenarioSaveResult => withoutDocument(storeScenario(doc, { overwrite, expectedDefinitionRevision }));

/**
 * Rename a stored scenario and every assignment of it. The new name must be
 * free (a casing-only change is fine).
 */
const renameScenario = (
    oldName: unknown,
    newName: unknown,
    { expectedDefinitionRevision }: { expectedDefinitionRevision?: number } = {},
): ScenarioSaveResult => {
    const existing = getScenario(oldName);
    if (!existing) return failure([{ path: 'name', message: `No scenario named "${profileNameForLog(oldName)}"` }]);
    const sameName = normalizeProfileName(oldName) === normalizeProfileName(newName);
    return withoutDocument(
        storeScenario(
            { ...existing, name: newName },
            { overwrite: sameName, rename: existing.name, expectedDefinitionRevision },
        ),
    );
};

/**
 * Delete a stored scenario and clear every assignment of it, in one change under the lifecycle gate: refused (nothing
 * written) while a plan that uses it has unresolved work, as any change of an assignment is. The progress records stay as
 * they were; the installation record only moves to the next generation, so its former owner is fenced. `not-found` when
 * there is none by that name.
 */
const deleteScenario = (
    name: unknown,
    { expectedDefinitionRevision }: { expectedDefinitionRevision?: number } = {},
): ScenarioDeleteResult => {
    const wanted = normalizeProfileName(name);
    const gated = runGated(
        (settings) => ({
            names: Object.keys(settings.scenarios).filter((key) => normalizeProfileName(key) === wanted),
        }),
        (settings): ScenarioDeleteResult => {
            const stored = settings.scenarios;
            const key = findProfileKey(stored, wanted);
            if (key === null) return { ok: false, reason: 'not-found' };
            const revision = definitionsRevision(settings);
            if (revision === null) return { ok: false, reason: 'revision-unreadable' };
            if (expectedDefinitionRevision !== undefined && expectedDefinitionRevision !== revision) {
                return { ok: false, reason: 'conflict' };
            }
            const scenarios = { ...stored };
            delete scenarios[key];
            settings.scenarios = scenarios;
            settings.scenarioDefinitionsRevision = revision + 1;
            const owner = settings.installationScenario;
            if (owner && referencesTo(settings, key).installation) {
                // The fence moves first, so that its owner is fenced even if the configuration then cannot be saved.
                const fenced = scenarioStateLedger.change(INSTALLATION_KEY, (current) => ({
                    ...(current ?? initialState('', '', Math.floor(Date.now() / 1000))),
                    generation: Math.max(owner.generation, current?.generation ?? 0) + 1,
                }));
                if (!fenced.ok) {
                    return {
                        ok: false,
                        reason:
                            fenced.reason === 'busy' || fenced.reason === 'not-saved'
                                ? fenced.reason
                                : 'state-unreadable',
                    };
                }
                settings.installationScenario = undefined;
            }
            reassignScenario(settings, key, '');
            if (!saveSettings(settings)) return { ok: false, reason: 'not-saved' };
            log().info(`Scenario deleted: "${profileNameForLog(key)}"`, null);
            return { ok: true };
        },
    );
    return gated.ok ? gated.value : { ok: false, reason: gated.reason };
};

/** Why a photo pool change was not made: the gate's reasons, `not-found`, `exists` (a rename onto a name in use), `invalid`, `not-saved`. */
type PhotoPoolChange =
    | { ok: true }
    | {
          ok: false;
          reason: 'busy' | 'unresolved-work' | 'state-unreadable' | 'not-found' | 'exists' | 'invalid' | 'not-saved';
      };

/** The stored scenarios (their names as stored) any phase of which draws from the pool `name`. */
const scenariosUsingPool = (settings: ConfigV2, name: string): string[] => {
    const defaults = globalChallengeValues(settings);
    return Object.entries(settings.scenarios).flatMap(([stored, raw]) => {
        const checked = validateStored(raw, defaults);
        return checked.ok && poolNamesOf(checked.scenario).includes(name) ? [stored] : [];
    });
};

/**
 * Deletes a saved photo pool (`rename` names the pool it is renamed to: the photos move to that name instead). A pool a
 * stored scenario draws from goes through the same gate as a change of an assignment: refused (nothing written) while a plan
 * that uses such a scenario has unresolved work. The scenarios themselves are never rewritten: one that names a pool the
 * account no longer has is unbound, and its photo-pool phases wait (and `only` ones block) until the name is bound again.
 */
const changePhotoPool = (name: unknown, rename: string | null): PhotoPoolChange => {
    if (!isPoolName(name) || (rename !== null && !isPoolName(rename))) return { ok: false, reason: 'invalid' };
    const gated = runGated(
        (settings) => ({ names: scenariosUsingPool(settings, name) }),
        (): PhotoPoolChange => {
            // The pools are changed as they are stored when the write is made, not as the gate's read saw them.
            const outcome = updatePhotoPools<'not-found' | 'exists'>((pools) => {
                if (!Object.hasOwn(pools, name)) return { refused: 'not-found' };
                if (rename !== null && Object.hasOwn(pools, rename)) return { refused: 'exists' };
                const next = { ...pools };
                if (rename !== null) next[rename] = pools[name];
                delete next[name];
                return { pools: next };
            });
            if (outcome === 'ok') return { ok: true };
            return { ok: false, reason: outcome === 'write-failed' ? 'not-saved' : outcome };
        },
    );
    return gated.ok ? gated.value : { ok: false, reason: gated.reason };
};

const deletePhotoPool = (name: unknown): PhotoPoolChange => changePhotoPool(name, null);

const renamePhotoPool = (from: unknown, to: unknown): PhotoPoolChange =>
    isPoolName(to) ? changePhotoPool(from, to) : { ok: false, reason: 'invalid' };

/** The phase settings worth pointing out in one phase's keys (FLAGGED_PHASE_SETTINGS). */
const flaggedIn = (phase: string, keys: string[]) =>
    FLAGGED_PHASE_SETTINGS.filter((key) => keys.includes(key)).map((key) => ({ phase, key }));

/** The names of the photo pools a scenario's phases draw from, each once, in phase order. A document holds names, never photo ids. */
const poolNamesOf = (scenario: ScenarioDocument): string[] => [
    ...new Set(Object.values(scenario.phases).flatMap((phase) => (phase.photoPool ? [phase.photoPool.name] : []))),
];

/** The pools a scenario names that the account has not saved. */
const unboundPoolsOf = (settings: ConfigV2, scenario: ScenarioDocument): string[] =>
    poolNamesOf(scenario).filter((name) => !Object.hasOwn(settings.photoPools ?? {}, name));

/**
 * What a scenario will do, for the import confirmation: its phases, every
 * action that spends currency or a one-per-challenge power, the phase settings
 * worth a second look (`flagged`), and its limits.
 */
const describeScenario = (scenario: ScenarioDocument) => {
    const phases: Array<{ name: string; settings: string[]; rules: number }> = [];
    const spending: Array<{ phase: string; rule: string | undefined; action: string }> = [];
    const flagged: Array<{ phase: string; key: (typeof FLAGGED_PHASE_SETTINGS)[number] }> = [];
    for (const [phaseName, phase] of Object.entries(scenario.phases)) {
        const rules = phase.rules ?? [];
        const keys = Object.keys(phase.settings ?? {});
        phases.push({ name: phaseName, settings: keys, rules: rules.length });
        flagged.push(...flaggedIn(phaseName, keys));
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
        flagged,
        pools: poolNamesOf(scenario),
        limits: scenario.limits ?? {},
    };
};

/**
 * Validate a scenario document without storing it (the builder's draft, the
 * simulation of an unsaved edit).
 */
const checkScenario = (doc: unknown) => {
    const settings = loadSettings();
    return validateScenario(doc, globalChallengeValues(settings), settings.profiles);
};

/**
 * Parse and validate shared scenario JSON without storing it — the preview
 * step. `exists` tells the caller a save would replace a scenario.
 */
const previewScenarioImport = (text: unknown): ScenarioImportPreview => {
    const parsed = parseScenarioJson(text);
    if (!parsed.ok) return failure(parsed.issues);
    // A shared file written under settings format 1 names its settings by their format 1 keys.
    const settings = loadSettings();
    const result = validateScenario(
        renameV1ScenarioDocument(parsed.value),
        globalChallengeValues(settings),
        settings.profiles,
    );
    if (!result.ok) return failure(result.issues);
    return {
        ok: true,
        scenario: result.scenario,
        preview: describeScenario(result.scenario),
        exists: getScenario(result.scenario.name) !== null,
        unboundPools: unboundPoolsOf(settings, result.scenario),
    };
};

/**
 * Parse, validate and store shared scenario JSON.
 */
const importScenario = (
    text: unknown,
    {
        overwrite = false,
        expectedDefinitionRevision,
    }: { overwrite?: boolean; expectedDefinitionRevision?: number } = {},
): ScenarioImportResult => {
    const parsed = parseScenarioJson(text);
    if (!parsed.ok) return failure(parsed.issues);
    const saved = storeScenario(renameV1ScenarioDocument(parsed.value), { overwrite, expectedDefinitionRevision });
    if (!saved.ok) return saved;
    // The stored document: its pool names are what this account still has to bind.
    return { ok: true, name: saved.name, unboundPools: unboundPoolsOf(loadSettings(), saved.scenario) };
};

/**
 * A stored scenario as pretty-printed JSON, and the settings it left out
 * (EXPORT_OMITTED_SETTINGS), or null when there is none. The GUI and the CLI
 * both export through this, so the omission cannot differ between them.
 */
const exportScenarioWithNotes = (name: unknown): { json: string; omitted: string[] } | null => {
    // getScenario hands out a copy, safe to edit.
    const scenario = getScenario(name);
    if (!scenario) return null;
    const omitted = new Set<string>();
    for (const phase of Object.values(scenario.phases)) {
        for (const key of EXPORT_OMITTED_SETTINGS) {
            if (phase.settings && Object.prototype.hasOwnProperty.call(phase.settings, key)) {
                delete phase.settings[key];
                omitted.add(key);
            }
        }
    }
    return { json: `${JSON.stringify(scenario, null, 2)}\n`, omitted: [...omitted] };
};

/**
 * A stored scenario as pretty-printed JSON (without its account-bound settings), or null when there is none.
 */
const exportScenario = (name: unknown): string | null => exportScenarioWithNotes(name)?.json ?? null;

export {
    MAX_SCENARIOS,
    findStoredScenario,
    hasStoredScenarios,
    getScenarioLibrary,
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
    exportScenarioWithNotes,
    deletePhotoPool,
    renamePhotoPool,
};
export type { ScenarioRefusal };
