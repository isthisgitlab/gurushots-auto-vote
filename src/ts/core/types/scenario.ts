/**
 * The recursive scenario condition and expression, written out because zod cannot infer a
 * type through `z.lazy`. settings/scenarioSchema/shapes.ts types its condition and expression
 * schemas with them, so each schema and its type are checked against each other; every
 * other scenario type is inferred from the schema (see ScenarioDocument).
 */

import type * as vocabulary from '../scenarios/vocabulary';
import type { ScenarioDocument } from '../settings/scenarioSchema';
import type { Bankroll, Challenge, LibraryPhoto } from './gurushots';
import type { ScenarioState } from './stores';

type OneOf<T extends readonly string[]> = T[number];

/** Seconds, or a duration string such as "1d 6h". */
export type Duration = number | string;

export type ComparisonOp = OneOf<typeof vocabulary.COMPARISON_OPS>;

type Currency = OneOf<typeof vocabulary.CURRENCIES>;

export type RankingSelectorName = OneOf<typeof vocabulary.RANKING_SELECTORS>;

export type NumericConditionType = OneOf<typeof vocabulary.NUMERIC_CONDITIONS>;

export type ScenarioSelector =
    | { by: 'slot'; index: number }
    | { by: 'memory'; slot: string }
    | { by: 'fastest'; window?: Duration; skipProtected?: boolean }
    | { by: 'slowest'; window?: Duration; skipProtected?: boolean }
    | { by: RankingSelectorName; skipProtected?: boolean }
    | { by: 'id'; id: string }
    | { by: 'pinned'; power: OneOf<typeof vocabulary.PINNED_POWERS> }
    | { by: 'pendingBoostTarget' }
    | { by: 'newest' | 'oldest'; time: OneOf<typeof vocabulary.ENTRY_TIME_MODES> }
    | {
          by: 'matching';
          where: EntryPredicate[];
          order: OneOf<typeof vocabulary.MATCH_ORDERS>;
          direction: OneOf<typeof vocabulary.ORDER_DIRECTIONS>;
      };

/** What an expression's number measures: an instant (Unix seconds), a duration (seconds) or a count of something. */
export type Quantity = OneOf<typeof vocabulary.QUANTITIES>;

export type DurationUnit = OneOf<typeof vocabulary.DURATION_UNITS>;

export type FactName = OneOf<typeof vocabulary.FACT_NAMES>;

/** The stages of a challenge's life a fact may be read in. */
export type ScenarioStage = OneOf<typeof vocabulary.SCENARIO_STAGES>;

/** Where a setting reference reads: below the phase overlay, or with it. */
export type SettingView = OneOf<typeof vocabulary.SETTING_VIEWS>;

type EntryField = OneOf<typeof vocabulary.NUMERIC_ENTRY_FIELDS> | OneOf<typeof vocabulary.BOOLEAN_ENTRY_FIELDS>;

export interface EntryCondition {
    type: 'entry';
    select: ScenarioSelector;
    field: EntryField;
    op: ComparisonOp;
    value: number | boolean;
    window?: Duration;
}

/** One test of an entry's field, as `entryCount` applies it to every entry. */
export interface EntryPredicate {
    field: EntryField;
    op: ComparisonOp;
    value: number | boolean;
}

/**
 * A typed expression. Numbers carry a quantity and are never mixed across quantities; a duration literal is written in
 * a unit and held in seconds; instants are Unix seconds. Evaluation answers known, absent or unknown
 * (scenarios/expressions.ts).
 */
export type ScenarioExpr =
    | { kind: 'literal'; value: number; quantity: Quantity; unit?: DurationUnit }
    | { kind: 'literal'; value: boolean }
    | { kind: 'literal'; value: string }
    | { kind: 'literal'; value: string[] }
    | { kind: 'fact'; name: FactName; select?: ScenarioSelector; window?: Duration }
    | { kind: 'setting'; key: string; view: SettingView }
    | { kind: 'offset'; from: ScenarioExpr; by: ScenarioExpr; direction: 'before' | 'after' }
    | { kind: 'difference'; from: ScenarioExpr; to: ScenarioExpr }
    | { kind: 'add' | 'subtract'; left: ScenarioExpr; right: ScenarioExpr }
    | { kind: 'earlier' | 'later' | 'min' | 'max'; of: ScenarioExpr[] };

/** What the engine reads of a challenge's runtime state: a stored record, or a fresh start state. */
export type ScenarioEngineState = Pick<ScenarioState, 'phase' | 'phaseEnteredAt' | 'memory' | 'fired' | 'inFlight'> &
    Partial<Pick<ScenarioState, 'history' | 'published'>>;

/**
 * A phase's dynamic submit schedule: one row per cumulative photo count, each with the instant (an expression) the photo is
 * due by. `end` alignment shifts the counts toward the end of a challenge that allows fewer photos (the literal schedule's
 * rule); `absolute` keeps each count as written and ignores a count above the challenge's capacity.
 */
type ScenarioSubmitSchedule = {
    alignment: 'end' | 'absolute';
    rows: Array<{ count: number; at: ScenarioExpr }>;
};

/** A phase's dynamic vote or pause schedule: windows that start at an instant and last a duration (both expressions). */
type ScenarioWindowSchedule = { rows: Array<{ at: ScenarioExpr; duration: ScenarioExpr }> };

/** The schedules a phase may carry in place of the literal settings of the same name (see services/autoFill/schedule.ts). */
export type ScenarioSchedules = {
    submit?: ScenarioSubmitSchedule;
    vote?: ScenarioWindowSchedule;
    pause?: ScenarioWindowSchedule;
};

export type ScenarioCondition =
    | { type: 'dailyWindow'; from: string; to: string }
    | { type: OneOf<typeof vocabulary.RANGE_TIME_CONDITIONS>; min?: Duration; max?: Duration }
    | { type: 'elapsedPercent'; min?: number; max?: number }
    | { type: NumericConditionType; op: ComparisonOp; value: number }
    | { type: OneOf<typeof vocabulary.STATE_CONDITIONS>; in: string[] }
    | { type: 'balance'; currency: Currency; op: ComparisonOp; value: number }
    | { type: 'memorySet'; slot: string }
    | EntryCondition
    | { type: 'compare'; left: ScenarioExpr; op: ComparisonOp; right: ScenarioExpr }
    | { type: OneOf<typeof vocabulary.PRESENCE_CONDITIONS>; value: ScenarioExpr }
    | { type: OneOf<typeof vocabulary.LIST_CONDITIONS>; list: ScenarioExpr; value: ScenarioExpr }
    | { type: 'entriesWhere'; quantifier: 'any' | 'all'; where: EntryPredicate[] }
    | { type: 'entryCount'; where: EntryPredicate[]; op: ComparisonOp; value: number }
    | { type: 'all'; of: ScenarioCondition[] }
    | { type: 'any'; of: ScenarioCondition[] }
    | { type: 'not'; condition: ScenarioCondition };

/** What a simulation may be asked to assume the outcome of: each is one kind of request that changes the account. */
export type SimulationOperation = OneOf<typeof vocabulary.SIMULATION_OPERATIONS>;

/** The outcome an assumption gives an operation: it went through, the server refused it, or it got no answer. */
export type SimulationOutcome = OneOf<typeof vocabulary.SIMULATION_OUTCOMES>;

/**
 * What a simulation runs on: the installation (no challenge), or one challenge in the stage of its life the kind names — a
 * candidate it has not joined, an active one, a completed one.
 */
export type SimulationSubject =
    | { kind: 'installation' }
    | { kind: 'candidate' | 'active' | 'completed'; challengeId: string };

/** What a timed evidence snapshot may replace: the subject's challenge, the bankroll, the library the submits draw from. */
export type SimulationFacts = { challenge?: Challenge; bankroll?: Bankroll; library?: LibraryPhoto[] };

/**
 * Everything a simulation assumes, and nothing else: the outcome of each kind of operation, and evidence that changes at a
 * given instant (unix seconds). Whatever is not assumed here is not assumed.
 */
export type SimulationAssumptions = {
    outcomes?: Partial<Record<SimulationOperation, SimulationOutcome>>;
    snapshots?: Array<{ at: number; facts: SimulationFacts }>;
};

/** The one request of both the GUI and the CLI: which scenario, on what, until when (unix seconds), assuming what. */
export type SimulationRequest = {
    scenario: { name: string } | { draft: ScenarioDocument };
    subject: SimulationSubject;
    until: number;
    assumptions?: SimulationAssumptions;
};

/** Why a simulation stopped: it reached `until`, nothing more is due, an outcome is needed, the scenario halted, or a cap was reached. */
export type SimulationStopReason = 'horizon' | 'idle' | 'needsEvidence' | 'halted' | 'limit';

/**
 * One thing a simulation shows. `applied: true` is what the run's own steps did to the simulated record; a `preview` is
 * prospective (where the run would look next) and is never applied.
 */
export type SimulationEvent =
    | { type: 'operation'; at: number; subject: string; operation: string; outcome: SimulationOutcome; applied: true }
    | { type: 'rule'; at: number; subject: string; phase: string; ruleId: string; applied: true }
    | { type: 'phase'; at: number; subject: string; from: string; to: string; applied: true }
    | { type: 'published'; at: number; subject: string; phase: string; validUntil: number | null; applied: true }
    | { type: 'notice'; at: number; subject: string; message: string; applied: true }
    | { type: 'preview'; at: number; subject: string; reason: 'next-wake'; applied: false };

/** A value the run used, and where it came from. */
export type SimulationDiagnostic = { key: string; value: string | number | boolean | null; provenance: string };

/** One resolved deadline of the final published phase: a submit row, a vote or pause window, or the publication's own validity. */
export type SimulationDeadline =
    | { kind: 'submit'; count: number; at: number | null }
    | { kind: 'vote' | 'pause'; start: number | null; end: number | null }
    | { kind: 'publication'; validUntil: number | null };

/** The operation a run could not go on without an assumed outcome for. */
export type SimulationNeed = { operation: SimulationOperation; subject: string; at: number };

export type SimulationResult = {
    events: SimulationEvent[];
    assumptions: SimulationAssumptions;
    diagnostics: SimulationDiagnostic[];
    deadlines: SimulationDeadline[];
    finalState: ScenarioState | null;
    stopReason: SimulationStopReason;
    /** Unix seconds the run stopped at. */
    stoppedAt: number;
    /** The instant of each pass the run made, in order: where a live run of the same evidence is replayed. */
    passes: number[];
    /** With `needsEvidence`: the outcome the run needs. */
    needs: SimulationNeed | null;
    /** With `halted`: why. */
    halted: string | null;
};
