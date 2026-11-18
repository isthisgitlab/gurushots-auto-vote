/**
 * The zod shapes of a scenario document. Every object is strict: these shapes
 * are the trust boundary described in ../scenarioSchema.ts.
 */

import { z } from 'zod';
import { parseDuration } from '../../scenarios/duration';
import * as vocabulary from '../../scenarios/vocabulary';
import { MAX_PROFILE_NAME_LENGTH, RESERVED_PROFILE_NAMES } from '../profileStore';

import { MAX_SCHEDULED_FILL_ENTRIES } from '../limits';

import type { ScenarioCondition, ScenarioExpr, ScenarioSchedules } from '../../types/scenario';

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

const entryField = oneOf([...vocabulary.NUMERIC_ENTRY_FIELDS, ...vocabulary.BOOLEAN_ENTRY_FIELDS]);

/**
 * An entry field's comparison: a flag compares with true or false and only with = / !=, every other field with a number.
 */
const checkEntryValue = (value: { field: string; op: string; value: number | boolean }, ctx: z.RefinementCtx) => {
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
};

/**
 * One test an `entryCount` or `entriesWhere` applies to every entry. How many there are (1-8) is checked with the expressions, in
 * semantics.ts.
 */
const entryPredicate = z
    .strictObject({ field: entryField, op, value: z.union([finiteNumber, z.boolean()]) })
    .superRefine(checkEntryValue);

const entryId = z.string().regex(/^[\w.:-]{1,64}$/, 'Use letters, digits, ".", ":", "-" or "_" (max 64)');

const selector = z.discriminatedUnion('by', [
    z.strictObject({ by: z.literal('slot'), index: z.number().int().min(0).max(4) }),
    z.strictObject({ by: z.literal('memory'), slot: identifier }),
    z.strictObject({
        by: oneOf(['fastest', 'slowest']),
        window: duration.optional(),
        skipProtected: z.boolean().optional(),
    }),
    ...vocabulary.RANKING_SELECTORS.map((by) =>
        z.strictObject({ by: z.literal(by), skipProtected: z.boolean().optional() }),
    ),
    z.strictObject({ by: z.literal('id'), id: entryId }),
    z.strictObject({ by: z.literal('pinned'), power: oneOf(vocabulary.PINNED_POWERS) }),
    z.strictObject({ by: z.literal('pendingBoostTarget') }),
    z.strictObject({ by: oneOf(['newest', 'oldest']), time: oneOf(vocabulary.ENTRY_TIME_MODES) }),
    z.strictObject({
        by: z.literal('matching'),
        where: z.array(entryPredicate).min(1).max(SCENARIO_CAPS.entryPredicates),
        order: oneOf(vocabulary.MATCH_ORDERS),
        direction: oneOf(vocabulary.ORDER_DIRECTIONS),
    }),
]);

const entryCondition = z
    .strictObject({
        type: z.literal('entry'),
        select: selector,
        field: entryField,
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
        checkEntryValue(value, ctx);
    });

/**
 * A short text of an expression literal: plain, so a shared file cannot smuggle control characters into the logs.
 */
const literalText = plainText(SCENARIO_CAPS.nameLength);

/**
 * A typed expression (scenarios/expressions.ts). Operand counts, nesting depth, quantities and what a fact or setting
 * may be are checked with the document (semantics.ts), where the expression's type is known.
 */
const expression: z.ZodType<ScenarioExpr> = z.lazy(() =>
    z.union(
        [
            z.strictObject({
                kind: z.literal('literal'),
                value: finiteNumber,
                quantity: oneOf(vocabulary.QUANTITIES),
                unit: oneOf(vocabulary.DURATION_UNITS).optional(),
            }),
            z.strictObject({ kind: z.literal('literal'), value: z.boolean() }),
            z.strictObject({ kind: z.literal('literal'), value: literalText }),
            z.strictObject({
                kind: z.literal('literal'),
                value: z.array(literalText).max(SCENARIO_CAPS.conditionsPerList),
            }),
            z.strictObject({
                kind: z.literal('fact'),
                name: oneOf(vocabulary.FACT_NAMES),
                select: selector.optional(),
                window: duration.optional(),
            }),
            z.strictObject({
                kind: z.literal('setting'),
                key: z.string().max(SCENARIO_CAPS.nameLength),
                view: oneOf(vocabulary.SETTING_VIEWS),
            }),
            z.strictObject({
                kind: z.literal('offset'),
                from: expression,
                by: expression,
                direction: oneOf(['before', 'after']),
            }),
            z.strictObject({ kind: z.literal('difference'), from: expression, to: expression }),
            z.strictObject({ kind: oneOf(['add', 'subtract']), left: expression, right: expression }),
            z.strictObject({ kind: oneOf(['earlier', 'later', 'min', 'max']), of: z.array(expression) }),
        ],
        { error: 'Not a valid expression: check its kind and fields' },
    ),
);

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
        z.strictObject({ type: z.literal('compare'), left: expression, op, right: expression }),
        ...vocabulary.PRESENCE_CONDITIONS.map((type) => z.strictObject({ type: z.literal(type), value: expression })),
        ...vocabulary.LIST_CONDITIONS.map((type) =>
            z.strictObject({ type: z.literal(type), list: expression, value: expression }),
        ),
        z.strictObject({
            type: z.literal('entriesWhere'),
            quantifier: oneOf(['any', 'all']),
            where: z.array(entryPredicate),
        }),
        z.strictObject({
            type: z.literal('entryCount'),
            where: z.array(entryPredicate),
            op,
            value: finiteNumber,
        }),
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

const settingKey = z.string().min(1).max(SCENARIO_CAPS.nameLength);

const photoId = z.string().refine(vocabulary.isPhotoId, 'Use a photo id: letters, digits, "-" or "_" (max 64)');

const poolName = z.string().refine(vocabulary.isPoolName, 'Name a photo pool (max 60 characters, no line breaks)');

const pinPower = oneOf(vocabulary.PINNED_POWERS);

/** A literal setting value as the configuration stores it: a flag, a number, a text or a list of texts. */
const settingLiteral = z.union([
    z.boolean(),
    finiteNumber,
    literalText,
    z.array(literalText).max(SCENARIO_CAPS.conditionsPerList),
]);

const settingValue = z.union([expression, settingLiteral]);

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
    // Before joining: join this challenge now. The price limit, when given, can only narrow the caps the join already has.
    z.strictObject({ type: z.literal('join'), maxCoins: expression.optional() }),
    z.strictObject({ type: z.literal('claimChallengeReward') }),
    z.strictObject({
        type: z.literal('claimMissionReward'),
        missionId: z.string().regex(/^[\w.:-]{1,64}$/, 'Use letters, digits, ".", ":", "-" or "_" (max 64)'),
    }),
    z.strictObject({ type: z.literal('earnTurbo') }),
    // Which operations are available where is checked with the document (semantics.ts): join before joining, the rest while active.
    z.strictObject({ type: z.literal('runAutomation'), operation: oneOf(vocabulary.AUTOMATION_OPERATIONS) }),
    // A runtime phase patch: a literal in the setting's stored form, or an expression worked out when the action runs. Which
    // keys a scope may patch, and what the value may be, is checked with the document (semantics.ts).
    z.strictObject({ type: z.literal('setSetting'), key: settingKey, value: settingValue }),
    z.strictObject({ type: z.literal('clearSetting'), key: settingKey }),
    z.strictObject({
        type: z.literal('useProfile'),
        name: z.string().trim().min(1, 'Name a profile').max(MAX_PROFILE_NAME_LENGTH).nullable(),
    }),
    // A runtime pin for this phase entry: the entry a selector picks when the action runs. Challenge scenarios only (semantics.ts).
    z.strictObject({ type: z.literal('setPin'), power: pinPower, entry: selector }),
    z.strictObject({ type: z.literal('clearPin'), power: pinPower }),
    z.strictObject({ type: z.literal('pauseScenario'), reason: plainText(SCENARIO_CAPS.noticeLength).optional() }),
    // Must be the last action of its rule (semantics.ts).
    z.strictObject({ type: z.literal('handoffScenario'), to: scenarioName.nullable() }),
]);

/** The stages of a rule: at least one, none twice. */
const stages = z
    .array(oneOf(vocabulary.SCENARIO_STAGES))
    .min(1, 'Name at least one stage')
    .max(vocabulary.SCENARIO_STAGES.length)
    .refine((list) => new Set(list).size === list.length, 'A stage is named twice');

const rule = z.strictObject({
    id: z
        .string()
        .regex(/^[\w-]{1,40}$/, 'Use letters, digits, "-" or "_" (max 40)')
        .optional(),
    label: plainText(SCENARIO_CAPS.nameLength).optional(),
    repeat: oneOf(vocabulary.REPEAT_MODES).optional(),
    // Where in a subject's life the rule runs; whether the document's scope allows them is checked with the document.
    stages: stages.optional(),
    if: z.array(condition).max(SCENARIO_CAPS.conditionsPerList).optional(),
    do: z.array(action).min(1, 'A rule needs at least one action').max(SCENARIO_CAPS.actionsPerRule),
});

/** Most rows a submit schedule holds: one per cumulative photo count, 1 to 4. */
const SUBMIT_SCHEDULE_ROWS = 4;

const windowSchedule = z.strictObject({
    rows: z
        .array(z.strictObject({ at: expression, duration: expression }))
        .min(1)
        .max(MAX_SCHEDULED_FILL_ENTRIES),
});

// What the phase's schedules are worked out from is checked with the document (semantics.ts); the shape fixes the fields.
const schedules: z.ZodType<ScenarioSchedules> = z.strictObject({
    submit: z
        .strictObject({
            alignment: oneOf(['end', 'absolute']),
            rows: z
                .array(z.strictObject({ count: z.number().int().min(1).max(SUBMIT_SCHEDULE_ROWS), at: expression }))
                .min(1)
                .max(SUBMIT_SCHEDULE_ROWS),
        })
        .optional(),
    vote: windowSchedule.optional(),
    pause: windowSchedule.optional(),
});

const phase = z.strictObject({
    settings: z.record(z.string(), z.unknown()).optional(),
    // Settings whose value is worked out when the phase is published, one typed expression per setting key. Which keys
    // may be bound, and what each expression may read, is checked with the document (semantics.ts).
    bindings: z.record(z.string(), expression).optional(),
    // Dynamic submit, vote and pause schedules, worked out like bindings when the phase is published.
    schedules: schedules.optional(),
    // The name of one saved challenge profile the phase applies below its own settings. Whether it exists is a runtime
    // question: a profile can be saved after the scenario.
    profile: z.string().trim().min(1, 'Name a profile').max(MAX_PROFILE_NAME_LENGTH).optional(),
    // The photo each power is pinned to while the challenge is in this phase: an image id, or null for no pin whatever
    // the saved pin says. A power it leaves out keeps the saved pin. Challenge scenarios only (semantics.ts).
    pins: z.strictObject({ boost: photoId.nullable().optional(), turbo: photoId.nullable().optional() }).optional(),
    // The named photo pool of this account the phase draws its photos from, in place of the phase's own Chosen Photos
    // settings (semantics.ts refuses both). Whether the pool exists is a runtime question: pools are the account's.
    photoPool: z
        .strictObject({ name: poolName, only: z.boolean().optional(), inOrder: z.boolean().optional() })
        .optional(),
    rules: z.array(rule).max(SCENARIO_CAPS.rulesPerPhase).optional(),
});

const limitCount = z.number().int().min(0).max(100000);

export const scenarioDocument = z.strictObject({
    name: scenarioName,
    version: z.literal(1),
    description: plainText(SCENARIO_CAPS.descriptionLength).optional(),
    // Where the scenario runs: one challenge each (omitted), or the whole installation. Each scope has its own
    // settings, facts and assignment (settings/scenarioLifecycle.ts); the document says which it is.
    scope: z.enum(['challenge', 'installation']).optional(),
    start: identifier,
    limits: z
        .strictObject({
            swaps: limitCount.optional(),
            keys: limitCount.optional(),
            fills: limitCount.optional(),
            coins: limitCount.optional(),
        })
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
