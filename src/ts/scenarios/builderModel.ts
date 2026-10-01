/**
 * Pure, immutable edits of a scenario draft for the GUI builder. The builder
 * keeps the draft as a plain document and never validates it itself — the
 * real validator runs on save and on simulate, and reports issues by path.
 *
 * Dependency-free: renderer-safe.
 */

import { isPlainObject } from '../plainObject';

import type { ScenarioDraft, ScenarioDraftRule } from '../types/scenarioBuilder';

type Path = Array<string | number>;

/**
 * A copy of `target` with the value at `path` replaced; `undefined` removes
 * the key (an optional field left empty), or the item from an array.
 *
 * The result keeps `target`'s type: the path and value are the caller's
 * claim, and the draft is validated on save like every other edit.
 */
const setIn = <T>(target: T, path: Path, value: unknown): T => {
    if (path.length === 0) return value as T;
    const [head, ...rest] = path;
    // A shallow copy of whatever container the path steps into.
    const copy = (Array.isArray(target) ? [...target] : { ...target }) as Record<string | number, unknown>;
    const next = rest.length ? setIn(copy[head] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value) : value;
    if (next === undefined && rest.length === 0) {
        if (Array.isArray(copy)) copy.splice(head as number, 1);
        else delete copy[head];
    } else {
        copy[head] = next;
    }
    return copy as T;
};

/**
 * Move the array item at `index` by `delta` (−1 up, +1 down); out-of-range
 * moves leave the list as it is.
 */
const moveItem = <T>(list: T[], index: number, delta: number): T[] => {
    const to = index + delta;
    if (to < 0 || to >= list.length) return list;
    const copy = [...list];
    [copy[index], copy[to]] = [copy[to], copy[index]];
    return copy;
};

/** A new, empty scenario. */
const newScenario = (name: string) =>
    ({ name, version: 1, start: 'main', phases: { main: { rules: [] } } }) as ScenarioDraft;

/**
 * The first `${base}${n}` not already taken, counting from `first` — 2 for a
 * phase (it follows `main`), 1 for a rule (the phase's first rule is `-1`).
 *
 * @param taken - rule ids, some possibly unset
 */
const freeKey = (base: string, taken: Iterable<string | undefined>, first: number = 2) => {
    const used = new Set(taken);
    let n = first;
    while (used.has(`${base}${n}`)) n++;
    return `${base}${n}`;
};

/**
 * The draft with a new empty phase at the end.
 */
const addPhase = (doc: ScenarioDraft): ScenarioDraft => ({
    ...doc,
    phases: { ...doc.phases, [freeKey('phase', Object.keys(doc.phases))]: { rules: [] } },
});

/**
 * Rename a phase, keeping its place, and follow the rename in `start` and in
 * every `goto` — the builder's one cross-reference edit.
 */
const renamePhase = (doc: ScenarioDraft, from: string, to: string): ScenarioDraft => {
    if (from === to || !to || Object.prototype.hasOwnProperty.call(doc.phases, to)) return doc;
    const retarget = (action: unknown) =>
        isPlainObject(action) && action.type === 'goto' && action.phase === from ? { ...action, phase: to } : action;
    const phases: ScenarioDraft['phases'] = {};
    for (const [name, phase] of Object.entries(doc.phases)) {
        const rules = phase.rules?.map((rule) => ({ ...rule, do: rule.do.map(retarget) }));
        phases[name === from ? to : name] = rules ? { ...phase, rules } : phase;
    }
    return { ...doc, start: doc.start === from ? to : doc.start, phases };
};

/**
 * Remove a phase (never the last one); `start` moves to the first remaining
 * phase if it pointed at the removed one. Gotos into it are left for the
 * validator to report.
 */
const removePhase = (doc: ScenarioDraft, name: string): ScenarioDraft => {
    const names = Object.keys(doc.phases);
    if (names.length <= 1) return doc;
    const phases = { ...doc.phases };
    delete phases[name];
    return { ...doc, phases, start: doc.start === name ? Object.keys(phases)[0] : doc.start };
};

/**
 * A new rule for `phase`, with an id unique across the scenario. It starts as
 * a once-only notification: a fresh rule has no conditions, so an `always`
 * default would notify on every voting pass if saved unedited.
 */
const newRule = (doc: ScenarioDraft, phase: string): ScenarioDraftRule => {
    const ids = Object.values(doc.phases).flatMap((p) => (p.rules ?? []).map((r) => r.id));
    return {
        id: freeKey(`${phase}-`, ids, 1),
        repeat: 'once',
        do: [{ type: 'notify', message: 'Check the challenge' }],
    };
};

/**
 * True when a document (typically hand-edited JSON) has the shape the builder
 * forms can render: phases of plain objects, rules with an actions list. The
 * validator judges everything else on save; this only keeps the form from
 * rendering something it cannot.
 */
const isEditableDraft = (value: unknown): value is ScenarioDraft => {
    if (!isPlainObject(value)) return false;
    const { phases } = value;
    if (!isPlainObject(phases)) return false;
    return Object.values(phases).every(
        (phase) =>
            isPlainObject(phase) &&
            (phase.settings === undefined || isPlainObject(phase.settings)) &&
            (phase.rules === undefined ||
                (Array.isArray(phase.rules) &&
                    phase.rules.every(
                        (rule: unknown) =>
                            isPlainObject(rule) &&
                            Array.isArray(rule.do) &&
                            (rule.if === undefined || Array.isArray(rule.if)),
                    ))),
    );
};

export { setIn, moveItem, newScenario, addPhase, renamePhase, removePhase, newRule, isEditableDraft };
