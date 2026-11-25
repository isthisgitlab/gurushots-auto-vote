/**
 * Checks on a parsed scenario document that its shape cannot express: phase
 * settings keys and values, condition depth, and reference resolution
 * (see ../scenarioSchema.ts).
 */

import {
    checkExpression,
    compareIssue,
    exprReferences,
    exprTypeOfDescriptor,
    listIssue,
} from '../../scenarios/expressions';
import { FACTS, factStageIssues, stagePhrase } from '../../scenarios/facts';
import * as vocabulary from '../../scenarios/vocabulary';
import { schemaEntry, validateSetting, getValidationError } from '../schema';
import { findProfileKey, normalizeProfileName } from '../profileStore';
import { isPlainObject } from '../../plainObject';
import { scenarioCapability } from '../scenarioCapabilities';

import type { ExprType, SettingTypeLookup } from '../../scenarios/expressions';
import type { ScenarioScope, ScenarioValueDescriptor } from '../../types/settings';
import type { ScenarioCondition, ScenarioExpr, ScenarioStage } from '../../types/scenario';
import type { ParsedScenarioDocument, ScenarioDocument, ScenarioPhase } from './shapes';

export type ScenarioIssue = { path: string; message: string };

const { SCENARIO_CAPS } = vocabulary;

/** Both fields in each pair must be present across a phase's literals and bindings. */
const SETTING_PAIRS = [
    ['exposure', 'exposureTarget'],
    ['finalWindowExposure', 'finalWindowExposureTarget'],
];

/**
 * Why a phase may not overlay a key, or undefined when it may (its capability allows a challenge write). A phase
 * overlay sits above every layer, the per-challenge override included, so a phase setting `manualPhotosOnly: false`
 * would turn automatic photo entry back on against the user's own switch: a per-challenge key a phase may not write
 * is refused with the reason its capability states. Any other key, an unknown one included, is not a per-challenge
 * setting.
 */
const phaseRefusal = (key: string, scope: ScenarioScope = 'challenge'): string | undefined => {
    const capability = scenarioCapability(key);
    if (capability?.phaseWrite.includes(scope)) return undefined;
    if (scope === 'installation') {
        return capability?.restriction ?? 'Not a setting an installation scenario can change';
    }
    return (schemaEntry(key)?.perChallenge ? capability?.restriction : undefined) ?? 'Not a per-challenge setting';
};

/**
 * The stage a scenario's facts are read in: a challenge scenario runs while its challenge is active, an installation
 * scenario outside any challenge.
 */
const stageOf = (scope: ScenarioScope): ScenarioStage => (scope === 'installation' ? 'account' : 'active');

/** The stages each condition that reads a challenge is available in (the others are available everywhere). */
const CONDITION_STAGES: Readonly<Record<string, readonly ScenarioStage[] | undefined>> = vocabulary.CONDITION_STAGES;

/** The stages each stage offers its rules as actions. */
const STAGE_ACTIONS: Readonly<Record<ScenarioStage, readonly string[]>> = vocabulary.STAGE_ACTIONS;

/**
 * The stages a rule runs in: the ones it declares, else its scope's default.
 */
const ruleStages = (declared: readonly ScenarioStage[] | undefined, scope: ScenarioScope): readonly ScenarioStage[] =>
    declared ?? vocabulary.DEFAULT_STAGES[scope];

/**
 * Why a condition is not available in some stage of a rule: one issue per such stage.
 */
const conditionStageIssues = (type: string, path: string, stages: readonly ScenarioStage[]): ScenarioIssue[] => {
    const allowed = CONDITION_STAGES[type];
    if (!allowed) return [];
    return stages
        .filter((stage) => !allowed.includes(stage))
        .map((stage) => ({
            path,
            message:
                stage === 'account'
                    ? `${type} reads a challenge: an installation scenario cannot use it`
                    : `${type} is not available ${stagePhrase(stage)}`,
        }));
};

/**
 * Whether a value is one a non-schema setting's descriptor accepts (the keys the schema does not hold have no validator
 * of their own).
 */
const descriptorAccepts = (descriptor: ScenarioValueDescriptor, value: unknown): boolean => {
    switch (descriptor.kind) {
        case 'boolean':
            return typeof value === 'boolean';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'string':
            return typeof value === 'string';
        case 'enum':
            return descriptor.values.some((allowed) => allowed === value);
        case 'list':
            return Array.isArray(value) && value.every((item) => typeof item === 'string');
        default:
            return false;
    }
};

/**
 * Nesting depth of a condition list (a flat list is depth 1).
 */
const conditionDepth = (conditions: readonly ScenarioCondition[]): number => {
    let depth = 0;
    for (const item of conditions) {
        const nested =
            item.type === 'not' ? [item.condition] : item.type === 'any' || item.type === 'all' ? item.of : [];
        depth = Math.max(depth, 1 + (nested.length ? conditionDepth(nested) : 0));
    }
    return depth;
};

/**
 * The expressions a condition holds directly (not those of its nested conditions).
 */
const conditionExpressions = (condition: ScenarioCondition): ScenarioExpr[] => {
    switch (condition.type) {
        case 'compare':
            return [condition.left, condition.right];
        case 'present':
        case 'absent':
            return [condition.value];
        case 'contains':
        case 'containsAny':
        case 'containsAll':
            return [condition.list, condition.value];
        default:
            return [];
    }
};

/**
 * Every memory slot a condition list reads.
 */
const collectConditionReads = (conditions: readonly ScenarioCondition[], into: Set<string>) => {
    for (const item of conditions) {
        if (item.type === 'memorySet') into.add(item.slot);
        if (item.type === 'entry' && item.select.by === 'memory') into.add(item.select.slot);
        for (const expr of conditionExpressions(item)) {
            for (const { select } of exprReferences(expr).facts) if (select?.by === 'memory') into.add(select.slot);
        }
        if (item.type === 'not') collectConditionReads([item.condition], into);
        if (item.type === 'any' || item.type === 'all') collectConditionReads(item.of, into);
    }
};

/**
 * What a setting key reads as in an expression: its type, or why it cannot be read (it is no configuration key, only a
 * restricted projection of it can be observed, or its value has no expression form).
 */
const settingExprType: SettingTypeLookup = (key) => {
    const capability = scenarioCapability(key);
    if (!capability) return `"${key}" is not a configuration setting`;
    if (capability.read !== 'value') return `"${key}" cannot be read in an expression`;
    return exprTypeOfDescriptor(capability.value) ?? `"${key}" has no value an expression can use`;
};

/**
 * One expression slot of a condition: its own issues, then (when it is sound) that every fact it reads is available
 * in every stage the rule runs in.
 */
const expressionIssues = (
    expr: ScenarioExpr,
    path: string,
    stages: readonly ScenarioStage[],
): { type: ExprType | null; issues: ScenarioIssue[] } => {
    const checked = checkExpression(expr, settingExprType, path);
    const unavailable = checked.issues.length
        ? []
        : exprReferences(expr).facts.flatMap(({ name }) =>
              stages.flatMap((stage) => factStageIssues(name, stage, path)),
          );
    return { type: checked.type, issues: [...checked.issues, ...unavailable] };
};

/**
 * The issues of the expressions in a condition and its nested conditions: each expression is sound, the two sides of a
 * comparison relate, a list condition gets lists and strings, and an entry count has 1 to 8 predicates.
 */
const conditionExpressionIssues = (
    condition: ScenarioCondition,
    path: string,
    stages: readonly ScenarioStage[],
): ScenarioIssue[] => {
    const refused = conditionStageIssues(condition.type, path, stages);
    if (refused.length) return refused;
    switch (condition.type) {
        case 'compare': {
            const left = expressionIssues(condition.left, `${path}.left`, stages);
            const right = expressionIssues(condition.right, `${path}.right`, stages);
            const relation = left.type && right.type ? compareIssue(condition.op, left.type, right.type) : null;
            return [...left.issues, ...right.issues, ...(relation ? [{ path, message: relation }] : [])];
        }
        case 'present':
        case 'absent':
            return expressionIssues(condition.value, `${path}.value`, stages).issues;
        case 'contains':
        case 'containsAny':
        case 'containsAll': {
            const list = expressionIssues(condition.list, `${path}.list`, stages);
            const value = expressionIssues(condition.value, `${path}.value`, stages);
            const relation = list.type && value.type ? listIssue(condition.type, list.type, value.type) : null;
            return [...list.issues, ...value.issues, ...(relation ? [{ path, message: relation }] : [])];
        }
        case 'entriesWhere':
        case 'entryCount': {
            const { entryPredicates } = SCENARIO_CAPS;
            const count = condition.where.length;
            return count >= 1 && count <= entryPredicates
                ? []
                : [{ path: `${path}.where`, message: `${condition.type} takes 1 to ${entryPredicates} predicates` }];
        }
        case 'all':
        case 'any':
            return condition.of.flatMap((item, index) =>
                conditionExpressionIssues(item, `${path}.of[${index}]`, stages),
            );
        case 'not':
            return conditionExpressionIssues(condition.condition, `${path}.condition`, stages);
        default:
            return [];
    }
};

/**
 * Check phase literals before a binding can supply its value. The challenge
 * resolver adjusts linked values after it combines all the sources.
 */
const phaseSettingsIssues = (
    values: Record<string, unknown>,
    basePath: string,
    globalDefaults: Record<string, unknown>,
    boundKeys: ReadonlySet<string>,
    scope: ScenarioScope,
): ScenarioIssue[] => {
    const issues = [];
    const context = scope === 'installation' ? { ...globalDefaults, ...values } : null;
    for (const [key, value] of Object.entries(values)) {
        const path = `${basePath}.${key}`;
        const refusal = phaseRefusal(key, scope);
        if (refusal !== undefined) {
            issues.push({ path, message: refusal });
        } else if (!schemaEntry(key)) {
            // An installation setting outside the schema (an app preference): its descriptor is its only check.
            const capability = scenarioCapability(key) as { value: ScenarioValueDescriptor };
            if (!descriptorAccepts(capability.value, value)) {
                issues.push({ path, message: `${key} does not take this value` });
            }
        } else if (!validateSetting(key, value, context)) {
            issues.push({ path, message: String(getValidationError(key, value, context)) });
        }
    }
    // A pair is supplied together across the phase's settings and its bindings combined.
    for (const pair of SETTING_PAIRS) {
        const present = pair.filter((key) => Object.prototype.hasOwnProperty.call(values, key) || boundKeys.has(key));
        if (present.length === 1) {
            const missing = pair.find((key) => !present.includes(key));
            issues.push({ path: `${basePath}.${missing}`, message: `Set ${pair.join(' and ')} together` });
        }
    }
    return issues;
};

/**
 * What an expression of this type is called in a message.
 */
const describeType = (type: ExprType): string => (type.kind === 'number' ? `a ${type.quantity}` : `a ${type.kind}`);

/**
 * Whether two expression types are the same: one kind, and for numbers one quantity.
 */
const sameType = (a: ExprType, b: ExprType): boolean =>
    a.kind === b.kind && (a.kind !== 'number' || (b.kind === 'number' && a.quantity === b.quantity));

/**
 * What a binding or a schedule expression may not read, as it is worked out before the phase's overlay exists: a policy fact
 * is derived from the effective settings, and an effective setting is the overlay itself. Only for a sound expression.
 */
const baseOnlyIssues = (expr: ScenarioExpr, path: string): ScenarioIssue[] => {
    const issues: ScenarioIssue[] = [];
    const { facts, settings } = exprReferences(expr);
    for (const { name } of facts) {
        if (FACTS[name].classification === 'policy') {
            issues.push({
                path,
                message: `${name} depends on the effective settings: a binding cannot read it`,
            });
        }
    }
    for (const reference of settings) {
        if (reference.view === 'effective') {
            issues.push({
                path,
                message: `${reference.key} is read with the phase applied: a binding reads base settings only`,
            });
        }
    }
    return issues;
};

/**
 * The issues of one binding: its key is one a challenge phase may write and is not also set literally, the expression is
 * sound and of the type the setting holds, and it reads only what a binding may. A binding is worked out before the
 * phase's overlay exists, so it may read base settings and raw facts: a policy fact is derived from the effective
 * settings, and an effective setting is the overlay itself.
 */
const bindingIssues = (
    key: string,
    expr: ScenarioExpr,
    basePath: string,
    literals: Record<string, unknown> | undefined,
    scope: ScenarioScope,
): ScenarioIssue[] => {
    const path = `${basePath}.bindings.${key}`;
    if (literals && Object.prototype.hasOwnProperty.call(literals, key)) {
        return [{ path, message: `${key} is set in settings and bound: use one of them` }];
    }
    const refusal = phaseRefusal(key, scope);
    if (refusal !== undefined) return [{ path, message: refusal }];
    // phaseRefusal returned nothing: the key has a capability a phase of this scope may write.
    const target = exprTypeOfDescriptor((scenarioCapability(key) as { value: ScenarioValueDescriptor }).value);
    if (target === null) return [{ path, message: `"${key}" has no value an expression can set` }];
    const checked = expressionIssues(expr, path, [stageOf(scope)]);
    const issues = [...checked.issues];
    if (checked.type && !sameType(checked.type, target)) {
        issues.push({
            path,
            message: `This gives ${describeType(checked.type)}, but ${key} takes ${describeType(target)}`,
        });
    }
    if (checked.issues.length === 0) issues.push(...baseOnlyIssues(expr, path));
    return issues;
};

/** The settings each dynamic schedule replaces: a phase holds the schedule or these, not both. */
const SCHEDULE_REPLACED_KEYS = {
    submit: ['autoSubmitSchedule'],
    vote: ['scheduledFillTime', 'scheduledFillBeforeEnd', 'scheduledFillWindowMinutes'],
    pause: ['votingPauseTime', 'votingPauseBeforeEnd', 'votingPauseDurationMinutes'],
} as const;

/** What a schedule row's expression must give. */
const rowIssues = (
    expr: ScenarioExpr,
    path: string,
    field: 'at' | 'duration',
    scope: ScenarioScope,
): ScenarioIssue[] => {
    const checked = expressionIssues(expr, path, [stageOf(scope)]);
    if (checked.issues.length > 0) return checked.issues;
    const wanted = field === 'at' ? 'instant' : 'duration';
    const right = checked.type?.kind === 'number' && checked.type.quantity === wanted;
    return [
        ...(right ? [] : [{ path, message: `${field} needs ${field === 'at' ? 'an instant' : 'a duration'}` }]),
        ...baseOnlyIssues(expr, path),
    ];
};

/**
 * The issues of a phase's dynamic schedules: none replaces a setting the phase also sets or binds, a submit count appears
 * once, and every row expression is sound, of the type its field needs, and reads only what a binding may (base settings and
 * raw facts). The expressions of an installation scenario are not checked: it takes no schedules at all.
 */
const scheduleIssues = (
    phase: ParsedScenarioDocument['phases'][string],
    phasePath: string,
    scope: ScenarioScope,
): ScenarioIssue[] => {
    const { schedules } = phase;
    if (!schedules || scope === 'installation') return [];
    const issues: ScenarioIssue[] = [];
    for (const kind of ['submit', 'vote', 'pause'] as const) {
        if (!schedules[kind]) continue;
        for (const key of SCHEDULE_REPLACED_KEYS[kind]) {
            for (const holder of ['settings', 'bindings'] as const) {
                if (Object.prototype.hasOwnProperty.call(phase[holder] ?? {}, key)) {
                    issues.push({
                        path: `${phasePath}.${holder}.${key}`,
                        message: `A phase schedule replaces ${key}: remove one of them`,
                    });
                }
            }
        }
    }
    const submit = schedules.submit;
    if (submit && new Set(submit.rows.map((row) => row.count)).size !== submit.rows.length) {
        issues.push({ path: `${phasePath}.schedules.submit.rows`, message: 'Each submit count can appear only once' });
    }
    submit?.rows.forEach((row, index) =>
        issues.push(...rowIssues(row.at, `${phasePath}.schedules.submit.rows[${index}].at`, 'at', scope)),
    );
    for (const kind of ['vote', 'pause'] as const) {
        schedules[kind]?.rows.forEach((row, index) => {
            const rowPath = `${phasePath}.schedules.${kind}.rows[${index}]`;
            issues.push(...rowIssues(row.at, `${rowPath}.at`, 'at', scope));
            issues.push(...rowIssues(row.duration, `${rowPath}.duration`, 'duration', scope));
        });
    }
    return issues;
};

/** Every memory slot the expressions of a phase's schedules read. */
const scheduleMemoryReads = (phase: ParsedScenarioDocument['phases'][string]): string[] => {
    const { schedules } = phase;
    const exprs = [
        ...(schedules?.submit?.rows.map((row) => row.at) ?? []),
        ...(['vote', 'pause'] as const).flatMap((kind) =>
            (schedules?.[kind]?.rows ?? []).flatMap((row) => [row.at, row.duration]),
        ),
    ];
    return exprs.flatMap((expr) =>
        exprReferences(expr).facts.flatMap(({ select }) => (select?.by === 'memory' ? [select.slot] : [])),
    );
};

/**
 * Every memory slot the expressions of a phase's bindings read.
 */
const bindingMemoryReads = (bindings: Record<string, ScenarioExpr>): string[] =>
    Object.values(bindings).flatMap((expr) =>
        exprReferences(expr).facts.flatMap(({ select }) => (select?.by === 'memory' ? [select.slot] : [])),
    );

/**
 * Why a stored profile cannot be a phase's profile: it sets a key a phase may not write (the scenario assignment, Manual
 * Only), which is refused rather than left out silently. Nothing when the profile is not saved (it can be saved later:
 * a missing one blocks the challenge when the phase is published) or sets only keys a phase may write.
 */
const profileIssue = (name: string, path: string, profiles: Record<string, unknown>): ScenarioIssue | null => {
    const key = findProfileKey(profiles, normalizeProfileName(name));
    const values = key === null ? null : profiles[key];
    if (!isPlainObject(values)) return null;
    for (const settingKey of Object.keys(values)) {
        const refusal = schemaEntry(settingKey)?.perChallenge ? phaseRefusal(settingKey) : undefined;
        if (refusal !== undefined) return { path, message: `Profile "${name}" sets ${settingKey}. ${refusal}` };
    }
    return null;
};

/**
 * The issues of a join's price limit: a sound expression, available in the rule's stages, that gives an amount of coins.
 */
const priceLimitIssues = (expr: ScenarioExpr, stepPath: string, stages: readonly ScenarioStage[]): ScenarioIssue[] => {
    const checked = expressionIssues(expr, `${stepPath}.maxCoins`, stages);
    const coins = checked.type?.kind === 'number' && checked.type.quantity === 'coins';
    return checked.type && !coins
        ? [...checked.issues, { path: `${stepPath}.maxCoins`, message: 'The price limit is an amount of coins' }]
        : checked.issues;
};

/**
 * The issues of a `runAutomation` step: `join` runs before joining only, every other operation while the challenge is
 * active.
 */
const automationIssues = (
    operation: (typeof vocabulary.AUTOMATION_OPERATIONS)[number],
    stepPath: string,
    stages: readonly ScenarioStage[],
): ScenarioIssue[] => {
    const home: ScenarioStage = operation === 'join' ? 'preJoin' : 'active';
    return stages
        .filter((stage) => stage !== home)
        .map((stage) => ({
            path: `${stepPath}.operation`,
            message: `${operation} is ${operation === 'join' ? 'a pre-join operation' : 'an active-challenge operation'}: it is not available ${stagePhrase(stage)}`,
        }));
};

/**
 * Whether a setSetting value is an expression rather than a literal: literals are flags, numbers, texts and lists.
 */
const isExpressionValue = (value: unknown): value is ScenarioExpr =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The issues of a `setSetting` / `clearSetting` step: its key is one the document's scope may patch and has a value an
 * action can set, and the value is a literal that key takes (and its own validation accepts) or an expression of its type.
 * What the settings hold together (a pair, a group) is judged when the action runs, against the values then in force.
 */
const settingActionIssues = (
    step: { key: string; value?: unknown },
    stepPath: string,
    scope: ScenarioScope,
    stages: readonly ScenarioStage[],
): ScenarioIssue[] => {
    const refusal = phaseRefusal(step.key, scope);
    if (refusal !== undefined) return [{ path: `${stepPath}.key`, message: refusal }];
    // phaseRefusal returned nothing: the key has a capability a phase of this scope may write.
    const descriptor = (scenarioCapability(step.key) as { value: ScenarioValueDescriptor }).value;
    const target = exprTypeOfDescriptor(descriptor);
    if (target === null) return [{ path: `${stepPath}.key`, message: `"${step.key}" has no value an action can set` }];
    if (!('value' in step)) return [];
    const path = `${stepPath}.value`;
    if (isExpressionValue(step.value)) {
        const checked = expressionIssues(step.value, path, stages);
        const mismatch =
            checked.type && !sameType(checked.type, target)
                ? [
                      {
                          path,
                          message: `This gives ${describeType(checked.type)}, but ${step.key} takes ${describeType(target)}`,
                      },
                  ]
                : [];
        return [...checked.issues, ...mismatch];
    }
    if (!descriptorAccepts(descriptor, step.value)) return [{ path, message: `${step.key} does not take this value` }];
    return schemaEntry(step.key) && !validateSetting(step.key, step.value)
        ? [{ path, message: String(getValidationError(step.key, step.value)) }]
        : [];
};

/**
 * Rule ids unique across the scenario (the engine keys its "already fired"
 * records by them). Missing ids are generated as `<phase>-<n>`.
 */
export const assignRuleIds = (doc: ParsedScenarioDocument): ScenarioDocument => {
    const taken = new Set();
    for (const phaseDoc of Object.values(doc.phases)) {
        for (const item of phaseDoc.rules ?? []) if (item.id) taken.add(item.id);
    }
    /** @param phaseName @param index */
    const freshId = (phaseName: string, index: number) => {
        let id = `${phaseName}-${index + 1}`.slice(0, 40);
        for (let n = 2; taken.has(id); n++) id = `${phaseName}-${index + 1}-${n}`.slice(0, 40);
        taken.add(id);
        return id;
    };
    const phases: Record<string, ScenarioPhase> = {};
    for (const [phaseName, { rules, ...phaseDoc }] of Object.entries(doc.phases)) {
        phases[phaseName] = rules
            ? {
                  ...phaseDoc,
                  rules: rules.map((item, index) => ({ ...item, id: item.id || freshId(phaseName, index) })),
              }
            : phaseDoc;
    }
    return { ...doc, phases };
};

/** The Chosen Photos settings a phase's `photoPool` replaces: a phase holds the pool or these, not both. */
const POOL_REPLACED_KEYS = ['chosenPhotos', 'chosenPhotosOnly', 'chosenPhotosInOrder'] as const;

/**
 * The issues of what a phase holds for a challenge's photos: pins and a photo pool belong to a challenge scenario, one
 * photo is never pinned for both powers, and a pool replaces the phase's own Chosen Photos settings.
 */
const phaseHoldingIssues = (
    phase: ParsedScenarioDocument['phases'][string],
    phasePath: string,
    scope: ScenarioScope,
): ScenarioIssue[] => {
    const issues: ScenarioIssue[] = [];
    if (scope === 'installation') {
        for (const field of ['pins', 'photoPool', 'schedules'] as const) {
            if (phase[field] !== undefined) {
                issues.push({ path: `${phasePath}.${field}`, message: `${field} is for a challenge scenario` });
            }
        }
        return issues;
    }
    if (phase.pins?.boost && phase.pins.boost === phase.pins.turbo) {
        issues.push({ path: `${phasePath}.pins`, message: 'A photo is pinned for Boost or Turbo, not both' });
    }
    if (phase.photoPool) {
        const held = new Set([...Object.keys(phase.settings ?? {}), ...Object.keys(phase.bindings ?? {})]);
        for (const key of POOL_REPLACED_KEYS.filter((name) => held.has(name))) {
            issues.push({
                path: `${phasePath}.photoPool`,
                message: `A photo pool replaces ${key}: remove one of them`,
            });
        }
    }
    return issues;
};

/**
 * Checks the zod shape cannot express: references, unique rule ids, nesting
 * depth, and the phase settings overlays. `profiles` are the saved profiles a
 * phase's profile is looked up in (null: not checked, which is how a stored
 * scenario is read back: editing a profile later must not make the scenarios that
 * name it vanish — the phase is blocked when it is published instead).
 */
export const semanticIssues = (
    doc: ParsedScenarioDocument,
    globalDefaults: Record<string, unknown>,
    profiles: Record<string, unknown> | null,
): ScenarioIssue[] => {
    const issues = [];
    const scope: ScenarioScope = doc.scope ?? 'challenge';
    const phaseNames = new Set(Object.keys(doc.phases));
    if (!phaseNames.has(doc.start)) issues.push({ path: 'start', message: `No phase named "${doc.start}"` });

    const ruleIds = new Set();
    const reads: Array<{ slot: string; path: string }> = [];
    const writes = new Set();
    for (const [phaseName, phaseDoc] of Object.entries(doc.phases)) {
        const phasePath = `phases.${phaseName}`;
        const bindings = phaseDoc.bindings ?? {};
        const boundKeys = new Set(Object.keys(bindings));
        if (phaseDoc.settings || boundKeys.size > 0) {
            issues.push(
                ...phaseSettingsIssues(
                    phaseDoc.settings ?? {},
                    `${phasePath}.settings`,
                    globalDefaults,
                    boundKeys,
                    scope,
                ),
            );
        }
        for (const [key, expr] of Object.entries(bindings)) {
            issues.push(...bindingIssues(key, expr, phasePath, phaseDoc.settings, scope));
        }
        for (const slot of bindingMemoryReads(bindings)) reads.push({ slot, path: `${phasePath}.bindings` });
        if (phaseDoc.profile !== undefined && profiles) {
            const refused = profileIssue(phaseDoc.profile, `${phasePath}.profile`, profiles);
            if (refused) issues.push(refused);
        }
        issues.push(...phaseHoldingIssues(phaseDoc, phasePath, scope));
        issues.push(...scheduleIssues(phaseDoc, phasePath, scope));
        for (const slot of scheduleMemoryReads(phaseDoc)) reads.push({ slot, path: `${phasePath}.schedules` });
        (phaseDoc.rules ?? []).forEach((item, ruleIndex) => {
            const rulePath = `${phasePath}.rules[${ruleIndex}]`;
            if (item.id) {
                if (ruleIds.has(item.id))
                    issues.push({ path: `${rulePath}.id`, message: `Duplicate rule id "${item.id}"` });
                ruleIds.add(item.id);
            }
            const scopeStages: readonly ScenarioStage[] = vocabulary.SCOPE_STAGES[scope];
            for (const declared of item.stages ?? []) {
                if (!scopeStages.includes(declared)) {
                    issues.push({
                        path: `${rulePath}.stages`,
                        message: `${declared} is not a stage of ${scope === 'installation' ? 'an installation' : 'a challenge'} scenario: use ${scopeStages.join(', ')}`,
                    });
                }
            }
            const stages = ruleStages(item.stages, scope);
            const conditions = item.if ?? [];
            if (conditionDepth(conditions) > SCENARIO_CAPS.conditionDepth) {
                issues.push({
                    path: `${rulePath}.if`,
                    message: `Conditions nest deeper than ${SCENARIO_CAPS.conditionDepth} levels`,
                });
            }
            conditions.forEach((condition, conditionIndex) =>
                issues.push(...conditionExpressionIssues(condition, `${rulePath}.if[${conditionIndex}]`, stages)),
            );
            const conditionReads = new Set<string>();
            collectConditionReads(conditions, conditionReads);
            for (const slot of conditionReads) reads.push({ slot, path: `${rulePath}.if` });
            item.do.forEach((step, stepIndex) => {
                const stepPath = `${rulePath}.do[${stepIndex}]`;
                if (step.type === 'goto' && !phaseNames.has(step.phase)) {
                    issues.push({ path: `${stepPath}.phase`, message: `No phase named "${step.phase}"` });
                }
                for (const stage of stages) {
                    if (!STAGE_ACTIONS[stage].includes(step.type)) {
                        issues.push({
                            path: `${stepPath}.type`,
                            message: `${step.type} is not available ${stagePhrase(stage)}`,
                        });
                    }
                }
                if (step.type === 'join' && step.maxCoins)
                    issues.push(...priceLimitIssues(step.maxCoins, stepPath, stages));
                if (step.type === 'runAutomation') issues.push(...automationIssues(step.operation, stepPath, stages));
                if (step.type === 'setSetting' || step.type === 'clearSetting') {
                    issues.push(...settingActionIssues(step, stepPath, scope, stages));
                }
                if (step.type === 'useProfile' && step.name !== null && profiles) {
                    const refused = profileIssue(step.name, `${stepPath}.name`, profiles);
                    if (refused) issues.push(refused);
                }
                if (step.type === 'handoffScenario' && stepIndex !== item.do.length - 1) {
                    issues.push({ path: stepPath, message: 'handoffScenario must be the last action of its rule' });
                }
                const memory = vocabulary.actionMemory(step);
                for (const slot of memory.reads) reads.push({ slot, path: stepPath });
                for (const slot of memory.writes) writes.add(slot);
            });
        });
    }
    for (const { slot, path } of reads) {
        if (!writes.has(slot))
            issues.push({ path, message: `Memory slot "${slot}" is never remembered by any action` });
    }
    return issues;
};
