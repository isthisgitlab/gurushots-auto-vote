import { z } from 'zod';
import { parseDuration } from '../../scenarios/duration';
import * as vocabulary from '../../scenarios/vocabulary';
import { RESERVED_PROFILE_NAMES } from '../profileStore';

import type { ScenarioCondition } from '../../types/scenario';

const { SCENARIO_CAPS } = vocabulary;

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

export const scenarioDocument = z.strictObject({
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
export type ParsedScenarioDocument = z.infer<typeof scenarioDocument>;

/**
 * A validated rule: validateScenario gives every rule an id.
 */
export type ScenarioRule = z.infer<typeof rule> & { id: string };

export type ScenarioAction = ScenarioRule['do'][number];

export type ScenarioPhase = Omit<z.infer<typeof phase>, 'rules'> & { rules?: ScenarioRule[] };

/**
 * A validated scenario document: names trimmed, every rule carrying an id.
 */
export type ScenarioDocument = Omit<ParsedScenarioDocument, 'phases'> & { phases: Record<string, ScenarioPhase> };
