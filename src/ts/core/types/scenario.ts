/**
 * The recursive scenario condition, written out because zod cannot infer a
 * type through `z.lazy`. settings/scenarioSchema/shapes.ts types its condition schema
 * with it, so the schema and this type are checked against each other; every
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

export interface EntryCondition {
    type: 'entry';
    select: ScenarioSelector;
    field: OneOf<typeof vocabulary.NUMERIC_ENTRY_FIELDS> | OneOf<typeof vocabulary.BOOLEAN_ENTRY_FIELDS>;
    op: ComparisonOp;
    value: number | boolean;
    window?: Duration;
}

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
    | { type: 'all'; of: ScenarioCondition[] }
    | { type: 'any'; of: ScenarioCondition[] }
    | { type: 'not'; condition: ScenarioCondition };
