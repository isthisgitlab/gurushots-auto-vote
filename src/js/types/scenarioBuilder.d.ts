/**
 * The GUI scenario builder's draft: a scenario document as the forms edit it,
 * before the real validator has seen it. Type-only: nothing here exists at
 * runtime.
 *
 * Looser than ScenarioDocument (settings/scenarioSchema.js), which every
 * stored scenario and newScenario() fit: conditions, actions and selectors are
 * plain records the generic item editors rewrite field by field, and a draft
 * from the JSON tab is only known to pass isEditableDraft (scenarios/
 * builderModel.js) — phases of plain objects, rules with a `do` list. Save and
 * simulate run the validator and report everything else by path.
 */

/** One rule of a draft phase. */
export type ScenarioDraftRule = {
    id?: string;
    label?: string;
    repeat?: string;
    if?: unknown[];
    do: unknown[];
};

/** One draft phase: its settings overlay and rules. */
export type ScenarioDraftPhase = {
    settings?: Record<string, unknown>;
    rules?: ScenarioDraftRule[];
};

/** The whole draft the builder edits. */
export type ScenarioDraft = {
    name: string;
    version?: number;
    description?: string;
    start: string;
    limits?: Record<string, number | undefined>;
    phases: Record<string, ScenarioDraftPhase>;
};
