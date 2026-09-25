// @ts-check
/**
 * The scenario vocabulary — every condition, entry selector, action and rule
 * mode a user-defined scenario may use, plus the document caps. The single
 * list the validator (settings/scenarioSchema.js), the engine, the CLI
 * reference (`scenario-vocabulary`) and the GUI builder read, so a new piece
 * is added in one place.
 *
 * Dependency-free on purpose (no zod, no settings): renderer-safe, like
 * settings/limits.js.
 */

const COMPARISON_OPS = ['<', '<=', '=', '!=', '>=', '>'];

const REPEAT_MODES = ['always', 'once', 'oncePerPhase', 'oncePerDay'];

/** Time conditions whose instants the engine can predict (scheduler wake-ups). */
const RANGE_TIME_CONDITIONS = ['beforeEnd', 'afterStart', 'inPhaseFor'];

/** Challenge-level numbers compared with `{op, value}`. */
const NUMERIC_CONDITIONS = ['entries', 'freeSlots', 'exposure', 'challengeRank', 'challengeVotes'];

const STATE_CONDITIONS = ['boostState', 'turboState'];

const CURRENCIES = ['keys', 'swaps', 'fills', 'coins'];

const NUMERIC_ENTRY_FIELDS = ['votes', 'rank', 'votesPerHour', 'speedRatio'];

/** Entry fields measured over a time window (the optional `window` duration). */
const SPEED_ENTRY_FIELDS = ['votesPerHour', 'speedRatio'];
const BOOLEAN_ENTRY_FIELDS = ['boosted', 'turbo', 'boosting'];

/** Selectors that pick an entry by comparing entries; `slot`, `memory` and `fastest` take an argument. */
const RANKING_SELECTORS = ['mostVotes', 'fewestVotes', 'bestRank', 'worstRank', 'boosted', 'turbo'];

/** Actions that spend currency or a one-per-challenge power — listed in the import preview. */
const SPENDING_ACTIONS = ['swap', 'unlockBoost', 'fillExposure', 'boost', 'turbo'];

/** Currency caps a scenario may set on itself (`limits`). */
const LIMIT_KEYS = ['swaps', 'keys', 'fills'];

const SCENARIO_CAPS = {
    scenarios: 50,
    phases: 20,
    rulesPerPhase: 30,
    conditionsPerList: 20,
    actionsPerRule: 10,
    conditionDepth: 4,
    nameLength: 60,
    descriptionLength: 500,
    importBytes: 256 * 1024,
};

/**
 * Human-readable reference, one line per piece: `[kind, type, fields]`.
 * Printed by the CLI; the builder will render the same list.
 */
const VOCABULARY_REFERENCE = [
    ['condition', 'dailyWindow', 'from: "HH:MM", to: "HH:MM" (app timezone; to < from wraps past midnight)'],
    ['condition', 'beforeEnd', 'min?, max?: duration — time left until the challenge closes'],
    ['condition', 'afterStart', 'min?, max?: duration — time since the challenge started'],
    ['condition', 'elapsedPercent', 'min?, max?: 0-100 — share of the challenge that has run'],
    ['condition', 'inPhaseFor', 'min?, max?: duration — time since this phase was entered'],
    ...NUMERIC_CONDITIONS.map((type) => ['condition', type, 'op, value: number']),
    ...STATE_CONDITIONS.map((type) => ['condition', type, 'in: ["STATE", …] e.g. AVAILABLE, AVAILABLE_KEY, WON']),
    ['condition', 'balance', `currency: ${CURRENCIES.join('|')}, op, value: number`],
    ['condition', 'memorySet', 'slot: name — true while the memory slot holds a photo'],
    [
        'condition',
        'entry',
        `select: selector, field: ${[...NUMERIC_ENTRY_FIELDS, ...BOOLEAN_ENTRY_FIELDS].join('|')}, op, value, window?: duration (speed fields, default 1h)`,
    ],
    ['condition', 'all', 'of: [condition, …] — every one holds'],
    ['condition', 'any', 'of: [condition, …] — at least one holds'],
    ['condition', 'not', 'condition: condition — it does not hold'],
    ['selector', 'slot', 'index: 1-4 (0 = last entry)'],
    ...RANKING_SELECTORS.map((by) => ['selector', by, 'skipProtected?: true — ignore boosted/turbo entries']),
    ['selector', 'memory', 'slot: name — the entry holding the remembered photo'],
    ['selector', 'fastest', 'window?: duration (default 1h), skipProtected? — most votes per hour'],
    ['action', 'enterPhoto', 'photo: "best" | {memory: name}, remember?: name — submits as a NEW entry'],
    [
        'action',
        'swap',
        'entry: selector, with: "best" | {memory: name}, rememberRemoved?, rememberAdded?: name — votes, boost and turbo stay with the photo',
    ],
    ['action', 'boost', 'entry: selector'],
    ['action', 'turbo', 'entry: selector'],
    ['action', 'unlockBoost', '— spends a key'],
    ['action', 'fillExposure', '— spends a fill'],
    ['action', 'vote', 'toExposure: 1-100'],
    ['action', 'remember', 'slot: name, entry: selector'],
    ['action', 'forget', 'slot: name'],
    ['action', 'goto', 'phase: name'],
    ['rule', 'repeat', `${REPEAT_MODES.join('|')} (default always = every pass the conditions hold)`],
    ['rule', 'op', COMPARISON_OPS.join(' ')],
    ['rule', 'duration', 'seconds or "5d", "90m", "1d 6h"'],
];

module.exports = {
    COMPARISON_OPS,
    REPEAT_MODES,
    RANGE_TIME_CONDITIONS,
    NUMERIC_CONDITIONS,
    STATE_CONDITIONS,
    CURRENCIES,
    NUMERIC_ENTRY_FIELDS,
    SPEED_ENTRY_FIELDS,
    BOOLEAN_ENTRY_FIELDS,
    RANKING_SELECTORS,
    SPENDING_ACTIONS,
    LIMIT_KEYS,
    SCENARIO_CAPS,
    VOCABULARY_REFERENCE,
};
