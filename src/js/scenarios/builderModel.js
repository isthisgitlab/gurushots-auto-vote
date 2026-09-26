/**
 * Pure, immutable edits of a scenario draft for the GUI builder. The builder
 * keeps the draft as a plain document and never validates it itself — the
 * real validator runs on save and on simulate, and reports issues by path.
 *
 * Dependency-free: renderer-safe.
 */

import { isPlainObject } from '../plainObject';

/** @import { ScenarioDraft, ScenarioDraftRule } from '../types/scenarioBuilder' */

/** @typedef {Array<string|number>} Path */

/**
 * A copy of `target` with the value at `path` replaced; `undefined` removes
 * the key (an optional field left empty), or the item from an array.
 *
 * The result keeps `target`'s type: the path and value are the caller's
 * claim, and the draft is validated on save like every other edit.
 *
 * @template T
 * @param {T} target
 * @param {Path} path
 * @param {unknown} value
 * @returns {T}
 */
const setIn = (target, path, value) => {
    if (path.length === 0) return /** @type {T} */ (value);
    const [head, ...rest] = path;
    // A shallow copy of whatever container the path steps into.
    const copy = /** @type {Record<string | number, unknown>} */ (Array.isArray(target) ? [...target] : { ...target });
    const next = rest.length ? setIn(copy[head] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value) : value;
    if (next === undefined && rest.length === 0) {
        if (Array.isArray(copy)) copy.splice(/** @type {number} */ (head), 1);
        else delete copy[head];
    } else {
        copy[head] = next;
    }
    return /** @type {T} */ (copy);
};

/**
 * Move the array item at `index` by `delta` (−1 up, +1 down); out-of-range
 * moves leave the list as it is.
 *
 * @template T
 * @param {T[]} list
 * @param {number} index
 * @param {number} delta
 * @returns {T[]}
 */
const moveItem = (list, index, delta) => {
    const to = index + delta;
    if (to < 0 || to >= list.length) return list;
    const copy = [...list];
    [copy[index], copy[to]] = [copy[to], copy[index]];
    return copy;
};

/** A new, empty scenario. @param {string} name */
const newScenario = (name) =>
    /** @type {ScenarioDraft} */ ({ name, version: 1, start: 'main', phases: { main: { rules: [] } } });

/**
 * The first `${base}${n}` not already taken, counting from `first` — 2 for a
 * phase (it follows `main`), 1 for a rule (the phase's first rule is `-1`).
 *
 * @param {string} base
 * @param {Iterable<string | undefined>} taken - rule ids, some possibly unset
 * @param {number} [first]
 */
const freeKey = (base, taken, first = 2) => {
    const used = new Set(taken);
    let n = first;
    while (used.has(`${base}${n}`)) n++;
    return `${base}${n}`;
};

/**
 * The draft with a new empty phase at the end.
 *
 * @param {ScenarioDraft} doc
 * @returns {ScenarioDraft}
 */
const addPhase = (doc) => ({
    ...doc,
    phases: { ...doc.phases, [freeKey('phase', Object.keys(doc.phases))]: { rules: [] } },
});

/**
 * Rename a phase, keeping its place, and follow the rename in `start` and in
 * every `goto` — the builder's one cross-reference edit.
 *
 * @param {ScenarioDraft} doc
 * @param {string} from
 * @param {string} to
 * @returns {ScenarioDraft}
 */
const renamePhase = (doc, from, to) => {
    if (from === to || !to || Object.prototype.hasOwnProperty.call(doc.phases, to)) return doc;
    const retarget = (/** @type {unknown} */ action) =>
        isPlainObject(action) && action.type === 'goto' && action.phase === from ? { ...action, phase: to } : action;
    /** @type {ScenarioDraft['phases']} */
    const phases = {};
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
 *
 * @param {ScenarioDraft} doc
 * @param {string} name
 * @returns {ScenarioDraft}
 */
const removePhase = (doc, name) => {
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
 *
 * @param {ScenarioDraft} doc
 * @param {string} phase
 * @returns {ScenarioDraftRule}
 */
const newRule = (doc, phase) => {
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
 *
 * @param {unknown} value
 * @returns {value is ScenarioDraft}
 */
const isEditableDraft = (value) => {
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
                        (/** @type {unknown} */ rule) =>
                            isPlainObject(rule) &&
                            Array.isArray(rule.do) &&
                            (rule.if === undefined || Array.isArray(rule.if)),
                    ))),
    );
};

export { setIn, moveItem, newScenario, addPhase, renamePhase, removePhase, newRule, isEditableDraft };
