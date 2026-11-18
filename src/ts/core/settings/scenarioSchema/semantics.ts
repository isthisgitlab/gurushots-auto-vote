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
import { factStageIssues } from '../../scenarios/facts';
import * as vocabulary from '../../scenarios/vocabulary';
import { challengeValueSetIsValid } from '../defaults';
import { schemaEntry, validateSetting, getValidationError } from '../schema';
import { scenarioCapability } from '../scenarioCapabilities';

import type { ExprType, SettingTypeLookup } from '../../scenarios/expressions';
import type { ScenarioCondition, ScenarioExpr } from '../../types/scenario';
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
const phaseRefusal = (key: string): string | undefined => {
    const capability = scenarioCapability(key);
    if (capability?.phaseWrite.includes('challenge')) return undefined;
    return (schemaEntry(key)?.perChallenge ? capability?.restriction : undefined) ?? 'Not a per-challenge setting';
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
 * while a challenge is active, the only stage a scenario runs in.
 */
const expressionIssues = (expr: ScenarioExpr, path: string): { type: ExprType | null; issues: ScenarioIssue[] } => {
    const checked = checkExpression(expr, settingExprType, path);
    const stage = checked.issues.length
        ? []
        : exprReferences(expr).facts.flatMap(({ name }) => factStageIssues(name, 'active', path));
    return { type: checked.type, issues: [...checked.issues, ...stage] };
};

/**
 * The issues of the expressions in a condition and its nested conditions: each expression is sound, the two sides of a
 * comparison relate, a list condition gets lists and strings, and an entry count has 1 to 8 predicates.
 */
const conditionExpressionIssues = (condition: ScenarioCondition, path: string): ScenarioIssue[] => {
    switch (condition.type) {
        case 'compare': {
            const left = expressionIssues(condition.left, `${path}.left`);
            const right = expressionIssues(condition.right, `${path}.right`);
            const relation = left.type && right.type ? compareIssue(condition.op, left.type, right.type) : null;
            return [...left.issues, ...right.issues, ...(relation ? [{ path, message: relation }] : [])];
        }
        case 'present':
        case 'absent':
            return expressionIssues(condition.value, `${path}.value`).issues;
        case 'contains':
        case 'containsAny':
        case 'containsAll': {
            const list = expressionIssues(condition.list, `${path}.list`);
            const value = expressionIssues(condition.value, `${path}.value`);
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
            return condition.of.flatMap((item, index) => conditionExpressionIssues(item, `${path}.of[${index}]`));
        case 'not':
            return conditionExpressionIssues(condition.condition, `${path}.condition`);
        default:
            return [];
    }
};

/**
 * Per-key validation of one phase's settings overlay, against the global
 * defaults as context. Mirrors a profile value set, with explicit errors
 * instead of silent drops.
 */
const phaseSettingsIssues = (
    values: Record<string, unknown>,
    basePath: string,
    globalDefaults: Record<string, unknown>,
): ScenarioIssue[] => {
    const issues = [];
    const context = { ...globalDefaults, ...values };
    for (const [key, value] of Object.entries(values)) {
        const path = `${basePath}.${key}`;
        const refusal = phaseRefusal(key);
        if (refusal !== undefined) {
            issues.push({ path, message: refusal });
        } else if (!validateSetting(key, value, context)) {
            issues.push({ path, message: String(getValidationError(key, value, context)) });
        }
    }
    for (const pair of SETTING_PAIRS) {
        const present = pair.filter((key) => Object.prototype.hasOwnProperty.call(values, key));
        if (present.length === 1) {
            const missing = pair.find((key) => !present.includes(key));
            issues.push({ path: `${basePath}.${missing}`, message: `Set ${pair.join(' and ')} together` });
        }
    }
    if (issues.length === 0 && !challengeValueSetIsValid(context, values)) {
        issues.push({ path: basePath, message: 'These values conflict with the global defaults they combine with' });
    }
    return issues;
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
 * depth, and the phase settings overlays.
 */
export const semanticIssues = (
    doc: ParsedScenarioDocument,
    globalDefaults: Record<string, unknown>,
): ScenarioIssue[] => {
    const issues = [];
    const phaseNames = new Set(Object.keys(doc.phases));
    if (!phaseNames.has(doc.start)) issues.push({ path: 'start', message: `No phase named "${doc.start}"` });

    const ruleIds = new Set();
    const reads: Array<{ slot: string; path: string }> = [];
    const writes = new Set();
    for (const [phaseName, phaseDoc] of Object.entries(doc.phases)) {
        const phasePath = `phases.${phaseName}`;
        if (phaseDoc.settings)
            issues.push(...phaseSettingsIssues(phaseDoc.settings, `${phasePath}.settings`, globalDefaults));
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
                issues.push(...conditionExpressionIssues(condition, `${rulePath}.if[${conditionIndex}]`)),
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
