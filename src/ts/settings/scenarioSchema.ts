/**
 * Validation of a user-defined scenario document (see scenarios/vocabulary.ts
 * for the pieces). A scenario may come from another player's shared file, so
 * this is the trust boundary:
 *
 *   - every object is strict — an unknown key is an error, never ignored;
 *   - names are bounded identifiers, and prototype-shaped names are refused;
 *   - a phase's `settings` may only hold per-challenge setting keys, each
 *     validated like a profile value, so a shared file can never reach the
 *     token, API headers, mock mode or any other global key;
 *   - references (start / goto phases, memory slots) must resolve.
 *
 * Errors come back as `{path, message}` with a readable path such as
 * `phases.buildup.rules[1].do[0].with`, so the user can find the problem.
 */

import * as vocabulary from '../scenarios/vocabulary';
import { errorMessage } from '../errorMessage';
import { scenarioDocument } from './scenarioSchema/shapes';
import { assignRuleIds, semanticIssues } from './scenarioSchema/semantics';

import type { ScenarioDocument } from './scenarioSchema/shapes';
import type { ScenarioIssue } from './scenarioSchema/semantics';

export type { ScenarioAction, ScenarioDocument, ScenarioRule } from './scenarioSchema/shapes';
export type { ScenarioIssue };

const { SCENARIO_CAPS } = vocabulary;

/**
 * `['phases', 'buildup', 'rules', 1, 'do', 0]` → `phases.buildup.rules[1].do[0]`.
 */
const formatPath = (path: ReadonlyArray<PropertyKey>): string =>
    path.reduce(
        (out: string, segment) =>
            typeof segment === 'number' ? `${out}[${segment}]` : out ? `${out}.${String(segment)}` : String(segment),
        '',
    );

/**
 * Validates a scenario document. On success returns the canonical document
 * (names trimmed, every rule carrying an id); otherwise every issue found.
 *
 * @param globalDefaults - the stored global challenge defaults
 */
const validateScenario = (
    input: unknown,
    globalDefaults: Record<string, unknown>,
): { ok: true; scenario: ScenarioDocument } | { ok: false; issues: ScenarioIssue[] } => {
    const parsed = scenarioDocument.safeParse(input);
    if (!parsed.success) {
        return {
            ok: false,
            issues: parsed.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
        };
    }
    const doc = parsed.data;
    const issues = semanticIssues(doc, globalDefaults);
    if (issues.length) return { ok: false, issues };
    return { ok: true, scenario: assignRuleIds(doc) };
};

/**
 * Parses shared scenario JSON text, bounded before parsing.
 */
const parseScenarioJson = (text: unknown): { ok: true; value: unknown } | { ok: false; issues: ScenarioIssue[] } => {
    if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, issues: [{ path: '', message: 'No scenario JSON was given' }] };
    }
    if (new TextEncoder().encode(text).length > SCENARIO_CAPS.importBytes) {
        return {
            ok: false,
            issues: [{ path: '', message: `The file is larger than ${SCENARIO_CAPS.importBytes / 1024} KB` }],
        };
    }
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (error) {
        // JSON.parse only ever throws a SyntaxError.
        return {
            ok: false,
            issues: [{ path: '', message: `Not valid JSON: ${errorMessage(error)}` }],
        };
    }
};

export { validateScenario, parseScenarioJson, formatPath };
