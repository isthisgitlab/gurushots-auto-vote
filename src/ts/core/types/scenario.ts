/**
 * The recursive scenario condition and expression, written out because zod cannot infer a
 * type through `z.lazy`. settings/scenarioSchema/shapes.ts types its condition and expression
 * schemas with them, so each schema and its type are checked against each other; every
 * other scenario type is inferred from the schema (see ScenarioDocument).
 */

import type * as vocabulary from '../scenarios/vocabulary';
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
    | { by: RankingSelectorName; skipProtected?: boolean };

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
    Partial<Pick<ScenarioState, 'history'>>;

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
