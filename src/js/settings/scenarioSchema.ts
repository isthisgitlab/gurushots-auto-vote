/**
 * Validation of a user-defined scenario document (see scenarios/vocabulary.ts
 * for the pieces). A scenario may come from another player's shared file, so
 * this is the trust boundary:
 *
 *   - every object is strict — an unknown key is an error, never ignored;
 *   - names are bounded identifiers, and prototype-shaped names are refused;
 *   - a phase's `settings` may only hold per-challenge setting keys, each
 *     validated like a profile value, so a shared file can never reach the
 *     token, API headers, mock mode or any other global key;
 *   - references (start / goto phases, memory slots) must resolve.
 *
 * Errors come back as `{path, message}` with a readable path such as
 * `phases.buildup.rules[1].do[0].with`, so the user can find the problem.
 */

import { z } from 'zod';
import { parseDuration } from '../scenarios/duration';
import * as vocabulary from '../scenarios/vocabulary';
import { schemaEntry, validateSetting, getValidationError } from './schema';
import { challengeValueSetIsValid } from './defaults';
import { RESERVED_PROFILE_NAMES } from './profileStore';

import type { ScenarioCondition } from '../types/scenario';

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

const isReserved = (value: string) => RESERVED_PROFILE_NAMES.has(value.trim().toLowerCase());

/**
 * z.enum over one of the vocabulary's lists.
 */
const oneOf = <T extends string>(values: readonly [T, ...T[]]) => z.enum(values);

/**
 * Free text shown in logs, the CLI and the GUI (rule labels, descriptions).
 * Control characters are refused: a shared file must not be able to forge log
 * lines (CR/LF) or drive the terminal (ANSI escapes).
 */
const plainText = (max: number) =>
    z
        .string()
        .max(max)
        .regex(/^\P{Cc}*$/u, 'Remove line breaks and other control characters');

const identifier = z
    .string()
    .regex(/^[A-Za-z][\w-]{0,31}$/, 'Use letters, digits, "-" or "_", starting with a letter (max 32)')
    .refine((value) => !isReserved(value), 'This name is reserved');

const scenarioName = z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(SCENARIO_CAPS.nameLength, `Name is longer than ${SCENARIO_CAPS.nameLength} characters`)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.'()-]*$/u, "Use letters, digits, spaces and . _ - ' ( )")
    .refine((value) => !isReserved(value), 'This name is reserved');

const duration = z
    .union([z.number(), z.string()])
    .refine(
        (value) => parseDuration(value) !== null,
        'Not a duration: use seconds or "5d", "90m", "1d 6h" (max 60 days)',
    );

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time, HH:MM');
const op = oneOf(vocabulary.COMPARISON_OPS);
const finiteNumber = z.number().finite();
const stateName = z.string().regex(/^[A-Z_]{1,32}$/, 'Use an upper-case state name such as AVAILABLE');

/**
 * `{min?, max?}` — at least one bound, and min <= max.
 */
const checkRange =
    (toNumber: (value: unknown) => number | null) =>
    (value: { min?: unknown; max?: unknown }, ctx: z.RefinementCtx) => {
        if (value.min === undefined && value.max === undefined) {
            ctx.addIssue({ code: 'custom', message: 'Set min, max or both' });
            return;
        }
        const min = value.min === undefined ? null : toNumber(value.min);
        const max = value.max === undefined ? null : toNumber(value.max);
        if (min !== null && max !== null && min > max) {
            ctx.addIssue({ code: 'custom', path: ['min'], message: 'min is larger than max' });
        }
    };

const durationRange = <T extends string>(type: T) =>
    z
        .strictObject({ type: z.literal(type), min: duration.optional(), max: duration.optional() })
        .superRefine(checkRange(parseDuration));

const percent = z.number().min(0).max(100);

const selector = z.discriminatedUnion('by', [
    z.strictObject({ by: z.literal('slot'), index: z.number().int().min(0).max(4) }),
    z.strictObject({ by: z.literal('memory'), slot: identifier }),
    z.strictObject({ by: z.literal('fastest'), window: duration.optional(), skipProtected: z.boolean().optional() }),
    ...vocabulary.RANKING_SELECTORS.map((by) =>
        z.strictObject({ by: z.literal(by), skipProtected: z.boolean().optional() }),
    ),
]);

const entryCondition = z
    .strictObject({
        type: z.literal('entry'),
        select: selector,
        field: oneOf([...vocabulary.NUMERIC_ENTRY_FIELDS, ...vocabulary.BOOLEAN_ENTRY_FIELDS]),
        op,
        value: z.union([finiteNumber, z.boolean()]),
        window: duration.optional(),
    })
    .superRefine((value, ctx) => {
        if (value.window !== undefined && !vocabulary.isOneOf(vocabulary.SPEED_ENTRY_FIELDS, value.field)) {
            ctx.addIssue({
                code: 'custom',
                path: ['window'],
                message: `window only applies to ${vocabulary.SPEED_ENTRY_FIELDS.join(' and ')}`,
            });
        }
        if (vocabulary.isOneOf(vocabulary.BOOLEAN_ENTRY_FIELDS, value.field)) {
            if (typeof value.value !== 'boolean') {
                ctx.addIssue({
                    code: 'custom',
                    path: ['value'],
                    message: `${value.field} compares with true or false`,
                });
            }
            if (value.op !== '=' && value.op !== '!=') {
                ctx.addIssue({ code: 'custom', path: ['op'], message: `${value.field} only supports = and !=` });
            }
        } else if (typeof value.value !== 'number') {
            ctx.addIssue({ code: 'custom', path: ['value'], message: `${value.field} compares with a number` });
        }
    });

const condition: z.ZodType<ScenarioCondition> = z.lazy(() =>
    z.discriminatedUnion('type', [
        z
            .strictObject({ type: z.literal('dailyWindow'), from: timeOfDay, to: timeOfDay })
            .refine((value) => value.from !== value.to, { path: ['to'], message: 'from and to are the same time' }),
        ...vocabulary.RANGE_TIME_CONDITIONS.map(durationRange),
        z
            .strictObject({ type: z.literal('elapsedPercent'), min: percent.optional(), max: percent.optional() })
            .superRefine(checkRange((value) => value as number)),
        ...vocabulary.NUMERIC_CONDITIONS.map((type) =>
            z.strictObject({ type: z.literal(type), op, value: finiteNumber }),
        ),
        ...vocabulary.STATE_CONDITIONS.map((type) =>
            z.strictObject({ type: z.literal(type), in: z.array(stateName).min(1).max(10) }),
        ),
        z.strictObject({ type: z.literal('balance'), currency: oneOf(vocabulary.CURRENCIES), op, value: finiteNumber }),
        z.strictObject({ type: z.literal('memorySet'), slot: identifier }),
        entryCondition,
        z.strictObject({
            type: z.literal('all'),
            of: z.array(condition).min(1).max(SCENARIO_CAPS.conditionsPerList),
        }),
        z.strictObject({
            type: z.literal('any'),
            of: z.array(condition).min(1).max(SCENARIO_CAPS.conditionsPerList),
        }),
        z.strictObject({ type: z.literal('not'), condition }),
    ]),
);

const photoSource = z.union([z.literal('best'), z.strictObject({ memory: identifier })], {
    error: 'Use "best" or {"memory": "<slot>"}',
});

const action = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('enterPhoto'), photo: photoSource, remember: identifier.optional() }),
    z.strictObject({
        type: z.literal('swap'),
        entry: selector,
        with: photoSource,
        rememberRemoved: identifier.optional(),
        rememberAdded: identifier.optional(),
    }),
    z.strictObject({ type: z.literal('boost'), entry: selector }),
    z.strictObject({ type: z.literal('turbo'), entry: selector }),
    z.strictObject({ type: z.literal('unlockBoost') }),
    z.strictObject({ type: z.literal('fillExposure') }),
    z.strictObject({ type: z.literal('vote'), toExposure: z.number().int().min(1).max(100) }),
    z.strictObject({ type: z.literal('remember'), slot: identifier, entry: selector }),
    z.strictObject({ type: z.literal('forget'), slot: identifier }),
    z.strictObject({ type: z.literal('goto'), phase: identifier }),
    z.strictObject({
        type: z.literal('notify'),
        message: plainText(SCENARIO_CAPS.noticeLength).min(1, 'Write the message'),
    }),
]);

const rule = z.strictObject({
    id: z
        .string()
        .regex(/^[\w-]{1,40}$/, 'Use letters, digits, "-" or "_" (max 40)')
        .optional(),
    label: plainText(SCENARIO_CAPS.nameLength).optional(),
    repeat: oneOf(vocabulary.REPEAT_MODES).optional(),
    if: z.array(condition).max(SCENARIO_CAPS.conditionsPerList).optional(),
    do: z.array(action).min(1, 'A rule needs at least one action').max(SCENARIO_CAPS.actionsPerRule),
});

const phase = z.strictObject({
    settings: z.record(z.string(), z.unknown()).optional(),
    rules: z.array(rule).max(SCENARIO_CAPS.rulesPerPhase).optional(),
});

const limitCount = z.number().int().min(0).max(100000);

const scenarioDocument = z.strictObject({
    name: scenarioName,
    version: z.literal(1),
    description: plainText(SCENARIO_CAPS.descriptionLength).optional(),
    start: identifier,
    limits: z
        .strictObject({ swaps: limitCount.optional(), keys: limitCount.optional(), fills: limitCount.optional() })
        .optional(),
    phases: z
        .record(identifier, phase)
        .refine((phases) => Object.keys(phases).length >= 1, 'A scenario needs at least one phase')
        .refine(
            (phases) => Object.keys(phases).length <= SCENARIO_CAPS.phases,
            `A scenario has at most ${SCENARIO_CAPS.phases} phases`,
        ),
});

/**
 * A scenario document as zod parses it; rule ids are still optional.
 */
type ParsedScenarioDocument = z.infer<typeof scenarioDocument>;

/**
 * A validated rule: validateScenario gives every rule an id.
 */
export type ScenarioRule = z.infer<typeof rule> & { id: string };

export type ScenarioAction = ScenarioRule['do'][number];

type ScenarioPhase = Omit<z.infer<typeof phase>, 'rules'> & { rules?: ScenarioRule[] };

/**
 * A validated scenario document: names trimmed, every rule carrying an id.
 */
export type ScenarioDocument = Omit<ParsedScenarioDocument, 'phases'> & { phases: Record<string, ScenarioPhase> };

/**
 * `['phases', 'buildup', 'rules', 1, 'do', 0]` → `phases.buildup.rules[1].do[0]`.
 */
const formatPath = (path: ReadonlyArray<PropertyKey>): string =>
    path.reduce(
        (out: string, segment) =>
            typeof segment === 'number' ? `${out}[${segment}]` : out ? `${out}.${String(segment)}` : String(segment),
        '',
    );

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
const assignRuleIds = (doc: ParsedScenarioDocument): ScenarioDocument => {
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
const semanticIssues = (doc: ParsedScenarioDocument, globalDefaults: Record<string, unknown>): ScenarioIssue[] => {
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

/**
 * Validates a scenario document. On success returns the canonical document
 * (names trimmed, every rule carrying an id); otherwise every issue found.
 *
 * @param globalDefaults - the stored global challenge defaults
 */
const validateScenario = (
    input: unknown,
    globalDefaults: Record<string, unknown>,
): { ok: true; scenario: ScenarioDocument } | { ok: false; issues: ScenarioIssue[] } => {
    const parsed = scenarioDocument.safeParse(input);
    if (!parsed.success) {
        return {
            ok: false,
            issues: parsed.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
        };
    }
    const doc = parsed.data;
    const issues = semanticIssues(doc, globalDefaults);
    if (issues.length) return { ok: false, issues };
    return { ok: true, scenario: assignRuleIds(doc) };
};

/**
 * Parses shared scenario JSON text, bounded before parsing.
 */
const parseScenarioJson = (text: unknown): { ok: true; value: unknown } | { ok: false; issues: ScenarioIssue[] } => {
    if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, issues: [{ path: '', message: 'No scenario JSON was given' }] };
    }
    if (new TextEncoder().encode(text).length > SCENARIO_CAPS.importBytes) {
        return {
            ok: false,
            issues: [{ path: '', message: `The file is larger than ${SCENARIO_CAPS.importBytes / 1024} KB` }],
        };
    }
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (error) {
        // JSON.parse only ever throws a SyntaxError.
        return {
            ok: false,
            issues: [{ path: '', message: `Not valid JSON: ${(error as Error).message}` }],
        };
    }
};

export { validateScenario, parseScenarioJson, formatPath };
