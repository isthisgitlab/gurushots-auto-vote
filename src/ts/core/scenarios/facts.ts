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
import { isBoostWindowOpen, isKeyUnlockedBoost } from '../voting/boostWindow';
import { isOneOf } from './vocabulary';
import { selectEntry, entriesOf, rankOf, readableEntries, votesOf, windowOf } from './selectors';
import { speedRatio, votesPerHour } from './speed';
import { absent, known, unknownOf } from './valueState';

import type { VoteHistory } from './speed';
import type { ValueState } from './valueState';

/**
 * Evidence a loader fetched for a snapshot: what it read, or why it could not read it. A field a loader did not fetch is
 * absent from the snapshot ("not loaded"), which is not the same as unreadable.
 */
export type Evidence<T> = ({ readable: true } & T) | { readable: false; reason: string };

/** What the missions need of the app, from one read of the mission list (every kind, whatever the mission settings). */
export interface MissionEvidence {
    needs: Record<'join' | 'fill' | 'turbo' | 'boost' | 'vote', number>;
    /** The kinds with a recognized mission whose progress could not be read: their need cannot be told. */
    unreadable: readonly string[];
    /** The earliest expiry (unix seconds) of an unfinished mission, null when none has one. */
    nextExpiry: number | null;
    /** A mission carries an expiry that is not a number. */
    expiryUnreadable: boolean;
}

/** The completed challenges one read of the list showed, by id. */
export interface RewardEvidence {
    /** Ids whose rewards wait to be claimed. */
    claimable: readonly string[];
    /** Every id the read listed. */
    listed: readonly string[];
    /** The listing reached its end (a short page); false when it stopped at the page cap. */
    complete: boolean;
}

/** When each entry of the subject challenge went in (the entry-age ledger): the time, and whether the app made it exact. */
export interface EntryAgeEvidence {
    times: Readonly<Record<string, { at: number; exact: boolean }>>;
}

/** The ids of the subject challenge's entries the app marked as a doubtful subject match. */
export interface UncertainEvidence {
    ids: readonly string[];
}

/** The photos the subject challenge's Boost and Turbo are pinned to. */
export interface PinEvidence {
    boost: string | null;
    turbo: string | null;
}

/** One read-only scan of the photos a submission would consider (the same rules as submitting). */
export interface PhotoScanEvidence {
    eligible: number;
    /** False when the scan stopped early (a read failed, a cap or time limit, no vision model): `eligible` is a lower bound. */
    complete: boolean;
    firstReason?: string;
}

/** What a fact reads from. */
export interface FactSnapshot {
    challenge: Challenge;
    state: { phaseEnteredAt: number; memory: Record<string, string>; history?: VoteHistory };
    /** unix seconds */
    now: number;
    /** IANA zone */
    timezone: string;
    bankroll?: Bankroll | null;
    missions?: Evidence<MissionEvidence>;
    rewards?: Evidence<RewardEvidence>;
    entryAges?: Evidence<EntryAgeEvidence>;
    uncertain?: Evidence<UncertainEvidence>;
    pins?: Evidence<PinEvidence>;
    photoScan?: Evidence<PhotoScanEvidence>;
}

/** The evidence fields a loader may add to a snapshot (every one optional: absent means not loaded). */
export type FactEvidence = Pick<
    FactSnapshot,
    'bankroll' | 'missions' | 'rewards' | 'entryAges' | 'uncertain' | 'pins' | 'photoScan'
>;

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

/**
 * Loaded evidence, or why it is not usable: not fetched for this snapshot, unreadable, or not of the shape a loader
 * produces. Evidence is never read as a default.
 */
const loaded = <T>(
    evidence: Evidence<T> | undefined,
    dependency: string,
): ValueState<Extract<Evidence<T>, { readable: true }>> => {
    if (evidence === undefined) return unknownOf('evidence-not-loaded', [dependency]);
    if (!isObject(evidence)) return unknownOf('evidence-malformed', [dependency]);
    if (evidence.readable === true) return known(evidence);
    return evidence.readable === false && typeof evidence.reason === 'string'
        ? unknownOf(evidence.reason, [dependency])
        : unknownOf('evidence-malformed', [dependency]);
};

/** A count the evidence carries: a finite number of at least zero. */
const countOf = (value: unknown): number | null => {
    const count = finite(value);
    return count !== null && count >= 0 ? count : null;
};

const MISSIONS = 'missions';
const REWARDS = 'rewards';
const ENTRY_AGES = 'entry-ages';
const ENTRY_UNCERTAIN = 'entry-uncertain';
const ENTRY_PINS = 'entry-pins';
const PHOTO_SCAN = 'photo-scan';

type MissionKindName = keyof MissionEvidence['needs'];

/**
 * What one kind of mission still needs: unknown when the list was not read, or the progress of a mission of this kind
 * could not be read. A mission the classifier could not place never reached the evidence, so it adds to no need.
 */
const missionNeed =
    (kind: MissionKindName) =>
    (snapshot: FactSnapshot): ValueState<number> => {
        const evidence = loaded(snapshot.missions, MISSIONS);
        if (evidence.state !== 'known') return evidence;
        const { needs, unreadable } = evidence.value;
        if (Array.isArray(unreadable) && unreadable.includes(kind)) {
            return unknownOf('mission-progress-unreadable', [MISSIONS]);
        }
        const need = countOf(isObject(needs) ? needs[kind] : undefined);
        return need === null ? unknownOf('mission-need-malformed', [MISSIONS]) : known(need);
    };

const nextMissionExpiry = (snapshot: FactSnapshot): ValueState<number> => {
    const evidence = loaded(snapshot.missions, MISSIONS);
    if (evidence.state !== 'known') return evidence;
    const { nextExpiry, expiryUnreadable } = evidence.value;
    if (expiryUnreadable === true) return unknownOf('mission-expiry-unreadable', [MISSIONS]);
    if (nextExpiry === null) return absent('not-present');
    const expiry = finite(nextExpiry);
    return expiry === null ? unknownOf('mission-expiry-unreadable', [MISSIONS]) : known(expiry);
};

/** The id lists of a reward read, or why they cannot be used. */
const rewardLists = (
    snapshot: FactSnapshot,
): ValueState<{ claimable: readonly string[]; listed: readonly string[]; complete: boolean }> => {
    const evidence = loaded(snapshot.rewards, REWARDS);
    if (evidence.state !== 'known') return evidence;
    const { claimable, listed, complete } = evidence.value;
    return Array.isArray(claimable) && Array.isArray(listed) && typeof complete === 'boolean'
        ? known({ claimable, listed, complete })
        : unknownOf('evidence-malformed', [REWARDS]);
};

/**
 * Whether the subject challenge's rewards wait to be claimed. Known true when the read lists it as claimable; known false
 * when it lists it otherwise, or the listing reached its end without it; unknown when a capped listing never reached it.
 */
const rewardsClaimable = (snapshot: FactSnapshot): ValueState<boolean> => {
    const lists = rewardLists(snapshot);
    if (lists.state !== 'known') return lists;
    const id = snapshot.challenge?.id;
    if (typeof id !== 'string' && typeof id !== 'number') return unknownOf('id-unreadable', ['challenge.id']);
    const { claimable, listed, complete } = lists.value;
    if (claimable.includes(String(id))) return known(true);
    return listed.includes(String(id)) || complete ? known(false) : unknownOf('rewards-list-incomplete', [REWARDS]);
};

const rewardsClaimableCount = (snapshot: FactSnapshot): ValueState<number> => {
    const lists = rewardLists(snapshot);
    if (lists.state !== 'known') return lists;
    return lists.value.complete ? known(lists.value.claimable.length) : unknownOf('rewards-list-incomplete', [REWARDS]);
};

/** The recorded time of the entry a selector picks: the evidence of one entry, or why there is none. */
const entryTime = (snapshot: FactSnapshot, select?: ScenarioSelector): ValueState<{ at: number; exact: boolean }> => {
    const selected = selectedEntry(snapshot, select);
    if (selected.state !== 'known') return selected;
    const evidence = loaded(snapshot.entryAges, ENTRY_AGES);
    if (evidence.state !== 'known') return evidence;
    const { times } = evidence.value;
    const time: unknown = isObject(times) ? times[String(selected.value.id)] : undefined;
    const at = isObject(time) ? finite(time.at) : null;
    return at !== null && at > 0 && isObject(time) && typeof time.exact === 'boolean'
        ? known({ at, exact: time.exact })
        : unknownOf('entry-age-unrecorded', [ENTRY_AGES]);
};

/**
 * The entry's age at `now`. An exact time gives the age; an observed one only a lower bound (the entry went in at or
 * before it), so only `lowerBound` reads it.
 */
const entryAge =
    (lowerBound: boolean): FactReader =>
    (snapshot, select) => {
        const time = entryTime(snapshot, select);
        if (time.state !== 'known') return time;
        if (!lowerBound && !time.value.exact) return unknownOf('age-observed-only', [ENTRY_AGES]);
        return withClock(snapshot, (now) =>
            now < time.value.at ? unknownOf('age-in-future', ['clock', ENTRY_AGES]) : known(now - time.value.at),
        );
    };

const entryAgeExact: FactReader = (snapshot, select) => {
    const time = entryTime(snapshot, select);
    return time.state === 'known' ? known(time.value.exact) : time;
};

const entryUncertain: FactReader = (snapshot, select) => {
    const selected = selectedEntry(snapshot, select);
    if (selected.state !== 'known') return selected;
    const evidence = loaded(snapshot.uncertain, ENTRY_UNCERTAIN);
    if (evidence.state !== 'known') return evidence;
    const { ids } = evidence.value;
    return Array.isArray(ids)
        ? known(ids.includes(String(selected.value.id)))
        : unknownOf('evidence-malformed', [ENTRY_UNCERTAIN]);
};

const entryPinned: FactReader = (snapshot, select) => {
    const selected = selectedEntry(snapshot, select);
    if (selected.state !== 'known') return selected;
    const evidence = loaded(snapshot.pins, ENTRY_PINS);
    if (evidence.state !== 'known') return evidence;
    const { boost, turbo } = evidence.value;
    const id = String(selected.value.id);
    return known(boost === id || turbo === id);
};

/**
 * Whether the boost window is open, by the boost rule (voting/boostWindow.ts), once its state and timer are readable: a
 * missing or unrecognized state, or a malformed timer on a timed boost, cannot be told open or closed.
 */
const boostOpen: FactReader = (snapshot) => {
    const timer = boostTimer(snapshot);
    if (timer.state === 'unknown') return timer;
    const now = finite(snapshot.now);
    return now === null ? clockUnreadable() : known(isBoostWindowOpen(snapshot.challenge?.member?.boost, now));
};

/** Whether the boost is key-unlocked (nothing counts down), by the same rule file; unreadable like `boostOpen`. */
const boostKeyUnlocked: FactReader = (snapshot) => {
    const timer = boostTimer(snapshot);
    return timer.state === 'unknown' ? timer : known(isKeyUnlockedBoost(snapshot.challenge?.member?.boost));
};

/**
 * A challenge's head count or cap as the listing gives it: unknown when the field is not a count. `capped` reads a
 * missing or zero cap as "no cap" (absent), the meaning the join decision gives it (joinDecision.joinFreshRefusal).
 */
const challengeCount =
    (field: 'players' | 'max_players' | 'max_photo_submits', capped: boolean): FactReader =>
    ({ challenge }) => {
        const raw: unknown = challenge?.[field];
        if (capped && (raw === undefined || raw === null || raw === 0)) return absent('not-applicable');
        const count = countOf(raw);
        return count === null ? unknownOf(`${field}-unreadable`, [`challenge.${field}`]) : known(count);
    };

/**
 * The coins a join costs, `join_coins`: a missing field is a free challenge ("0 or absent when free"). A price that is
 * a fraction is no price to consent to, and a challenge that still owes the unlock needs a positive whole price: both
 * are unreadable, as the join decision reads them (joinDecision.joinFreshRefusal).
 */
const joinPrice: FactReader = ({ challenge }) => {
    const raw: unknown = challenge?.join_coins;
    const price = raw === undefined || raw === null ? 0 : countOf(raw);
    const owesUnlock = challenge?.member?.submit_state === 'join_unlock';
    if (price === null || (price > 0 && !Number.isInteger(price)) || (owesUnlock && !(price > 0))) {
        return unknownOf('join-price-unreadable', ['challenge.join_coins', 'member.submit_state']);
    }
    return known(price);
};

/** The member's submit state as the listing gives it, never inferred from the member object being there. */
const membership: FactReader = ({ challenge }) => {
    const state: unknown = challenge?.member?.submit_state;
    return typeof state === 'string' && state !== ''
        ? known(state)
        : unknownOf('membership-unreadable', ['member.submit_state']);
};

/** The photo scan the snapshot carries, or why it cannot be used. */
const photoScan = (snapshot: FactSnapshot): ValueState<{ eligible: number; complete: boolean }> => {
    const evidence = loaded(snapshot.photoScan, PHOTO_SCAN);
    if (evidence.state !== 'known') return evidence;
    const eligible = countOf(evidence.value.eligible);
    return eligible === null || typeof evidence.value.complete !== 'boolean'
        ? unknownOf('evidence-malformed', [PHOTO_SCAN])
        : known({ eligible, complete: evidence.value.complete });
};

/** A scan that stopped early proves only a lower bound. */
const INCOMPLETE_SCAN = 'photo-scan-incomplete';

const ENTRY_DEPENDENCIES = ['member.ranking.entries', 'vote-history'] as const;
const ALL_STAGES = ['account', 'preJoin', 'active', 'postClose'] as const;
const CHALLENGE_STAGES = ['preJoin', 'active', 'postClose'] as const;
const ACTIVE = ['active'] as const;
const PRE_JOIN_ACTIVE = ['preJoin', 'active'] as const;
const ACCOUNT_ACTIVE = ['account', 'active'] as const;

interface FactOptions {
    optional?: boolean;
    stages?: readonly ScenarioStage[];
    classification?: FactTraits['classification'];
    dependencies: readonly string[];
    takesSelect?: boolean;
    takesWindow?: boolean;
}

const traits = (read: FactReader, options: FactOptions): FactTraits => ({
    optional: options.optional ?? false,
    stages: options.stages ?? ACTIVE,
    classification: options.classification ?? 'raw',
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

    'challenge.players': numberFact('count', challengeCount('players', false), {
        stages: PRE_JOIN_ACTIVE,
        dependencies: ['challenge.players'],
    }),
    'challenge.maxPlayers': numberFact('count', challengeCount('max_players', true), {
        optional: true,
        stages: PRE_JOIN_ACTIVE,
        dependencies: ['challenge.max_players'],
    }),
    'challenge.maxPhotoSubmits': numberFact('count', challengeCount('max_photo_submits', false), {
        stages: PRE_JOIN_ACTIVE,
        dependencies: ['challenge.max_photo_submits'],
    }),
    'challenge.joinPrice': numberFact('coins', joinPrice, {
        stages: PRE_JOIN_ACTIVE,
        dependencies: ['challenge.join_coins', 'member.submit_state'],
    }),
    'challenge.membership': fact('string', membership, {
        stages: PRE_JOIN_ACTIVE,
        dependencies: ['member.submit_state'],
    }),

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

    'boost.open': fact('boolean', boostOpen, {
        dependencies: ['clock', 'member.boost.state', 'member.boost.timeout'],
    }),
    'boost.keyUnlocked': fact('boolean', boostKeyUnlocked, {
        dependencies: ['member.boost.state', 'member.boost.timeout'],
    }),

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

    'missions.joinNeed': numberFact('count', missionNeed('join'), {
        stages: ACCOUNT_ACTIVE,
        dependencies: [MISSIONS],
    }),
    'missions.fillNeed': numberFact('count', missionNeed('fill'), {
        stages: ACCOUNT_ACTIVE,
        dependencies: [MISSIONS],
    }),
    'missions.turboNeed': numberFact('count', missionNeed('turbo'), {
        stages: ACCOUNT_ACTIVE,
        dependencies: [MISSIONS],
    }),
    'missions.boostNeed': numberFact('count', missionNeed('boost'), {
        stages: ACCOUNT_ACTIVE,
        dependencies: [MISSIONS],
    }),
    'missions.voteNeed': numberFact('count', missionNeed('vote'), {
        stages: ACCOUNT_ACTIVE,
        dependencies: [MISSIONS],
    }),
    'missions.nextExpiry': numberFact('instant', nextMissionExpiry, {
        optional: true,
        stages: ACCOUNT_ACTIVE,
        dependencies: [MISSIONS],
    }),

    'rewards.claimable': fact('boolean', rewardsClaimable, {
        stages: ['postClose'],
        dependencies: [REWARDS, 'challenge.id'],
    }),
    'rewards.claimableCount': numberFact('count', rewardsClaimableCount, {
        stages: ['account'],
        dependencies: [REWARDS],
    }),

    'photos.eligibleCount': numberFact(
        'count',
        (snapshot) => {
            const scan = photoScan(snapshot);
            if (scan.state !== 'known') return scan;
            return scan.value.complete ? known(scan.value.eligible) : unknownOf(INCOMPLETE_SCAN, [PHOTO_SCAN]);
        },
        { stages: PRE_JOIN_ACTIVE, classification: 'policy', dependencies: [PHOTO_SCAN] },
    ),
    'photos.eligibleAtLeast': numberFact(
        'count',
        (snapshot) => {
            const scan = photoScan(snapshot);
            return scan.state === 'known' ? known(scan.value.eligible) : scan;
        },
        { stages: PRE_JOIN_ACTIVE, classification: 'policy', dependencies: [PHOTO_SCAN] },
    ),
    'photos.hasEligible': fact(
        'boolean',
        (snapshot) => {
            const scan = photoScan(snapshot);
            if (scan.state !== 'known') return scan;
            const { eligible, complete } = scan.value;
            if (eligible > 0) return known(true);
            return complete ? known(false) : unknownOf(INCOMPLETE_SCAN, [PHOTO_SCAN]);
        },
        { stages: PRE_JOIN_ACTIVE, classification: 'policy', dependencies: [PHOTO_SCAN] },
    ),

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
    'entry.age': numberFact('duration', entryAge(false), {
        optional: true,
        dependencies: [...ENTRY_DEPENDENCIES, 'clock', ENTRY_AGES],
        takesSelect: true,
    }),
    'entry.minAge': numberFact('duration', entryAge(true), {
        optional: true,
        dependencies: [...ENTRY_DEPENDENCIES, 'clock', ENTRY_AGES],
        takesSelect: true,
    }),
    'entry.ageExact': fact('boolean', entryAgeExact, {
        optional: true,
        dependencies: [...ENTRY_DEPENDENCIES, ENTRY_AGES],
        takesSelect: true,
    }),
    'entry.uncertainSubmission': fact('boolean', entryUncertain, {
        optional: true,
        dependencies: [...ENTRY_DEPENDENCIES, ENTRY_UNCERTAIN],
        takesSelect: true,
    }),
    'entry.pinned': fact('boolean', entryPinned, {
        optional: true,
        dependencies: [...ENTRY_DEPENDENCIES, ENTRY_PINS],
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
