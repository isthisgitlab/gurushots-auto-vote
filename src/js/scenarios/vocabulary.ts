/**
 * The scenario vocabulary — every condition, entry selector, action and rule
 * mode a user-defined scenario may use, plus the document caps. The single
 * list the validator (settings/scenarioSchema.ts), the engine, the CLI
 * reference (`scenario-vocabulary`) and the GUI builder read, so a new piece
 * is added in one place.
 *
 * Dependency-free on purpose (no zod, no settings): renderer-safe, like
 * settings/limits.ts.
 */

const COMPARISON_OPS = ['<', '<=', '=', '!=', '>=', '>'] as const;

const REPEAT_MODES = ['always', 'once', 'oncePerPhase', 'oncePerDay'] as const;

/** Time conditions whose instants the engine can predict (scheduler wake-ups). */
const RANGE_TIME_CONDITIONS = ['beforeEnd', 'afterStart', 'inPhaseFor'] as const;

/** Challenge-level numbers compared with `{op, value}`. */
const NUMERIC_CONDITIONS = ['entries', 'freeSlots', 'exposure', 'challengeRank', 'challengeVotes'] as const;

const STATE_CONDITIONS = ['boostState', 'turboState'] as const;

const CURRENCIES = ['keys', 'swaps', 'fills', 'coins'] as const;

const NUMERIC_ENTRY_FIELDS = ['votes', 'rank', 'votesPerHour', 'speedRatio'] as const;

/** Entry fields measured over a time window (the optional `window` duration). */
const SPEED_ENTRY_FIELDS = ['votesPerHour', 'speedRatio'] as const;
const BOOLEAN_ENTRY_FIELDS = ['boosted', 'turbo', 'boosting'] as const;

/** Selectors that pick an entry by comparing entries; `slot`, `memory` and `fastest` take an argument. */
const RANKING_SELECTORS = ['mostVotes', 'fewestVotes', 'bestRank', 'worstRank', 'boosted', 'turbo'] as const;

/** Actions that spend currency or a one-per-challenge power — listed in the import preview. */
const SPENDING_ACTIONS = ['swap', 'unlockBoost', 'fillExposure', 'boost', 'turbo'] as const;

/** Currency caps a scenario may set on itself (`limits`). */
const LIMIT_KEYS = ['swaps', 'keys', 'fills'] as const;

const SCENARIO_CAPS = {
    scenarios: 50,
    phases: 20,
    rulesPerPhase: 30,
    conditionsPerList: 20,
    actionsPerRule: 10,
    conditionDepth: 4,
    nameLength: 60,
    noticeLength: 120,
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
    ['condition', 'boostState', 'in: ["STATE", …] — LOCKED, AVAILABLE, AVAILABLE_KEY, USED, UNAVAILABLE'],
    ['condition', 'turboState', 'in: ["STATE", …] — FREE, IN_PROGRESS, TIMER, WON, LOCKED, USED'],
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
    ['action', 'notify', 'message: text (max 120) — an OS notification on the desktop app and the CLI scheduler'],
    ['rule', 'repeat', `${REPEAT_MODES.join('|')} (default always = every pass the conditions hold)`],
    ['rule', 'op', COMPARISON_OPS.join(' ')],
    ['rule', 'duration', 'seconds or "5d", "90m", "1d 6h"'],
];

import type { ScenarioAction } from '../settings/scenarioSchema';
import type { ScenarioSelector } from '../types/scenario';

/**
 * The memory slots an action reads (an entry or photo it looks up by slot)
 * and writes (a photo it remembers).
 */
const actionMemory = (action: ScenarioAction): { reads: string[]; writes: string[] } => {
    const reads: string[] = [];
    const writes: string[] = [];
    const readEntry = (entry: ScenarioSelector) => {
        if (entry.by === 'memory') reads.push(entry.slot);
    };
    const readPhoto = (photo: 'best' | { memory: string }) => {
        if (photo !== 'best') reads.push(photo.memory);
    };
    switch (action.type) {
        case 'enterPhoto':
            readPhoto(action.photo);
            if (action.remember) writes.push(action.remember);
            break;
        case 'swap':
            readEntry(action.entry);
            readPhoto(action.with);
            if (action.rememberRemoved) writes.push(action.rememberRemoved);
            if (action.rememberAdded) writes.push(action.rememberAdded);
            break;
        case 'remember':
            readEntry(action.entry);
            writes.push(action.slot);
            break;
        case 'boost':
        case 'turbo':
            readEntry(action.entry);
            break;
        default:
            break;
    }
    return { reads, writes };
};

/**
 * Whether `value` is one of the vocabulary list's entries.
 */
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
    (list as readonly unknown[]).includes(value);

export {
    actionMemory,
    isOneOf,
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
