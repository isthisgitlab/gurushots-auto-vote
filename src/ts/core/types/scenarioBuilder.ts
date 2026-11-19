/**
 * The GUI scenario builder's draft: a scenario document as the forms edit it,
 * before the real validator has seen it. Type-only: nothing here exists at
 * runtime.
 *
 * Looser than ScenarioDocument (settings/scenarioSchema.ts), which every
 * stored scenario and newScenario() fit: conditions, actions and selectors are
 * plain records the generic item editors rewrite field by field, and a draft
 * from the JSON tab is only known to pass isEditableDraft (scenarios/
 * builderModel.ts) — phases of plain objects, rules with a `do` list. Save and
 * simulate run the validator and report everything else by path.
 */

/** One rule of a draft phase. */
export type ScenarioDraftRule = {
    id?: string;
    label?: string;
    repeat?: string;
    /** The stages of the subject's life the rule runs in (vocabulary SCENARIO_STAGES). */
    stages?: string[];
    if?: unknown[];
    do: unknown[];
};

/** One draft phase: its settings overlay, live-value bindings, schedules, profile, pins, photo pool and rules. */
export type ScenarioDraftPhase = {
    settings?: Record<string, unknown>;
    bindings?: Record<string, unknown>;
    schedules?: Record<string, unknown>;
    profile?: string;
    pins?: Record<string, unknown>;
    photoPool?: Record<string, unknown>;
    rules?: ScenarioDraftRule[];
};

/** The whole draft the builder edits. */
export type ScenarioDraft = {
    name: string;
    version?: number;
    description?: string;
    /** Where the scenario runs: one challenge each (omitted), or the whole installation. */
    scope?: 'challenge' | 'installation';
    start: string;
    limits?: Record<string, number | undefined>;
    phases: Record<string, ScenarioDraftPhase>;
};
