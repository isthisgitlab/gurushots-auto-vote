// @ts-check
/**
 * Pure, immutable edits of a scenario draft for the GUI builder. The builder
 * keeps the draft as a plain document and never validates it itself — the
 * real validator runs on save and on simulate, and reports issues by path.
 *
 * Dependency-free: renderer-safe.
 */

/** @typedef {Array<string|number>} Path */

/**
 * A copy of `target` with the value at `path` replaced; `undefined` removes
 * the key (an optional field left empty), or the item from an array.
 *
 * @param {any} target
 * @param {Path} path
 * @param {unknown} value
 * @returns {any}
 */
const setIn = (target, path, value) => {
    if (path.length === 0) return value;
    const [head, ...rest] = path;
    const copy = Array.isArray(target) ? [...target] : { ...target };
    const next = rest.length ? setIn(copy[head] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value) : value;
    if (next === undefined && rest.length === 0) {
        if (Array.isArray(copy)) copy.splice(/** @type {number} */ (head), 1);
        else delete copy[head];
    } else {
        copy[head] = next;
    }
    return copy;
};

/**
 * The value at `path`, or undefined.
 *
 * @param {any} target
 * @param {Path} path
 */
const getIn = (target, path) => path.reduce((node, key) => (node == null ? undefined : node[key]), target);

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
const newScenario = (name) => ({ name, version: 1, start: 'main', phases: { main: { rules: [] } } });

/**
 * The first `${base}${n}` not already taken.
 *
 * @param {string} base
 * @param {Iterable<string>} taken
 */
const freeKey = (base, taken) => {
    const used = new Set(taken);
    let n = 2;
    while (used.has(`${base}${n}`)) n++;
    return `${base}${n}`;
};

/** The draft with a new empty phase at the end. @param {any} doc */
const addPhase = (doc) => ({
    ...doc,
    phases: { ...doc.phases, [freeKey('phase', Object.keys(doc.phases))]: { rules: [] } },
});

/**
 * Rename a phase, keeping its place, and follow the rename in `start` and in
 * every `goto` — the builder's one cross-reference edit.
 *
 * @param {any} doc
 * @param {string} from
 * @param {string} to
 */
const renamePhase = (doc, from, to) => {
    if (from === to || !to || Object.prototype.hasOwnProperty.call(doc.phases, to)) return doc;
    const retarget = (/** @type {any} */ action) =>
        action.type === 'goto' && action.phase === from ? { ...action, phase: to } : action;
    /** @type {Record<string, any>} */
    const phases = {};
    for (const [name, phase] of Object.entries(doc.phases)) {
        const rules = phase.rules?.map((/** @type {any} */ rule) => ({ ...rule, do: rule.do.map(retarget) }));
        phases[name === from ? to : name] = rules ? { ...phase, rules } : phase;
    }
    return { ...doc, start: doc.start === from ? to : doc.start, phases };
};

/**
 * Remove a phase (never the last one); `start` moves to the first remaining
 * phase if it pointed at the removed one. Gotos into it are left for the
 * validator to report.
 *
 * @param {any} doc
 * @param {string} name
 */
const removePhase = (doc, name) => {
    const names = Object.keys(doc.phases);
    if (names.length <= 1) return doc;
    const phases = { ...doc.phases };
    delete phases[name];
    return { ...doc, phases, start: doc.start === name ? Object.keys(phases)[0] : doc.start };
};

/**
 * A new rule for `phase`, with an id unique across the scenario.
 *
 * @param {any} doc
 * @param {string} phase
 */
const newRule = (doc, phase) => {
    const ids = Object.values(doc.phases).flatMap((/** @type {any} */ p) =>
        (p.rules ?? []).map((/** @type {any} */ r) => r.id),
    );
    return { id: freeKey(`${phase}-`, ids), do: [{ type: 'notify', message: 'Check the challenge' }] };
};

/** @param {unknown} value */
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * True when a document (typically hand-edited JSON) has the shape the builder
 * forms can render: phases of plain objects, rules with an actions list. The
 * validator judges everything else on save; this only keeps the form from
 * rendering something it cannot.
 *
 * @param {unknown} value
 */
const isEditableDraft = (value) => {
    if (!isPlainObject(value)) return false;
    const { phases } = /** @type {any} */ (value);
    if (!isPlainObject(phases)) return false;
    return Object.values(phases).every(
        (phase) =>
            isPlainObject(phase) &&
            (phase.settings === undefined || isPlainObject(phase.settings)) &&
            (phase.rules === undefined ||
                (Array.isArray(phase.rules) &&
                    phase.rules.every(
                        (/** @type {any} */ rule) =>
                            isPlainObject(rule) &&
                            Array.isArray(rule.do) &&
                            (rule.if === undefined || Array.isArray(rule.if)),
                    ))),
    );
};

module.exports = {
    setIn,
    getIn,
    moveItem,
    newScenario,
    addPhase,
    renamePhase,
    removePhase,
    newRule,
    freeKey,
    isEditableDraft,
};
