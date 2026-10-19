/**
 * Whether a stored 1.x scenario document is one the engine may run, frozen: the zod shapes of a document, the checks
 * its shape cannot express (references, memory slots, rule ids, nesting depth, the phase settings overlays) and the
 * vocabulary and duration parser they read. A copy of `settings/scenarioSchema/{shapes,semantics}.ts`,
 * `scenarios/vocabulary.ts` and `scenarios/duration.ts` as of the last 1.x release; it never follows the live code.
 * Only the verdict and the canonical name / start / phases are kept: a rule id the live validator generates changes
 * no decision.
 */

import { z } from 'zod';

import { challengeValueSetIsValid, RESERVED_PROFILE_NAMES, validateSetting } from './values';
import { v1SchemaEntry } from '../../../src/ts/settings/importV1/schema';

import type { V1Values } from '../../../src/ts/settings/importV1/types';

const COMPARISON_OPS = ['<', '<=', '=', '!=', '>=', '>'] as const;
const REPEAT_MODES = ['always', 'once', 'oncePerPhase', 'oncePerDay'] as const;
const RANGE_TIME_CONDITIONS = ['beforeEnd', 'afterStart', 'inPhaseFor'] as const;
const NUMERIC_CONDITIONS = ['entries', 'freeSlots', 'exposure', 'challengeRank', 'challengeVotes'] as const;
const STATE_CONDITIONS = ['boostState', 'turboState'] as const;
const CURRENCIES = ['keys', 'swaps', 'fills', 'coins'] as const;
const NUMERIC_ENTRY_FIELDS = ['votes', 'rank', 'votesPerHour', 'speedRatio'] as const;
const SPEED_ENTRY_FIELDS = ['votesPerHour', 'speedRatio'] as const;
const BOOLEAN_ENTRY_FIELDS = ['boosted', 'turbo', 'boosting'] as const;
const RANKING_SELECTORS = ['mostVotes', 'fewestVotes', 'bestRank', 'worstRank', 'boosted', 'turbo'] as const;
const SCENARIO_CAPS = {
    phases: 20,
    rulesPerPhase: 30,
    conditionsPerList: 20,
    actionsPerRule: 10,
    conditionDepth: 4,
    nameLength: 60,
    noticeLength: 120,
    descriptionLength: 500,
};

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
    (list as readonly unknown[]).includes(value);

const MAX_DURATION_SEC = 60 * 24 * 60 * 60;
const UNIT_SEC = { d: 86400, h: 3600, m: 60, s: 1 };
const DURATION_PATTERN = /^\s*(?:\d+\s*[dhms]\s*)+$/i;
const PART_PATTERN = /(\d+)\s*([dhms])/gi;

const parseDuration = (value: unknown): number | null => {
    let seconds = null;
    if (typeof value === 'number') {
        seconds = Number.isInteger(value) && value >= 0 ? value : null;
    } else if (typeof value === 'string' && DURATION_PATTERN.test(value)) {
        seconds = 0;
        for (const [, amount, unit] of value.matchAll(PART_PATTERN)) {
            seconds += Number(amount) * UNIT_SEC[unit.toLowerCase() as 'd' | 'h' | 'm' | 's'];
        }
    }
    return seconds !== null && seconds <= MAX_DURATION_SEC ? seconds : null;
};

type Condition = {
    type: string;
    condition?: Condition;
    of?: Condition[];
    slot?: string;
    select?: { by: string; slot?: string };
};

const isReserved = (value: string) => RESERVED_PROFILE_NAMES.has(value.trim().toLowerCase());

const oneOf = <T extends string>(values: readonly [T, ...T[]]) => z.enum(values);

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
const op = oneOf(COMPARISON_OPS);
const finiteNumber = z.number().finite();
const stateName = z.string().regex(/^[A-Z_]{1,32}$/, 'Use an upper-case state name such as AVAILABLE');

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
    ...RANKING_SELECTORS.map((by) => z.strictObject({ by: z.literal(by), skipProtected: z.boolean().optional() })),
]);

const entryCondition = z
    .strictObject({
        type: z.literal('entry'),
        select: selector,
        field: oneOf([...NUMERIC_ENTRY_FIELDS, ...BOOLEAN_ENTRY_FIELDS]),
        op,
        value: z.union([finiteNumber, z.boolean()]),
        window: duration.optional(),
    })
    .superRefine((value, ctx) => {
        if (value.window !== undefined && !isOneOf(SPEED_ENTRY_FIELDS, value.field)) {
            ctx.addIssue({
                code: 'custom',
                path: ['window'],
                message: `window only applies to ${SPEED_ENTRY_FIELDS.join(' and ')}`,
            });
        }
        if (isOneOf(BOOLEAN_ENTRY_FIELDS, value.field)) {
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

const condition: z.ZodType<Condition> = z.lazy(() =>
    z.discriminatedUnion('type', [
        z
            .strictObject({ type: z.literal('dailyWindow'), from: timeOfDay, to: timeOfDay })
            .refine((value) => value.from !== value.to, { path: ['to'], message: 'from and to are the same time' }),
        ...RANGE_TIME_CONDITIONS.map(durationRange),
        z
            .strictObject({ type: z.literal('elapsedPercent'), min: percent.optional(), max: percent.optional() })
            .superRefine(checkRange((value) => value as number)),
        ...NUMERIC_CONDITIONS.map((type) => z.strictObject({ type: z.literal(type), op, value: finiteNumber })),
        ...STATE_CONDITIONS.map((type) =>
            z.strictObject({ type: z.literal(type), in: z.array(stateName).min(1).max(10) }),
        ),
        z.strictObject({ type: z.literal('balance'), currency: oneOf(CURRENCIES), op, value: finiteNumber }),
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
    repeat: oneOf(REPEAT_MODES).optional(),
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

type ParsedDocument = z.infer<typeof scenarioDocument>;
type Action = z.infer<typeof action>;
type Selector = z.infer<typeof selector>;

// Pairs a phase must set together.
const SETTING_PAIRS = [
    ['exposure', 'exposureTarget'],
    ['finalWindowExposure', 'finalWindowExposureTarget'],
];

// Keys a phase may never overlay, each with its refusal.
const PHASE_FORBIDDEN_KEYS = new Map([
    ['scenario', 'A phase cannot change the scenario assignment itself'],
    ['manualPhotosOnly', 'A phase cannot change Manual Photos Only'],
]);

const conditionDepth = (conditions: readonly Condition[]): number => {
    let depth = 0;
    for (const item of conditions) {
        const nested =
            item.type === 'not' && item.condition
                ? [item.condition]
                : item.type === 'any' || item.type === 'all'
                  ? (item.of ?? [])
                  : [];
        depth = Math.max(depth, 1 + (nested.length ? conditionDepth(nested) : 0));
    }
    return depth;
};

const collectConditionReads = (conditions: readonly Condition[], into: Set<string>) => {
    for (const item of conditions) {
        if (item.type === 'memorySet' && item.slot !== undefined) into.add(item.slot);
        if (item.type === 'entry' && item.select?.by === 'memory' && item.select.slot !== undefined) {
            into.add(item.select.slot);
        }
        if (item.type === 'not' && item.condition) collectConditionReads([item.condition], into);
        if (item.type === 'any' || item.type === 'all') collectConditionReads(item.of ?? [], into);
    }
};

const actionMemory = (step: Action): { reads: string[]; writes: string[] } => {
    const reads: string[] = [];
    const writes: string[] = [];
    const readEntry = (entry: Selector) => {
        if (entry.by === 'memory') reads.push(entry.slot);
    };
    const readPhoto = (photo: 'best' | { memory: string }) => {
        if (photo !== 'best') reads.push(photo.memory);
    };
    switch (step.type) {
        case 'enterPhoto':
            readPhoto(step.photo);
            if (step.remember) writes.push(step.remember);
            break;
        case 'swap':
            readEntry(step.entry);
            readPhoto(step.with);
            if (step.rememberRemoved) writes.push(step.rememberRemoved);
            if (step.rememberAdded) writes.push(step.rememberAdded);
            break;
        case 'remember':
            readEntry(step.entry);
            writes.push(step.slot);
            break;
        case 'boost':
        case 'turbo':
            readEntry(step.entry);
            break;
        default:
            break;
    }
    return { reads, writes };
};

const phaseSettingsHaveIssues = (values: Record<string, unknown>, globalDefaults: V1Values): boolean => {
    const context = { ...globalDefaults, ...values };
    for (const [key, value] of Object.entries(values)) {
        if (PHASE_FORBIDDEN_KEYS.has(key)) return true;
        if (!v1SchemaEntry(key)?.perChallenge) return true;
        if (!validateSetting(key, value, context)) return true;
    }
    for (const pair of SETTING_PAIRS) {
        if (pair.filter((key) => Object.hasOwn(values, key)).length === 1) return true;
    }
    return !challengeValueSetIsValid(context, values);
};

// Whether the checks the zod shape cannot express find anything: references, unique rule ids, nesting depth, memory
// slots, and the phase settings overlays.
const hasSemanticIssues = (doc: ParsedDocument, globalDefaults: V1Values): boolean => {
    const phaseNames = new Set(Object.keys(doc.phases));
    if (!phaseNames.has(doc.start)) return true;
    const ruleIds = new Set<string>();
    const reads: string[] = [];
    const writes = new Set<string>();
    for (const phaseDoc of Object.values(doc.phases)) {
        if (phaseDoc.settings && phaseSettingsHaveIssues(phaseDoc.settings, globalDefaults)) return true;
        for (const item of phaseDoc.rules ?? []) {
            if (item.id) {
                if (ruleIds.has(item.id)) return true;
                ruleIds.add(item.id);
            }
            const conditions = item.if ?? [];
            if (conditionDepth(conditions) > SCENARIO_CAPS.conditionDepth) return true;
            const conditionReads = new Set<string>();
            collectConditionReads(conditions, conditionReads);
            reads.push(...conditionReads);
            for (const step of item.do) {
                if (step.type === 'goto' && !phaseNames.has(step.phase)) return true;
                const memory = actionMemory(step);
                reads.push(...memory.reads);
                for (const slot of memory.writes) writes.add(slot);
            }
        }
    }
    return reads.some((slot) => !writes.has(slot));
};

/** What the engine reads of a valid scenario document. */
type OracleScenario = { name: string; start: string; phases: Record<string, { settings?: Record<string, unknown> }> };

/** The document as the engine may run it, or null when the validator refuses it. */
const validatedScenario = (input: unknown, globalDefaults: V1Values): OracleScenario | null => {
    const parsed = scenarioDocument.safeParse(input);
    if (!parsed.success || hasSemanticIssues(parsed.data, globalDefaults)) return null;
    const { name, start, phases } = parsed.data;
    return { name, start, phases };
};

export { validatedScenario };
export type { OracleScenario };
