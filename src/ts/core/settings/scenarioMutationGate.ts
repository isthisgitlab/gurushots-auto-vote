/**
 * The gate every change of a scenario assignment or definition runs under (see scenarioLifecycle.ts for the lifecycle it
 * serves): one cross-process mutation lock, then the step lock of every subject the change touches (tried in a stable
 * order, never waited for), then the progress read again, and a refusal while a touched subject has unresolved work.
 * A module of its own so that the settings that write assignments (challengeOverrides.ts, profiles.ts, titleRules.ts)
 * and the lifecycle (which reads them back) do not import each other.
 */

import { acquireUnlockLock } from '../joinStateStore';
import { isPlainObject } from '../plainObject';
import { INSTALLATION_KEY, ledgerFor, scenarioStepLock } from '../scenarioStateStore';
import { isCount } from '../scenarioStateFile';
import type { StateLock } from '../scenarioStateStore';
import { loadSettings } from './persistence';
import { normalizeProfileName } from './profileStore';

import type { ConfigV2 } from '../types/config';
import type { ScenarioState } from '../types/stores';

const MUTATION_LOCK_ID = 'scenario-mutation';

/** Why a change was not made before it began. */
type GateRefusal = 'busy' | 'unresolved-work' | 'state-unreadable';

/**
 * The subjects a change touches: the scenarios it affects (by name), the challenges it names, and whether it touches the
 * installation; `requireIdle: false` still takes every step lock but leaves the judgement of the progress to the change
 * (a handoff names its own reasons, an owner transfer keeps unresolved work as it is).
 */
type Plan = {
    names?: readonly string[];
    challengeIds?: readonly string[];
    installation?: boolean;
    requireIdle?: boolean;
};

/** A spend that may have landed or a rule stopped for one: nothing may be started over it. */
const unresolvedSpend = (state: ScenarioState): boolean =>
    Boolean(state.inFlight?.pending || state.inFlight?.unclear?.length) ||
    Object.values(state.fired).some((fired) => fired.unclearHalt !== undefined);

/** Whether the subject is in the middle of something: a rule, a spend that may have landed, or a handoff. */
const unresolvedWork = (state: ScenarioState): boolean =>
    state.inFlight !== null || Boolean(state.handoff) || unresolvedSpend(state);

/**
 * The step-lock keys of every subject a plan touches, in a stable order: the installation first (`@` sorts before any
 * challenge id). A subject is touched when it is named, when its challenge override or the installation assignment names
 * an affected scenario, or when its progress record does (progress is what unresolved work lives in, whatever the
 * assignment says now). `unreadable` is set when progress that could name one cannot be read.
 */
const subjectKeys = (settings: ConfigV2, plan: Plan): { keys: string[]; unreadable: boolean } => {
    const names = new Set((plan.names ?? []).map(normalizeProfileName).filter((name) => name !== ''));
    const keys = new Set<string>(plan.challengeIds ?? []);
    if (plan.installation) keys.add(INSTALLATION_KEY);
    let unreadable = false;
    if (names.size > 0) {
        for (const [id, record] of Object.entries(settings.challenges)) {
            if (isPlainObject(record.values) && names.has(normalizeProfileName(record.values.scenario))) keys.add(id);
        }
        if (names.has(normalizeProfileName(settings.installationScenario?.scenario))) keys.add(INSTALLATION_KEY);
        const listed = ledgerFor(settings.app.mock === true).list();
        unreadable = listed.corrupt !== false || listed.subjects.some(({ state }) => state === null);
        for (const { key, state } of listed.subjects) {
            if (state && names.has(normalizeProfileName(state.scenario))) keys.add(key);
        }
    }
    return { keys: [...keys].sort(), unreadable };
};

/** The first subject that cannot be changed over: why, or null. */
const refusalFor = (settings: ConfigV2, keys: readonly string[]): GateRefusal | null => {
    const ledger = ledgerFor(settings.app.mock === true);
    for (const key of keys) {
        const { corrupt, state } = ledger.get(key);
        if (corrupt) return 'state-unreadable';
        if (state && unresolvedWork(state)) return 'unresolved-work';
    }
    return null;
};

/**
 * Runs `apply` on the configuration as it is under the gate and the step locks of every subject the plan touches, or
 * says why it did not: `busy` (the gate, a step lock, or an assignment that moved meanwhile), `state-unreadable`,
 * `unresolved-work`. `plan` is asked for twice, on what is read before the locks and on what is read after them.
 *
 * @param apply - gets the configuration read under the locks and the subjects they cover
 */
const runGated = <T>(
    plan: (settings: ConfigV2) => Plan,
    apply: (settings: ConfigV2, subjects: readonly string[]) => T,
): { ok: true; value: T } | { ok: false; reason: GateRefusal } => {
    const gate = acquireUnlockLock(MUTATION_LOCK_ID, { category: 'scenario', internal: true });
    if (!gate.ok) return { ok: false, reason: 'busy' };
    const held: StateLock[] = [];
    try {
        const first = loadSettings();
        const planned = subjectKeys(first, plan(first)).keys;
        // Mock mode runs in one process, over progress that lives in memory: no step lock is taken for it.
        for (const key of first.app.mock === true ? [] : planned) {
            const lock = scenarioStepLock(key);
            if (!lock.ok) return { ok: false, reason: 'busy' };
            held.push(lock);
        }
        // Read again now that nothing else can change these subjects.
        const settings = loadSettings();
        const wanted = plan(settings);
        const subjects = subjectKeys(settings, wanted);
        if (subjects.keys.some((key) => !planned.includes(key))) return { ok: false, reason: 'busy' };
        if (wanted.requireIdle !== false) {
            if (subjects.unreadable) return { ok: false, reason: 'state-unreadable' };
            const refused = refusalFor(settings, subjects.keys);
            if (refused) return { ok: false, reason: refused };
        }
        return { ok: true, value: apply(settings, subjects.keys) };
    } finally {
        for (const lock of held.reverse()) lock.release();
        gate.release();
    }
};

// --- the definitions' revision -----------------------------------------------------------------------------------------

/**
 * The revision of the collection of definitions in a loaded configuration: 0 before the first change, the stored count
 * after; null when what is stored is not a count. A malformed revision is never read as 0: it blocks every change of the
 * collection until it is repaired.
 */
const definitionsRevision = (settings: ConfigV2): number | null => {
    const stored: unknown = settings.scenarioDefinitionsRevision;
    if (stored === undefined) return 0;
    return isCount(stored) && stored < Number.MAX_SAFE_INTEGER ? stored : null;
};

// --- the scenarios a name is used by -----------------------------------------------------------------------------------

/**
 * What uses the scenario `name` in a loaded configuration: a challenge (an override, a profile, or a rule) and the
 * installation. Scenario names are compared as profile names are.
 */
const referencesTo = (settings: ConfigV2, name: unknown): { challenge: boolean; installation: boolean } => {
    const wanted = normalizeProfileName(name);
    const named = (values: unknown): boolean =>
        isPlainObject(values) && normalizeProfileName(values.scenario) === wanted;
    return {
        challenge:
            wanted !== '' &&
            (Object.values(settings.challenges).some((record) => named(record.values)) ||
                Object.values(settings.profiles).some(named) ||
                settings.rules.some((rule) => normalizeProfileName(rule?.scenario) === wanted)),
        installation: wanted !== '' && normalizeProfileName(settings.installationScenario?.scenario) === wanted,
    };
};

/** The scenarios a list of rules assigns, through the rule itself or the profile it names, in rule order. */
const ruleAssignments = (settings: ConfigV2, rules: ConfigV2['rules']): string[] =>
    rules.flatMap((rule) => {
        const own = normalizeProfileName(rule?.scenario);
        if (own) return [own];
        const profile = rule?.profile === undefined ? undefined : settings.profiles[rule.profile];
        const fromProfile = isPlainObject(profile) ? normalizeProfileName(profile.scenario) : '';
        return fromProfile ? [fromProfile] : [];
    });

export { definitionsRevision, referencesTo, ruleAssignments, runGated, unresolvedSpend, unresolvedWork };
export type { GateRefusal, Plan };
