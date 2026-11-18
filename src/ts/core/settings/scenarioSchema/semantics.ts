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
import { FACTS, factStageIssues } from '../../scenarios/facts';
import * as vocabulary from '../../scenarios/vocabulary';
import { challengeValueSetIsValid } from '../defaults';
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

/**
 * Cross-field pairs a phase must set together. getEffectiveSetting does not
 * re-validate combined values at read time, so a phase setting only one side
 * could meet a manual override of the other side and form a pair the settings
 * screen would reject (same rule the built-in intent profiles follow).
 */
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

// The conditions that read the challenge a scenario runs on: an installation scenario has none.
const CHALLENGE_CONDITIONS: ReadonlySet<string> = new Set([
    'beforeEnd',
    'afterStart',
    'elapsedPercent',
    ...vocabulary.NUMERIC_CONDITIONS,
    ...vocabulary.STATE_CONDITIONS,
    'entry',
    'entriesWhere',
    'entryCount',
]);

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
 * in the stage the scenario runs in.
 */
const expressionIssues = (
    expr: ScenarioExpr,
    path: string,
    stage: ScenarioStage,
): { type: ExprType | null; issues: ScenarioIssue[] } => {
    const checked = checkExpression(expr, settingExprType, path);
    const unavailable = checked.issues.length
        ? []
        : exprReferences(expr).facts.flatMap(({ name }) => factStageIssues(name, stage, path));
    return { type: checked.type, issues: [...checked.issues, ...unavailable] };
};

/**
 * The issues of the expressions in a condition and its nested conditions: each expression is sound, the two sides of a
 * comparison relate, a list condition gets lists and strings, and an entry count has 1 to 8 predicates.
 */
const conditionExpressionIssues = (
    condition: ScenarioCondition,
    path: string,
    stage: ScenarioStage,
): ScenarioIssue[] => {
    if (stage === 'account' && CHALLENGE_CONDITIONS.has(condition.type)) {
        return [{ path, message: `${condition.type} reads a challenge: an installation scenario cannot use it` }];
    }
    switch (condition.type) {
        case 'compare': {
            const left = expressionIssues(condition.left, `${path}.left`, stage);
            const right = expressionIssues(condition.right, `${path}.right`, stage);
            const relation = left.type && right.type ? compareIssue(condition.op, left.type, right.type) : null;
            return [...left.issues, ...right.issues, ...(relation ? [{ path, message: relation }] : [])];
        }
        case 'present':
        case 'absent':
            return expressionIssues(condition.value, `${path}.value`, stage).issues;
        case 'contains':
        case 'containsAny':
        case 'containsAll': {
            const list = expressionIssues(condition.list, `${path}.list`, stage);
            const value = expressionIssues(condition.value, `${path}.value`, stage);
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
                conditionExpressionIssues(item, `${path}.of[${index}]`, stage),
            );
        case 'not':
            return conditionExpressionIssues(condition.condition, `${path}.condition`, stage);
        default:
            return [];
    }
};

/**
 * Per-key validation of one phase's settings overlay, against the global
 * defaults as context. Mirrors a profile value set, with explicit errors
 * instead of silent drops. `boundKeys` are the keys the phase binds instead of
 * setting: they complete a pair but are not values to check here.
 */
const phaseSettingsIssues = (
    values: Record<string, unknown>,
    basePath: string,
    globalDefaults: Record<string, unknown>,
    boundKeys: ReadonlySet<string>,
    scope: ScenarioScope,
): ScenarioIssue[] => {
    const issues = [];
    const context = { ...globalDefaults, ...values };
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
    if (issues.length === 0 && scope === 'challenge' && !challengeValueSetIsValid(context, values)) {
        issues.push({ path: basePath, message: 'These values conflict with the global defaults they combine with' });
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
    const checked = expressionIssues(expr, path, stageOf(scope));
    const issues = [...checked.issues];
    if (checked.type && !sameType(checked.type, target)) {
        issues.push({
            path,
            message: `This gives ${describeType(checked.type)}, but ${key} takes ${describeType(target)}`,
        });
    }
    if (checked.issues.length === 0) {
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
    }
    return issues;
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
    const stage = stageOf(scope);
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
        (phaseDoc.rules ?? []).forEach((item, ruleIndex) => {
            const rulePath = `${phasePath}.rules[${ruleIndex}]`;
            if (item.id) {
                if (ruleIds.has(item.id))
                    issues.push({ path: `${rulePath}.id`, message: `Duplicate rule id "${item.id}"` });
                ruleIds.add(item.id);
            }
            const conditions = item.if ?? [];
            if (conditionDepth(conditions) > SCENARIO_CAPS.conditionDepth) {
                issues.push({
                    path: `${rulePath}.if`,
                    message: `Conditions nest deeper than ${SCENARIO_CAPS.conditionDepth} levels`,
                });
            }
            conditions.forEach((condition, conditionIndex) =>
                issues.push(...conditionExpressionIssues(condition, `${rulePath}.if[${conditionIndex}]`, stage)),
            );
            const conditionReads = new Set<string>();
            collectConditionReads(conditions, conditionReads);
            for (const slot of conditionReads) reads.push({ slot, path: `${rulePath}.if` });
            item.do.forEach((step, stepIndex) => {
                const stepPath = `${rulePath}.do[${stepIndex}]`;
                if (step.type === 'goto' && !phaseNames.has(step.phase)) {
                    issues.push({ path: `${stepPath}.phase`, message: `No phase named "${step.phase}"` });
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
