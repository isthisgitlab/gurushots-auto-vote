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

import { CHOSEN_PHOTO_ID_RE } from '../settings/limits';

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

/** `present` / `absent` test one expression for a known value or a confirmed absence. */
const PRESENCE_CONDITIONS = ['present', 'absent'] as const;

/** The list conditions: `list` holds `value` (one string), any of it, or all of it. */
const LIST_CONDITIONS = ['contains', 'containsAny', 'containsAll'] as const;

/** What an expression's number measures. Instants are Unix seconds; a duration is held in seconds. */
const QUANTITIES = [
    'instant',
    'duration',
    'percent',
    'ratio',
    'count',
    'votes',
    'votesPerHour',
    'keys',
    'swaps',
    'fills',
    'coins',
] as const;

/** The units a duration literal is written in; every one normalizes to seconds. */
const DURATION_UNITS = ['seconds', 'minutes', 'hours', 'days'] as const;

/** Where a setting reference reads: the value below the phase overlay, or the value with it. */
const SETTING_VIEWS = ['base', 'effective'] as const;

/** The stages of a challenge's life a fact may be read in. */
const SCENARIO_STAGES = ['account', 'preJoin', 'active', 'postClose'] as const;

/** Every fact an expression may read (the registry in scenarios/facts.ts defines each one). */
const FACT_NAMES = [
    'clock.now',
    'phase.enteredAt',
    'phase.elapsed',
    'challenge.id',
    'challenge.title',
    'challenge.type',
    'challenge.tags',
    'challenge.start',
    'challenge.end',
    'challenge.timeLeft',
    'challenge.elapsed',
    'challenge.elapsedPercent',
    'challenge.entries',
    'challenge.freeSlots',
    'challenge.exposure',
    'challenge.rank',
    'challenge.votes',
    'challenge.players',
    'challenge.maxPlayers',
    'challenge.maxPhotoSubmits',
    'challenge.joinPrice',
    'challenge.membership',
    'boost.state',
    'boost.freeExpiry',
    'boost.freeRemaining',
    'boost.open',
    'boost.keyUnlocked',
    'turbo.state',
    'turbo.mode',
    'turbo.opensAt',
    'balance.keys',
    'balance.swaps',
    'balance.fills',
    'balance.coins',
    'missions.joinNeed',
    'missions.fillNeed',
    'missions.turboNeed',
    'missions.boostNeed',
    'missions.voteNeed',
    'missions.nextExpiry',
    'rewards.claimable',
    'rewards.claimableCount',
    'remote.enabled',
    'remote.connected',
    'photos.eligibleCount',
    'photos.eligibleAtLeast',
    'photos.hasEligible',
    'entry.votes',
    'entry.rank',
    'entry.votesPerHour',
    'entry.speedRatio',
    'entry.boosted',
    'entry.turbo',
    'entry.boosting',
    'entry.age',
    'entry.minAge',
    'entry.ageExact',
    'entry.uncertainSubmission',
    'entry.pinned',
] as const;

/** Selectors that pick an entry by comparing entries; `slot`, `memory` and `fastest` take an argument. */
const RANKING_SELECTORS = ['mostVotes', 'fewestVotes', 'bestRank', 'worstRank', 'boosted', 'turbo'] as const;

/** The powers an entry can be pinned for (`pinned` selector). */
const PINNED_POWERS = ['boost', 'turbo'] as const;

/** Which entry times `newest` / `oldest` compare: exact ones only, or the observed ones too (a first-seen time is a bound). */
const ENTRY_TIME_MODES = ['exact', 'observed'] as const;

/** What a `matching` selector orders the entries that match by. */
const MATCH_ORDERS = ['votes', 'rank', 'age'] as const;

const ORDER_DIRECTIONS = ['asc', 'desc'] as const;

/** The normal operations `runAutomation` runs once: each under its normal enable, timing and selection policy. */
const AUTOMATION_OPERATIONS = [
    'submit',
    'boost',
    'turbo',
    'unlockBoost',
    'swap',
    'fillExposure',
    'vote',
    'join',
] as const;

/** Actions that spend currency or a one-per-challenge power — listed in the import preview. */
const SPENDING_ACTIONS = [
    'swap',
    'unlockBoost',
    'fillExposure',
    'boost',
    'turbo',
    'join',
    'earnTurbo',
    'runAutomation',
] as const;

/**
 * The actions each stage of a subject's life offers. A rule declares the stages it runs in; every action it holds must be
 * available in every one of them. `active` keeps every action a rule had before stages existed.
 */
const STAGE_ACTIONS = {
    account: [
        'notify',
        'goto',
        'claimMissionReward',
        'setSetting',
        'clearSetting',
        'startAutovote',
        'stopAutovote',
        'pauseScenario',
        'handoffScenario',
    ],
    preJoin: [
        'notify',
        'goto',
        'join',
        'runAutomation',
        'setSetting',
        'clearSetting',
        'useProfile',
        'pauseScenario',
        'handoffScenario',
    ],
    active: [
        'enterPhoto',
        'swap',
        'boost',
        'turbo',
        'unlockBoost',
        'fillExposure',
        'vote',
        'remember',
        'forget',
        'goto',
        'notify',
        'earnTurbo',
        'runAutomation',
        'setSetting',
        'clearSetting',
        'useProfile',
        'setPin',
        'clearPin',
        'pauseScenario',
        'handoffScenario',
    ],
    postClose: ['notify', 'goto', 'claimChallengeReward', 'pauseScenario', 'handoffScenario'],
} as const;

/** The stages each condition that reads a challenge is available in; every other condition is available in all of them. */
const CONDITION_STAGES = {
    beforeEnd: ['preJoin', 'active'],
    afterStart: ['preJoin', 'active'],
    elapsedPercent: ['preJoin', 'active'],
    entries: ['preJoin', 'active'],
    freeSlots: ['preJoin', 'active'],
    exposure: ['preJoin', 'active'],
    challengeRank: ['preJoin', 'active'],
    challengeVotes: ['preJoin', 'active'],
    boostState: ['active'],
    turboState: ['active'],
    entry: ['active'],
    entryCount: ['active'],
    entriesWhere: ['active'],
} as const;

/** The stages a rule runs in when it declares none: a challenge scenario's rules are active-only, an installation's are account rules. */
const DEFAULT_STAGES = { challenge: ['active'], installation: ['account'] } as const;

/** The stages a document of each scope may declare. */
const SCOPE_STAGES = {
    challenge: ['preJoin', 'active', 'postClose'],
    installation: ['account'],
} as const;

/** Currency caps a scenario may set on itself (`limits`). */
const LIMIT_KEYS = ['swaps', 'keys', 'fills'] as const;

/** The requests a simulation can be told the outcome of (types/scenario.ts SimulationOperation). */
const SIMULATION_OPERATIONS = ['submit', 'join', 'claim', 'boost', 'turbo', 'swap', 'fill', 'keyUnlock'] as const;

/** The outcomes an assumption may give one: through, refused by the server, or no answer. */
const SIMULATION_OUTCOMES = ['success', 'refused', 'unclear'] as const;

/** The kinds of subject a simulation runs on. */
const SIMULATION_SUBJECT_KINDS = ['installation', 'candidate', 'active', 'completed'] as const;

const SCENARIO_CAPS = {
    scenarios: 50,
    phases: 20,
    rulesPerPhase: 30,
    conditionsPerList: 20,
    actionsPerRule: 10,
    conditionDepth: 4,
    expressionDepth: 8,
    aggregateOperands: 8,
    entryPredicates: 8,
    nameLength: 60,
    noticeLength: 120,
    descriptionLength: 500,
    importBytes: 256 * 1024,
    /** Named photo pools an account holds (config `photoPools`). */
    photoPools: 20,
    /** Photo ids one pool holds. */
    poolPhotos: 100,
    /** Photo ids one phase's `poolProgress` keeps as consumed; the record never forgets one, so a pool cannot replay. */
    poolConsumed: 500,
};

/** Whether a value is a photo id a pin or a pool may name (the shape a Chosen Photos list holds). */
const isPhotoId = (value: unknown): value is string => typeof value === 'string' && CHOSEN_PHOTO_ID_RE.test(value);

/** Whether a value is a photo pool's name: plain text, trimmed, 1 to `nameLength` characters, no name an object already has. */
const isPoolName = (value: unknown): value is string =>
    typeof value === 'string' &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= SCENARIO_CAPS.nameLength &&
    /^\P{Cc}+$/u.test(value) &&
    !(value in Object.prototype);

/** Whether a value is what a pool holds: 1 to `poolPhotos` distinct photo ids, in order. */
const isPoolIds = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= SCENARIO_CAPS.poolPhotos &&
    value.every(isPhotoId) &&
    new Set(value).size === value.length;

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
    ['condition', 'boostState', 'in: ["STATE", …] — LOCKED, MISSED, AVAILABLE, AVAILABLE_KEY, USED, UNAVAILABLE'],
    ['condition', 'turboState', 'in: ["STATE", …] — FREE, IN_PROGRESS, TIMER, WON, LOCKED, USED'],
    ['condition', 'balance', `currency: ${CURRENCIES.join('|')}, op, value: number`],
    ['condition', 'memorySet', 'slot: name — true while the memory slot holds a photo'],
    [
        'condition',
        'entry',
        `select: selector, field: ${[...NUMERIC_ENTRY_FIELDS, ...BOOLEAN_ENTRY_FIELDS].join('|')}, op, value, window?: duration (speed fields, default 1h)`,
    ],
    [
        'condition',
        'compare',
        'left: expression, op, right: expression — numbers of one quantity, or equal kinds with = / !=; unknown when a side is absent or unreadable',
    ],
    ['condition', 'present', 'value: expression — has a known value (false when confirmed absent)'],
    ['condition', 'absent', 'value: expression — is confirmed absent (false when it has a value)'],
    ['condition', 'contains', 'list: expression, value: expression — the list holds this string'],
    ['condition', 'containsAny', 'list: expression, value: expression — the list holds any of these strings'],
    ['condition', 'containsAll', 'list: expression, value: expression — the list holds all of these strings'],
    [
        'condition',
        'entriesWhere',
        `quantifier: any|all, where: [{field: ${[...NUMERIC_ENTRY_FIELDS, ...BOOLEAN_ENTRY_FIELDS].join('|')}, op, value}, …] (1-${SCENARIO_CAPS.entryPredicates}) — any / every entry matches every predicate; unknown when the entries cannot be read`,
    ],
    [
        'condition',
        'entryCount',
        `where: [{field: ${[...NUMERIC_ENTRY_FIELDS, ...BOOLEAN_ENTRY_FIELDS].join('|')}, op, value}, …] (1-${SCENARIO_CAPS.entryPredicates}), op, value: number — how many entries match every predicate`,
    ],
    ['condition', 'all', 'of: [condition, …] — every one holds'],
    ['condition', 'any', 'of: [condition, …] — at least one holds'],
    ['condition', 'not', 'condition: condition — it does not hold'],
    [
        'expression',
        'literal',
        `value: number + quantity (${QUANTITIES.join('|')}) [+ unit ${DURATION_UNITS.join('|')} for a duration] | boolean | text | [text, …]`,
    ],
    [
        'expression',
        'fact',
        `name: ${FACT_NAMES.join('|')}; select: selector (entry.* facts only); window?: duration (entry.votesPerHour, entry.speedRatio)`,
    ],
    ['expression', 'setting', `key: setting name, view: ${SETTING_VIEWS.join('|')}`],
    ['expression', 'offset', 'from: instant, by: duration, direction: before|after — an instant'],
    ['expression', 'difference', 'from: instant, to: instant — to minus from, a duration'],
    ['expression', 'add', 'left, right: one quantity, or an instant plus a duration'],
    [
        'expression',
        'subtract',
        'left, right: one quantity, or an instant minus a duration (use difference for two instants)',
    ],
    ['expression', 'earlier', `of: [instant, …] (2-${SCENARIO_CAPS.aggregateOperands}) — absent ones are left out`],
    ['expression', 'later', `of: [instant, …] (2-${SCENARIO_CAPS.aggregateOperands}) — absent ones are left out`],
    [
        'expression',
        'min',
        `of: [number, …] (2-${SCENARIO_CAPS.aggregateOperands}), one quantity — absent ones are left out`,
    ],
    [
        'expression',
        'max',
        `of: [number, …] (2-${SCENARIO_CAPS.aggregateOperands}), one quantity — absent ones are left out`,
    ],
    ['selector', 'slot', 'index: 1-4 (0 = last entry)'],
    ...RANKING_SELECTORS.map((by) => [
        'selector',
        by,
        'skipProtected?: true — ignore boosted/turbo entries; a swap never takes a guru-picked one',
    ]),
    ['selector', 'memory', 'slot: name — the entry holding the remembered photo'],
    ['selector', 'fastest', 'window?: duration (default 1h), skipProtected? — most votes per hour'],
    [
        'selector',
        'slowest',
        'window?: duration (default 1h), skipProtected? — fewest votes per hour; unknown while any entry has no speed yet',
    ],
    ['selector', 'id', 'id: text — the entry with this id'],
    ['selector', 'pinned', `power: ${PINNED_POWERS.join('|')} — the entry that power is pinned to`],
    ['selector', 'pendingBoostTarget', '— the photo an earlier fill-new submitted that the Boost is still waiting on'],
    [
        'selector',
        'newest',
        `time: ${ENTRY_TIME_MODES.join('|')} — the entry that went in last (ties: the lowest id); unknown while an entry that could be newer has no usable time`,
    ],
    [
        'selector',
        'oldest',
        `time: ${ENTRY_TIME_MODES.join('|')} — the entry that went in first (ties: the lowest id); unknown while an entry that could be older has no usable time`,
    ],
    [
        'selector',
        'matching',
        `where: [{field, op, value}, …] (1-${SCENARIO_CAPS.entryPredicates}), order: ${MATCH_ORDERS.join('|')}, direction: ${ORDER_DIRECTIONS.join('|')} — the first entry that meets every predicate (ties: the lowest id)`,
    ],
    ['action', 'enterPhoto', 'photo: "best" | {memory: name}, remember?: name — submits as a NEW entry'],
    [
        'action',
        'swap',
        'entry: selector, with: "best" | {memory: name}, rememberRemoved?, rememberAdded?: name — votes, boost, turbo and a Guru\'s pick stay with the photo',
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
    [
        'action',
        'join',
        'maxCoins?: coins expression — before joining only: joins this challenge now, whatever the Auto Join switch and timing say; the price limit can only be narrowed, never widened',
    ],
    [
        'action',
        'claimChallengeReward',
        '— after the challenge closed only: claims its rewards when they wait to be claimed',
    ],
    ['action', 'claimMissionReward', 'missionId: text — installation only: claims that mission when it can be claimed'],
    ['action', 'earnTurbo', '— plays the Turbo mini-game once, under its mode, cooldown, model and cancellation rules'],
    [
        'action',
        'runAutomation',
        `operation: ${AUTOMATION_OPERATIONS.join('|')} (join before joining only, the rest while active) — runs that normal automation once, under its normal enable, timing and selection policy; when the policy says not now, the step completes and says so`,
    ],
    [
        'action',
        'setSetting',
        'key: setting name, value: a literal or an expression — changes the setting for this scenario phase only (a challenge scenario: a per-challenge setting; an installation scenario: an installation setting); the saved settings are never written',
    ],
    ['action', 'clearSetting', 'key: setting name — undoes a setSetting of this phase'],
    [
        'action',
        'setPin',
        `power: ${PINNED_POWERS.join('|')}, entry: selector — pins that power to the entry for this phase only; the saved pins are never written (no entry yet: waits)`,
    ],
    [
        'action',
        'clearPin',
        `power: ${PINNED_POWERS.join('|')} — no pin for that power for this phase, whatever the phase or the saved pin say`,
    ],
    [
        'action',
        'useProfile',
        "name: saved profile name | null — uses that profile for this phase instead of the phase's own (null: none); a challenge scenario only",
    ],
    [
        'action',
        'startAutovote',
        'asks the autovote controller to turn the voting stages on under the armed chain (installation scenarios only); never starts a chain and never lifts a Stop by the user',
    ],
    [
        'action',
        'stopAutovote',
        'asks the autovote controller to turn the voting stages off; the chain stays armed for this scenario (installation scenarios only); not a full Stop',
    ],
    [
        'action',
        'pauseScenario',
        'reason?: text — pauses this scenario with its progress kept; only the user resumes it',
    ],
    [
        'action',
        'handoffScenario',
        'to: scenario name | null — gives this subject to another scenario (null: none) at a safe point; the last action of its rule',
    ],
    [
        'rule',
        'stages',
        'a challenge scenario: any of preJoin, active, postClose (default active); an installation scenario: account (default); every action must be available in each stage',
    ],
    [
        'scenario',
        'limits',
        'swaps?, keys?, fills?, coins?: a cap on what the scenario spends in all (coins: what its joins spend)',
    ],
    [
        'phase',
        'pins',
        `boost?, turbo?: photo id | null — while the challenge is in this phase, the photo that power is pinned to (null: no pin); the saved pins are never written`,
    ],
    [
        'phase',
        'photoPool',
        "name: pool name, only?: boolean, inOrder?: boolean — the photos this phase draws from: a named pool saved on this account (never part of an export); each photo is used once per phase; replaces the phase's chosenPhotos settings",
    ],
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
    isPhotoId,
    isPoolName,
    isPoolIds,
    COMPARISON_OPS,
    REPEAT_MODES,
    RANGE_TIME_CONDITIONS,
    NUMERIC_CONDITIONS,
    STATE_CONDITIONS,
    CURRENCIES,
    NUMERIC_ENTRY_FIELDS,
    SPEED_ENTRY_FIELDS,
    BOOLEAN_ENTRY_FIELDS,
    PRESENCE_CONDITIONS,
    LIST_CONDITIONS,
    QUANTITIES,
    DURATION_UNITS,
    SETTING_VIEWS,
    SCENARIO_STAGES,
    FACT_NAMES,
    RANKING_SELECTORS,
    PINNED_POWERS,
    ENTRY_TIME_MODES,
    MATCH_ORDERS,
    ORDER_DIRECTIONS,
    AUTOMATION_OPERATIONS,
    SPENDING_ACTIONS,
    STAGE_ACTIONS,
    CONDITION_STAGES,
    DEFAULT_STAGES,
    SCOPE_STAGES,
    LIMIT_KEYS,
    SCENARIO_CAPS,
    SIMULATION_OPERATIONS,
    SIMULATION_OUTCOMES,
    SIMULATION_SUBJECT_KINDS,
    VOCABULARY_REFERENCE,
};
