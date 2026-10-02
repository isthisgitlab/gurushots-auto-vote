import * as vocabulary from '../../scenarios/vocabulary';
import { challengeValueSetIsValid } from '../defaults';
import { schemaEntry, validateSetting, getValidationError } from '../schema';

import type { ScenarioCondition } from '../../types/scenario';
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

/** Setting keys a phase may never overlay. */
const PHASE_FORBIDDEN_KEYS = new Set(['scenario']);

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
 * Every memory slot a condition list reads.
 */
const collectConditionReads = (conditions: readonly ScenarioCondition[], into: Set<string>) => {
    for (const item of conditions) {
        if (item.type === 'memorySet') into.add(item.slot);
        if (item.type === 'entry' && item.select.by === 'memory') into.add(item.select.slot);
        if (item.type === 'not') collectConditionReads([item.condition], into);
        if (item.type === 'any' || item.type === 'all') collectConditionReads(item.of, into);
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
        if (PHASE_FORBIDDEN_KEYS.has(key)) {
            issues.push({ path, message: 'A phase cannot change the scenario assignment itself' });
        } else if (!schemaEntry(key)?.perChallenge) {
            issues.push({ path, message: 'Not a per-challenge setting' });
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
