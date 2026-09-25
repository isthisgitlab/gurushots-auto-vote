// @ts-check
/**
 * Validation of a user-defined scenario document (see scenarios/vocabulary.js
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

const { z } = require('zod');
const { parseDuration } = require('../scenarios/duration');
const vocabulary = require('../scenarios/vocabulary');
const { SETTINGS_SCHEMA, validateSetting, getValidationError } = require('./schema');
const { challengeValueSetIsValid } = require('./defaults');
const { RESERVED_PROFILE_NAMES } = require('./profileStore');

/** @typedef {{path: string, message: string}} ScenarioIssue */

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

const isReserved = (/** @type {string} */ value) => RESERVED_PROFILE_NAMES.has(value.trim().toLowerCase());

/** z.enum over one of the vocabulary's plain string lists. */
const oneOf = (/** @type {string[]} */ values) => z.enum(/** @type {[string, ...string[]]} */ (values));

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
 *
 * @param {(value: unknown) => number|null} toNumber
 */
const checkRange =
    (toNumber) => (/** @type {{min?: unknown, max?: unknown}} */ value, /** @type {z.RefinementCtx} */ ctx) => {
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

const durationRange = (/** @type {string} */ type) =>
    z
        .strictObject({ type: z.literal(type), min: duration.optional(), max: duration.optional() })
        .superRefine(checkRange(parseDuration));

const percent = z.number().min(0).max(100);

const selector = z.discriminatedUnion('by', [
    z.strictObject({ by: z.literal('slot'), index: z.number().int().min(0).max(4) }),
    z.strictObject({ by: z.literal('memory'), slot: identifier }),
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
    })
    .superRefine((value, ctx) => {
        if (vocabulary.BOOLEAN_ENTRY_FIELDS.includes(value.field)) {
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

/** @type {z.ZodType<any>} */
const condition = z.lazy(() =>
    z.discriminatedUnion('type', [
        z
            .strictObject({ type: z.literal('dailyWindow'), from: timeOfDay, to: timeOfDay })
            .refine((value) => value.from !== value.to, { path: ['to'], message: 'from and to are the same time' }),
        ...vocabulary.RANGE_TIME_CONDITIONS.map(durationRange),
        z
            .strictObject({ type: z.literal('elapsedPercent'), min: percent.optional(), max: percent.optional() })
            .superRefine(checkRange((value) => /** @type {number} */ (value))),
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
]);

const rule = z.strictObject({
    id: z
        .string()
        .regex(/^[\w-]{1,40}$/, 'Use letters, digits, "-" or "_" (max 40)')
        .optional(),
    label: z.string().max(SCENARIO_CAPS.nameLength).optional(),
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
    description: z.string().max(SCENARIO_CAPS.descriptionLength).optional(),
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
 * `['phases', 'buildup', 'rules', 1, 'do', 0]` → `phases.buildup.rules[1].do[0]`.
 *
 * @param {ReadonlyArray<PropertyKey>} path
 * @returns {string}
 */
const formatPath = (path) =>
    path.reduce(
        (/** @type {string} */ out, segment) =>
            typeof segment === 'number' ? `${out}[${segment}]` : out ? `${out}.${String(segment)}` : String(segment),
        '',
    );

/**
 * Nesting depth of a condition list (a flat list is depth 1).
 *
 * @param {any[]} conditions
 * @returns {number}
 */
const conditionDepth = (conditions) => {
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
 *
 * @param {any[]} conditions
 * @param {Set<string>} into
 */
const collectConditionReads = (conditions, into) => {
    for (const item of conditions) {
        if (item.type === 'memorySet') into.add(item.slot);
        if (item.type === 'entry' && item.select.by === 'memory') into.add(item.select.slot);
        if (item.type === 'not') collectConditionReads([item.condition], into);
        if (item.type === 'any' || item.type === 'all') collectConditionReads(item.of, into);
    }
};

/**
 * Memory slots an action reads and writes.
 *
 * @param {any} item
 * @returns {{reads: string[], writes: string[]}}
 */
const actionMemory = (item) => {
    const reads = [];
    const writes = [];
    if (item.entry?.by === 'memory') reads.push(item.entry.slot);
    for (const source of [item.photo, item.with]) {
        if (source && typeof source === 'object') reads.push(source.memory);
    }
    for (const key of ['remember', 'rememberRemoved', 'rememberAdded']) {
        if (typeof item[key] === 'string') writes.push(item[key]);
    }
    if (item.type === 'remember') writes.push(item.slot);
    return { reads, writes };
};

/**
 * Per-key validation of one phase's settings overlay, against the global
 * defaults as context. Mirrors a profile value set, with explicit errors
 * instead of silent drops.
 *
 * @param {Record<string, unknown>} values
 * @param {string} basePath
 * @param {Record<string, unknown>} globalDefaults
 * @returns {ScenarioIssue[]}
 */
const phaseSettingsIssues = (values, basePath, globalDefaults) => {
    const issues = [];
    const context = { ...globalDefaults, ...values };
    for (const [key, value] of Object.entries(values)) {
        const path = `${basePath}.${key}`;
        if (PHASE_FORBIDDEN_KEYS.has(key)) {
            issues.push({ path, message: 'A phase cannot change the scenario assignment itself' });
        } else if (!Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key) || !SETTINGS_SCHEMA[key].perChallenge) {
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
 *
 * @param {any} doc - a parsed scenario document (mutated)
 */
const assignRuleIds = (doc) => {
    const taken = new Set();
    for (const phaseDoc of Object.values(doc.phases)) {
        for (const item of phaseDoc.rules ?? []) if (item.id) taken.add(item.id);
    }
    for (const [phaseName, phaseDoc] of Object.entries(doc.phases)) {
        (phaseDoc.rules ?? []).forEach((/** @type {any} */ item, /** @type {number} */ index) => {
            if (item.id) return;
            let id = `${phaseName}-${index + 1}`.slice(0, 40);
            for (let n = 2; taken.has(id); n++) id = `${phaseName}-${index + 1}-${n}`.slice(0, 40);
            taken.add(id);
            item.id = id;
        });
    }
};

/**
 * Checks the zod shape cannot express: references, unique rule ids, nesting
 * depth, and the phase settings overlays.
 *
 * @param {any} doc - a zod-parsed scenario document
 * @param {Record<string, unknown>} globalDefaults
 * @returns {ScenarioIssue[]}
 */
const semanticIssues = (doc, globalDefaults) => {
    const issues = [];
    const phaseNames = new Set(Object.keys(doc.phases));
    if (!phaseNames.has(doc.start)) issues.push({ path: 'start', message: `No phase named "${doc.start}"` });

    const ruleIds = new Set();
    /** @type {Array<{slot: string, path: string}>} */
    const reads = [];
    const writes = new Set();
    for (const [phaseName, phaseDoc] of Object.entries(doc.phases)) {
        const phasePath = `phases.${phaseName}`;
        if (phaseDoc.settings)
            issues.push(...phaseSettingsIssues(phaseDoc.settings, `${phasePath}.settings`, globalDefaults));
        (phaseDoc.rules ?? []).forEach((/** @type {any} */ item, /** @type {number} */ ruleIndex) => {
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
            const conditionReads = new Set();
            collectConditionReads(conditions, conditionReads);
            for (const slot of conditionReads) reads.push({ slot, path: `${rulePath}.if` });
            item.do.forEach((/** @type {any} */ step, /** @type {number} */ stepIndex) => {
                const stepPath = `${rulePath}.do[${stepIndex}]`;
                if (step.type === 'goto' && !phaseNames.has(step.phase)) {
                    issues.push({ path: `${stepPath}.phase`, message: `No phase named "${step.phase}"` });
                }
                const memory = actionMemory(step);
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
 * @param {unknown} input
 * @param {Record<string, unknown>} globalDefaults - the stored global challenge defaults
 * @returns {{ok: true, scenario: any} | {ok: false, issues: ScenarioIssue[]}}
 */
const validateScenario = (input, globalDefaults) => {
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
    assignRuleIds(doc);
    return { ok: true, scenario: doc };
};

/**
 * Parses shared scenario JSON text, bounded before parsing.
 *
 * @param {unknown} text
 * @returns {{ok: true, value: unknown} | {ok: false, issues: ScenarioIssue[]}}
 */
const parseScenarioJson = (text) => {
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
            issues: [{ path: '', message: `Not valid JSON: ${/** @type {Error} */ (error).message}` }],
        };
    }
};

module.exports = { validateScenario, parseScenarioJson, formatPath, SETTING_PAIRS };
