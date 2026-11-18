/**
 * The scenario fact registry: every named value an expression or a condition may read, with its kind, quantity,
 * optionality, the stages it is available in, whether it is raw evidence or derived from policy, the evidence it
 * depends on, and the one pure reader that decides it from a snapshot.
 *
 * A reader answers known, absent or unknown (valueState.ts). Missing or malformed evidence is unknown, never a default;
 * a value the evidence shows is not there (an unranked entry, a boost without a timer) is absent. The named conditions
 * read through these same readers, so one rule decides each value.
 *
 * Pure: no settings, services, logger or platform. The snapshot is the data the condition context already carries.
 */

import type { Bankroll, Challenge, RankingEntry } from '../types/gurushots';
import type { Duration, FactName, Quantity, ScenarioSelector, ScenarioStage } from '../types/scenario';
import { isOneOf } from './vocabulary';
import { selectEntry, entriesOf, rankOf, readableEntries, votesOf, windowOf } from './selectors';
import { speedRatio, votesPerHour } from './speed';
import { absent, known, unknownOf } from './valueState';

import type { VoteHistory } from './speed';
import type { ValueState } from './valueState';

/** What a fact reads from. */
export interface FactSnapshot {
    challenge: Challenge;
    state: { phaseEnteredAt: number; memory: Record<string, string>; history?: VoteHistory };
    /** unix seconds */
    now: number;
    /** IANA zone */
    timezone: string;
    bankroll?: Bankroll | null;
}

export type FactValue = number | boolean | string | string[];

type FactKind = 'number' | 'boolean' | 'string' | 'list';

type EntryFieldName = 'votes' | 'rank' | 'votesPerHour' | 'speedRatio' | 'boosted' | 'turbo' | 'boosting';

type FactReader = (snapshot: FactSnapshot, select?: ScenarioSelector, window?: Duration) => ValueState<FactValue>;

interface FactTraits {
    /** Whether the fact can be confirmed absent. */
    optional: boolean;
    stages: readonly ScenarioStage[];
    /** `policy` facts derive from effective settings, so a binding may not read them. */
    classification: 'raw' | 'policy';
    /** The evidence an unknown answer can name. */
    dependencies: readonly string[];
    /** Entry facts read the entry a selector picks. */
    takesSelect: boolean;
    /** The speed facts measure over a window. */
    takesWindow: boolean;
    read: FactReader;
}

/** A number carries its quantity; no other kind has one. */
export type FactDefinition = FactTraits &
    ({ kind: 'number'; quantity: Quantity } | { kind: Exclude<FactKind, 'number'>; quantity?: undefined });

/**
 * A number as the app reads one off a payload: a finite number, or null. Numeric strings count, as they always have.
 */
const finite = (value: unknown): number | null =>
    value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

const BOOST_STATES = ['LOCKED', 'MISSED', 'AVAILABLE', 'AVAILABLE_KEY', 'USED', 'UNAVAILABLE'] as const;

const clockUnreadable = () => unknownOf('clock-unreadable', ['clock']);

/**
 * A number fact: `compute` gets the readable clock.
 */
const withClock = (snapshot: FactSnapshot, compute: (now: number) => ValueState<number>): ValueState<number> => {
    const now = finite(snapshot.now);
    return now === null ? clockUnreadable() : compute(now);
};

const phaseStart = (snapshot: FactSnapshot): ValueState<number> => {
    const entered = finite(snapshot.state?.phaseEnteredAt);
    return entered === null ? unknownOf('phase-clock-unreadable', ['state.phaseEnteredAt']) : known(entered);
};

const startTime = (challenge: Challenge): ValueState<number> => {
    const start = finite(challenge?.start_time);
    return start === null ? unknownOf('start-time-unreadable', ['challenge.start_time']) : known(start);
};

const closeTime = (challenge: Challenge): ValueState<number> => {
    const close = finite(challenge?.close_time);
    return close === null ? unknownOf('close-time-unreadable', ['challenge.close_time']) : known(close);
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const ranking = (challenge: Challenge) => challenge?.member?.ranking;

/**
 * The boost's free timer, from its own state and timeout. Only AVAILABLE with a finite positive timeout has one; a
 * recognized state with no timer has none; a missing or unrecognized state, or a malformed timeout, cannot be told.
 * The challenge close never stands in for it.
 */
const boostTimer = (snapshot: FactSnapshot): ValueState<number> => {
    const boost = snapshot.challenge?.member?.boost;
    const state = boost?.state;
    if (typeof state !== 'string') return unknownOf('boost-state-unreadable', ['member.boost.state']);
    if (!isOneOf(BOOST_STATES, state)) return unknownOf('boost-state-unrecognized', ['member.boost.state']);
    if (state !== 'AVAILABLE') return absent('not-applicable');
    const timeout: unknown = boost?.timeout;
    if (timeout === undefined || timeout === null) return absent('not-applicable');
    if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
        return unknownOf('boost-timeout-malformed', ['member.boost.timeout']);
    }
    return timeout > 0 ? known(timeout) : absent('not-applicable');
};

const turboField = <T>(
    snapshot: FactSnapshot,
    read: (turbo: Record<string, unknown>) => ValueState<T>,
): ValueState<T> => {
    const turbo: unknown = snapshot.challenge?.member?.turbo;
    return isObject(turbo) ? read(turbo) : unknownOf('turbo-unreadable', ['member.turbo']);
};

const balanceOf =
    (currency: keyof Bankroll) =>
    (snapshot: FactSnapshot): ValueState<number> => {
        if (!snapshot.bankroll) return unknownOf('bankroll-unavailable', ['bankroll']);
        const amount = finite(snapshot.bankroll[currency]);
        return amount === null ? unknownOf('balance-malformed', ['bankroll']) : known(amount);
    };

/**
 * The entry a selector picks. Unknown when the entry list cannot be read, when no selector was given, or when `fastest`
 * has no history to rank by; absent when the selector proves there is no such entry.
 */
const selectedEntry = (snapshot: FactSnapshot, select?: ScenarioSelector): ValueState<RankingEntry> => {
    const entries = readableEntries(snapshot.challenge);
    if (entries === null) return unknownOf('entries-unreadable', ['member.ranking.entries']);
    if (!select) return unknownOf('selector-missing', []);
    const { memory, history } = snapshot.state;
    const entry = selectEntry(select, snapshot.challenge, { memory, history, now: snapshot.now });
    if (entry) return known(entry);
    return select.by === 'fastest' && entries.length > 0
        ? unknownOf('insufficient-history', ['vote-history'])
        : absent('not-present');
};

/**
 * One field of one entry: votes read as zero when the count is not a number (as the selectors do), an unranked entry has
 * no rank, a speed needs history, and a flag is true only when the entry says so.
 */
const readEntryField = (
    field: EntryFieldName,
    entry: RankingEntry,
    snapshot: FactSnapshot,
    window?: Duration,
): ValueState<number | boolean> => {
    if (field === 'votes') return known(votesOf(entry));
    if (field === 'rank') {
        const rank = rankOf(entry);
        return rank === null ? absent('not-present') : known(rank);
    }
    if (field === 'votesPerHour' || field === 'speedRatio') {
        const now = finite(snapshot.now);
        if (now === null) return clockUnreadable();
        const seconds = windowOf(window);
        const speed =
            field === 'votesPerHour'
                ? votesPerHour(snapshot.state?.history, entry, now, seconds)
                : speedRatio(snapshot.state?.history, entriesOf(snapshot.challenge), entry, now, seconds);
        return speed === null ? unknownOf('insufficient-history', ['vote-history']) : known(speed);
    }
    return known(entry[field] === true);
};

/**
 * One field of the entry a selector picks.
 */
const readEntryFact = (
    field: EntryFieldName,
    snapshot: FactSnapshot,
    select?: ScenarioSelector,
    window?: Duration,
): ValueState<number | boolean> => {
    const selected = selectedEntry(snapshot, select);
    return selected.state === 'known' ? readEntryField(field, selected.value, snapshot, window) : selected;
};

const entryFact =
    (field: EntryFieldName): FactReader =>
    (snapshot, select, window) =>
        readEntryFact(field, snapshot, select, window);

const ENTRY_DEPENDENCIES = ['member.ranking.entries', 'vote-history'] as const;
const ALL_STAGES = ['account', 'preJoin', 'active', 'postClose'] as const;
const CHALLENGE_STAGES = ['preJoin', 'active', 'postClose'] as const;
const ACTIVE = ['active'] as const;

interface FactOptions {
    optional?: boolean;
    stages?: readonly ScenarioStage[];
    dependencies: readonly string[];
    takesSelect?: boolean;
    takesWindow?: boolean;
}

const traits = (read: FactReader, options: FactOptions): FactTraits => ({
    optional: options.optional ?? false,
    stages: options.stages ?? ACTIVE,
    classification: 'raw',
    dependencies: options.dependencies,
    takesSelect: options.takesSelect ?? false,
    takesWindow: options.takesWindow ?? false,
    read,
});

const fact = (kind: Exclude<FactKind, 'number'>, read: FactReader, options: FactOptions): FactDefinition => ({
    kind,
    ...traits(read, options),
});

const numberFact = (quantity: Quantity, read: FactReader, options: FactOptions): FactDefinition => ({
    kind: 'number',
    quantity,
    ...traits(read, options),
});

const FACTS: Record<FactName, FactDefinition> = {
    'clock.now': numberFact('instant', ({ now }) => (finite(now) === null ? clockUnreadable() : known(Number(now))), {
        stages: ALL_STAGES,
        dependencies: ['clock'],
    }),
    'phase.enteredAt': numberFact('instant', phaseStart, {
        dependencies: ['state.phaseEnteredAt'],
    }),
    'phase.elapsed': numberFact(
        'duration',
        (snapshot) => {
            const entered = phaseStart(snapshot);
            return entered.state === 'known' ? withClock(snapshot, (now) => known(now - entered.value)) : entered;
        },
        { dependencies: ['clock', 'state.phaseEnteredAt'] },
    ),

    'challenge.id': fact(
        'string',
        ({ challenge }) =>
            typeof challenge?.id === 'string' || typeof challenge?.id === 'number'
                ? known(String(challenge.id))
                : unknownOf('id-unreadable', ['challenge.id']),
        { stages: CHALLENGE_STAGES, dependencies: ['challenge.id'] },
    ),
    'challenge.title': fact(
        'string',
        ({ challenge }) =>
            typeof challenge?.title === 'string'
                ? known(challenge.title)
                : unknownOf('title-unreadable', ['challenge.title']),
        { stages: CHALLENGE_STAGES, dependencies: ['challenge.title'] },
    ),
    'challenge.type': fact(
        'string',
        ({ challenge }) => {
            const type: unknown = challenge?.type;
            if (type === undefined || type === null || type === '') return absent('not-present');
            return typeof type === 'string' ? known(type) : unknownOf('type-unreadable', ['challenge.type']);
        },
        { optional: true, stages: CHALLENGE_STAGES, dependencies: ['challenge.type'] },
    ),
    'challenge.tags': fact(
        'list',
        ({ challenge }) => {
            const tags: unknown = challenge?.tags;
            if (tags === undefined || tags === null) return absent('not-present');
            return Array.isArray(tags) && tags.every((tag): tag is string => typeof tag === 'string')
                ? known([...tags])
                : unknownOf('tags-unreadable', ['challenge.tags']);
        },
        { optional: true, stages: CHALLENGE_STAGES, dependencies: ['challenge.tags'] },
    ),
    'challenge.start': numberFact('instant', ({ challenge }) => startTime(challenge), {
        stages: CHALLENGE_STAGES,
        dependencies: ['challenge.start_time'],
    }),
    'challenge.end': numberFact('instant', ({ challenge }) => closeTime(challenge), {
        stages: CHALLENGE_STAGES,
        dependencies: ['challenge.close_time'],
    }),
    'challenge.timeLeft': numberFact(
        'duration',
        (snapshot) => {
            const close = closeTime(snapshot.challenge);
            if (close.state !== 'known') return close;
            return withClock(snapshot, (now) =>
                now >= close.value ? unknownOf('challenge-closed', ['challenge.close_time']) : known(close.value - now),
            );
        },
        { dependencies: ['clock', 'challenge.close_time'] },
    ),
    'challenge.elapsed': numberFact(
        'duration',
        (snapshot) => {
            const start = startTime(snapshot.challenge);
            if (start.state !== 'known') return start;
            return withClock(snapshot, (now) =>
                now < start.value
                    ? unknownOf('challenge-not-started', ['challenge.start_time'])
                    : known(now - start.value),
            );
        },
        { dependencies: ['clock', 'challenge.start_time'] },
    ),
    'challenge.elapsedPercent': numberFact(
        'percent',
        (snapshot) => {
            const start = finite(snapshot.challenge?.start_time);
            const close = finite(snapshot.challenge?.close_time);
            if (start === null || close === null || close <= start) {
                return unknownOf('span-unreadable', ['challenge.start_time', 'challenge.close_time']);
            }
            return withClock(snapshot, (now) =>
                now < start
                    ? unknownOf('challenge-not-started', ['challenge.start_time'])
                    : known(((now - start) / (close - start)) * 100),
            );
        },
        { dependencies: ['clock', 'challenge.start_time', 'challenge.close_time'] },
    ),

    'challenge.entries': numberFact('count', ({ challenge }) => known(entriesOf(challenge).length), {
        dependencies: ['member.ranking.entries'],
    }),
    'challenge.freeSlots': numberFact(
        'count',
        ({ challenge }) => {
            const max = finite(challenge?.max_photo_submits);
            return max === null
                ? unknownOf('max-photo-submits-unreadable', ['challenge.max_photo_submits'])
                : known(Math.max(0, max - entriesOf(challenge).length));
        },
        { dependencies: ['challenge.max_photo_submits', 'member.ranking.entries'] },
    ),
    'challenge.exposure': numberFact(
        'percent',
        ({ challenge }) => {
            const exposure = finite(ranking(challenge)?.exposure?.exposure_factor);
            return exposure === null ? unknownOf('exposure-unreadable', ['member.ranking.exposure']) : known(exposure);
        },
        { dependencies: ['member.ranking.exposure'] },
    ),
    'challenge.rank': numberFact(
        'count',
        ({ challenge }) => {
            const rank = finite(ranking(challenge)?.total?.rank);
            if (rank === null) return unknownOf('rank-unreadable', ['member.ranking.total']);
            return rank > 0 ? known(rank) : absent('not-present');
        },
        { optional: true, dependencies: ['member.ranking.total'] },
    ),
    'challenge.votes': numberFact(
        'votes',
        ({ challenge }) => {
            const votes = finite(ranking(challenge)?.total?.votes);
            return votes === null ? unknownOf('votes-unreadable', ['member.ranking.total']) : known(votes);
        },
        { dependencies: ['member.ranking.total'] },
    ),

    'boost.state': fact(
        'string',
        ({ challenge }) => {
            const state: unknown = challenge?.member?.boost?.state;
            return typeof state === 'string'
                ? known(state)
                : unknownOf('boost-state-unreadable', ['member.boost.state']);
        },
        { dependencies: ['member.boost.state'] },
    ),
    'boost.freeExpiry': numberFact('instant', boostTimer, {
        optional: true,
        dependencies: ['member.boost.state', 'member.boost.timeout'],
    }),
    'boost.freeRemaining': numberFact(
        'duration',
        (snapshot) => {
            const expiry = boostTimer(snapshot);
            return expiry.state === 'known' ? withClock(snapshot, (now) => known(expiry.value - now)) : expiry;
        },
        {
            optional: true,
            dependencies: ['clock', 'member.boost.state', 'member.boost.timeout'],
        },
    ),

    'turbo.state': fact(
        'string',
        (snapshot) =>
            turboField(snapshot, ({ state }) =>
                typeof state === 'string' ? known(state) : unknownOf('turbo-state-unreadable', ['member.turbo.state']),
            ),
        { dependencies: ['member.turbo', 'member.turbo.state'] },
    ),
    'turbo.mode': fact(
        'string',
        (snapshot) =>
            turboField(snapshot, ({ mode }) => {
                if (mode === undefined || mode === null) return absent('not-present');
                return typeof mode === 'string'
                    ? known(mode)
                    : unknownOf('turbo-mode-malformed', ['member.turbo.mode']);
            }),
        { optional: true, dependencies: ['member.turbo', 'member.turbo.mode'] },
    ),
    'turbo.opensAt': numberFact(
        'instant',
        (snapshot) =>
            turboField(snapshot, ({ time_to_open: opens }) => {
                if (opens === undefined || opens === null) return absent('not-applicable');
                if (typeof opens !== 'number' || !Number.isFinite(opens)) {
                    return unknownOf('turbo-time-malformed', ['member.turbo.time_to_open']);
                }
                return opens > 0 ? known(opens) : absent('not-applicable');
            }),
        {
            optional: true,
            dependencies: ['member.turbo', 'member.turbo.time_to_open'],
        },
    ),

    'balance.keys': numberFact('keys', balanceOf('keys'), {
        stages: ALL_STAGES,
        dependencies: ['bankroll'],
    }),
    'balance.swaps': numberFact('swaps', balanceOf('swaps'), {
        stages: ALL_STAGES,
        dependencies: ['bankroll'],
    }),
    'balance.fills': numberFact('fills', balanceOf('fills'), {
        stages: ALL_STAGES,
        dependencies: ['bankroll'],
    }),
    'balance.coins': numberFact('coins', balanceOf('coins'), {
        stages: ALL_STAGES,
        dependencies: ['bankroll'],
    }),

    'entry.votes': numberFact('votes', entryFact('votes'), {
        optional: true,
        dependencies: ENTRY_DEPENDENCIES,
        takesSelect: true,
    }),
    'entry.rank': numberFact('count', entryFact('rank'), {
        optional: true,
        dependencies: ENTRY_DEPENDENCIES,
        takesSelect: true,
    }),
    'entry.votesPerHour': numberFact('votesPerHour', entryFact('votesPerHour'), {
        optional: true,
        dependencies: [...ENTRY_DEPENDENCIES, 'clock'],
        takesSelect: true,
        takesWindow: true,
    }),
    'entry.speedRatio': numberFact('ratio', entryFact('speedRatio'), {
        optional: true,
        dependencies: [...ENTRY_DEPENDENCIES, 'clock'],
        takesSelect: true,
        takesWindow: true,
    }),
    'entry.boosted': fact('boolean', entryFact('boosted'), {
        optional: true,
        dependencies: ENTRY_DEPENDENCIES,
        takesSelect: true,
    }),
    'entry.turbo': fact('boolean', entryFact('turbo'), {
        optional: true,
        dependencies: ENTRY_DEPENDENCIES,
        takesSelect: true,
    }),
    'entry.boosting': fact('boolean', entryFact('boosting'), {
        optional: true,
        dependencies: ENTRY_DEPENDENCIES,
        takesSelect: true,
    }),
};

/**
 * Reads one fact from a snapshot. Entry facts read the entry `select` picks; the speed facts measure over `window`.
 */
const readScenarioFact = (
    name: FactName,
    snapshot: FactSnapshot,
    select?: ScenarioSelector,
    window?: Duration,
): ValueState<FactValue> => FACTS[name].read(snapshot, select, window);

/**
 * A number fact's value as a number.
 */
const readNumericFact = (
    name: FactName,
    snapshot: FactSnapshot,
    select?: ScenarioSelector,
    window?: Duration,
): ValueState<number> => {
    const result = readScenarioFact(name, snapshot, select, window);
    return result.state === 'known' ? known(Number(result.value)) : result;
};

const STAGE_PHRASE: Record<ScenarioStage, string> = {
    account: 'outside a challenge',
    preJoin: 'before a challenge is joined',
    active: 'while a challenge is active',
    postClose: 'after a challenge closes',
};

/**
 * Why a fact cannot be read in a stage, as an issue at `path`: none when it can.
 */
const factStageIssues = (
    name: FactName,
    stage: ScenarioStage,
    path: string,
    facts: Readonly<Record<FactName, Pick<FactDefinition, 'stages'>>> = FACTS,
): Array<{ path: string; message: string }> =>
    facts[name].stages.includes(stage) ? [] : [{ path, message: `${name} is not available ${STAGE_PHRASE[stage]}` }];

export { FACTS, readScenarioFact, readNumericFact, readEntryField, readEntryFact, factStageIssues, finite };
export type { EntryFieldName };
