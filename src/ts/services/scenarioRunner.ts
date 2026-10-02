/**
 * Runs a challenge's user-defined scenario inside the voting pass: evaluates
 * it (scenarios/evaluate.ts), executes the chosen rule's actions over the
 * existing primitives, and persists where the challenge now is in its plan
 * (scenarioStateStore.ts). Called by processChallenge before the built-in
 * steps, so they then run under the current phase's settings overlay.
 *
 * Contracts:
 *   - Before each action the challenge is re-read live and the action's entry
 *     re-resolved; an action whose target or precondition is gone is SKIPPED
 *     (logged, shown as the last problem), never forced.
 *   - Once an action of a rule has gone through, the rule is committed: its
 *     progress is persisted after every action, so a crash never repeats a
 *     spend that landed. After that, a SKIPPED action is passed over and the
 *     rule carries on (a permanent skip — the boost already used, the photo
 *     already entered — must not freeze the plan before its `goto`), while a
 *     FAILED or deferred action (the server refused, the spend lock was busy
 *     — worth retrying) resumes at that action next pass.
 *     A rule whose first action does not go through is simply not fired, so a
 *     skip never uses up a `once` rule.
 *   - No spend cap: each rule fires at most once per pass (a condition the
 *     action cannot change in-pass would otherwise re-fire it), and a `goto`
 *     chain stops when it comes back to a phase already visited this pass.
 *     Currency spends honour the user's own currencyReserve* settings and the
 *     scenario's optional `limits`.
 *   - Never throws into the pass; a failure is logged and recorded as the
 *     challenge's lastError for the status line.
 */

export { runScenarioStep, backgroundServiceOwnsScenarios } from './scenarioRunner/step';
