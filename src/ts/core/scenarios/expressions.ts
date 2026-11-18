/**
 * The typed scenario expression language: literals, facts, setting references, offset / difference / add / subtract
 * over instants and durations, and earlier / later / min / max. Every evaluation answers known, absent or unknown
 * (valueState.ts); arithmetic on an unknown value is unknown, on an absent one absent, and a result is never rounded or
 * clamped.
 *
 * Also the comparison and list semantics the conditions use, the conversion of a stored setting into an expression
 * value, and the static checks the document validator runs over an expression.
 *
 * Pure: facts.ts and valueState.ts are its only runtime imports. No scripting, no property paths, no user functions.
 */

import type {
    ComparisonOp,
    DurationUnit,
    FactName,
    Quantity,
    ScenarioExpr,
    ScenarioSelector,
    SettingView,
} from '../types/scenario';
import type { ScenarioValueDescriptor } from '../types/settings';
import { FACTS, readScenarioFact } from './facts';
import { SCENARIO_CAPS } from './vocabulary';
import { absent, allTruth, anyTruth, isKnown, known, notTruth, pending, unknownOf } from './valueState';

import type { FactSnapshot } from './facts';
import type { Absent, Truth, Unknown, ValueState, Verdict } from './valueState';

export type { Truth, ValueState, Verdict };

/** A value an expression produces: a number with its quantity, a boolean, a string, or a list of strings. */
export type ExprValue =
    | { kind: 'number'; value: number; quantity: Quantity }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'string'; value: string }
    | { kind: 'list'; value: string[] };

/** What an expression's value will be, known without evaluating it. */
export type ExprType =
    | { kind: 'number'; quantity: Quantity }
    | { kind: 'boolean' }
    | { kind: 'string' }
    | { kind: 'list' };

/** What evaluation reads: the fact snapshot, and the one place a setting is read through (the snapshot owner supplies it). */
export interface ExpressionContext extends FactSnapshot {
    readSetting?: (key: string, view: SettingView) => ValueState<ExprValue>;
}

const UNIT_SECONDS: Record<DurationUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

const mismatch = () => unknownOf('type-mismatch', []);

const numberValue = (value: number, quantity: Quantity): ExprValue => ({ kind: 'number', value, quantity });

/**
 * A computed number: an overflow is unknown rather than a clamped or infinite value.
 */
const numeric = (value: number, quantity: Quantity): ValueState<ExprValue> =>
    Number.isFinite(value) ? known(numberValue(value, quantity)) : unknownOf('not-finite', []);

/**
 * The comparison of two values of one kind.
 */
const compare = <T extends number | boolean | string>(a: T, op: ComparisonOp, b: T): boolean => {
    switch (op) {
        case '<':
            return a < b;
        case '<=':
            return a <= b;
        case '>':
            return a > b;
        case '>=':
            return a >= b;
        case '!=':
            return a !== b;
        default:
            return a === b;
    }
};

/**
 * The quantity an arithmetic node produces from two quantities, or null when they do not combine: an instant moves by a
 * duration, two instants differ by a duration, and any other quantity combines with itself.
 */
const arithmeticQuantity = (
    kind: 'offset' | 'difference' | 'add' | 'subtract',
    left: Quantity,
    right: Quantity,
): Quantity | null => {
    if (kind === 'difference') return left === 'instant' && right === 'instant' ? 'duration' : null;
    if (left === 'instant') return right === 'duration' ? 'instant' : null;
    return kind !== 'offset' && left === right ? left : null;
};

/**
 * The values of known states, or the unknown result of the ones that are not.
 */
const settled = (states: readonly ValueState<ExprValue>[]): ExprValue[] | Unknown => {
    const values: ExprValue[] = [];
    for (const item of states) if (item.state === 'known') values.push(item.value);
    return values.length === states.length ? values : pending(states);
};

/**
 * The values of known operands. An unknown operand makes the result unknown; with none unknown, an absent operand makes
 * the result absent (the sum with a value that is not there is not there), which is what lets `earlier` leave it out.
 */
const carried = (states: readonly ValueState<ExprValue>[]): ExprValue[] | Unknown | Absent => {
    const unreadable = states.filter((item) => item.state === 'unknown');
    if (unreadable.length) return pending(unreadable);
    const missing = states.filter((item): item is Absent => item.state === 'absent');
    if (missing.length) return missing[0];
    return states.filter(isKnown).map((item) => item.value);
};

const arithmetic = (
    kind: 'offset' | 'difference' | 'add' | 'subtract',
    left: ValueState<ExprValue>,
    right: ValueState<ExprValue>,
    combine: (a: number, b: number) => number,
): ValueState<ExprValue> => {
    const values = carried([left, right]);
    if (!Array.isArray(values)) return values;
    const [a, b] = values;
    if (a.kind !== 'number' || b.kind !== 'number') return mismatch();
    const quantity = arithmeticQuantity(kind, a.quantity, b.quantity);
    return quantity === null ? mismatch() : numeric(combine(a.value, b.value), quantity);
};

/**
 * earlier / later / min / max: absent operands are left out, any unknown operand makes the result unknown, and all
 * absent is absent.
 */
const aggregate = (
    kind: 'earlier' | 'later' | 'min' | 'max',
    states: readonly ValueState<ExprValue>[],
): ValueState<ExprValue> => {
    const unreadable = states.filter((item) => item.state === 'unknown');
    if (unreadable.length) return pending(unreadable);
    const values: ExprValue[] = [];
    for (const item of states) if (item.state === 'known') values.push(item.value);
    if (!values.length) return states.find((item) => item.state === 'absent') ?? unknownOf('no-operands', []);
    const numbers = values.flatMap((item) => (item.kind === 'number' ? [item] : []));
    const [first] = numbers;
    const sameQuantity = numbers.length === values.length && numbers.every((item) => item.quantity === first.quantity);
    if (!sameQuantity || ((kind === 'earlier' || kind === 'later') && first.quantity !== 'instant')) return mismatch();
    const picked =
        kind === 'earlier' || kind === 'min'
            ? Math.min(...numbers.map((item) => item.value))
            : Math.max(...numbers.map((item) => item.value));
    return known(numberValue(picked, first.quantity));
};

const literalValue = (expr: Extract<ScenarioExpr, { kind: 'literal' }>): ExprValue => {
    const { value } = expr;
    if (typeof value === 'number') {
        const { quantity, unit } = expr as Extract<ScenarioExpr, { kind: 'literal'; value: number }>;
        return numberValue(unit ? value * UNIT_SECONDS[unit] : value, quantity);
    }
    if (typeof value === 'boolean') return { kind: 'boolean', value };
    return typeof value === 'string' ? { kind: 'string', value } : { kind: 'list', value };
};

/**
 * A fact's value as an expression value, with the quantity the registry declares.
 */
const factValue = (expr: Extract<ScenarioExpr, { kind: 'fact' }>, ctx: ExpressionContext): ValueState<ExprValue> => {
    const result = readScenarioFact(expr.name, ctx, expr.select, expr.window);
    if (result.state !== 'known') return result;
    const definition = FACTS[expr.name];
    const { value } = result;
    if (definition.kind === 'number') return known(numberValue(value as number, definition.quantity));
    if (definition.kind === 'boolean') return known({ kind: 'boolean', value: value as boolean });
    if (definition.kind === 'string') return known({ kind: 'string', value: value as string });
    return known({ kind: 'list', value: value as string[] });
};

/**
 * Evaluates an expression against a snapshot. Without `ctx.readSetting` every setting reference is unknown
 * (`settings-unavailable`).
 */
const evaluateExpression = (expr: ScenarioExpr, ctx: ExpressionContext): ValueState<ExprValue> => {
    switch (expr.kind) {
        case 'literal':
            return known(literalValue(expr));
        case 'fact':
            return factValue(expr, ctx);
        case 'setting':
            return ctx.readSetting
                ? ctx.readSetting(expr.key, expr.view)
                : unknownOf('settings-unavailable', [`setting:${expr.key}`]);
        case 'offset':
            return arithmetic('offset', evaluateExpression(expr.from, ctx), evaluateExpression(expr.by, ctx), (a, b) =>
                expr.direction === 'before' ? a - b : a + b,
            );
        case 'difference':
            return arithmetic(
                'difference',
                evaluateExpression(expr.from, ctx),
                evaluateExpression(expr.to, ctx),
                (a, b) => b - a,
            );
        case 'add':
            return arithmetic(
                'add',
                evaluateExpression(expr.left, ctx),
                evaluateExpression(expr.right, ctx),
                (a, b) => a + b,
            );
        case 'subtract':
            return arithmetic(
                'subtract',
                evaluateExpression(expr.left, ctx),
                evaluateExpression(expr.right, ctx),
                (a, b) => a - b,
            );
        default:
            return aggregate(
                expr.kind,
                expr.of.map((item) => evaluateExpression(item, ctx)),
            );
    }
};

const sameSet = (a: readonly string[], b: readonly string[]) =>
    a.every((item) => b.includes(item)) && b.every((item) => a.includes(item));

/**
 * Compares two values. Known against known is known; an absent or unknown side leaves it unknown; numbers compare only
 * within one quantity, and booleans, strings and lists (as sets) only with = and !=.
 */
const compareValues = (left: ValueState<ExprValue>, op: ComparisonOp, right: ValueState<ExprValue>): Verdict => {
    const values = settled([left, right]);
    if (!Array.isArray(values)) return values;
    const [a, b] = values;
    if (a.kind === 'number' && b.kind === 'number') {
        return a.quantity === b.quantity ? known(compare(a.value, op, b.value)) : mismatch();
    }
    const equality = op === '=' || op === '!=';
    if (!equality) return mismatch();
    if (a.kind === 'list' && b.kind === 'list') return known(compare(sameSet(a.value, b.value), op, true));
    if ((a.kind === 'boolean' && b.kind === 'boolean') || (a.kind === 'string' && b.kind === 'string')) {
        return known(compare<boolean | string>(a.value, op, b.value));
    }
    return mismatch();
};

/**
 * `present`: a known value is present, a confirmed absence is not; a failed read stays unknown.
 */
const presentTruth = (value: ValueState<ExprValue>): Verdict =>
    value.state === 'unknown' ? value : known(value.state === 'known');

/**
 * `absent`: a confirmed absence is absent, a known value is not; a failed read stays unknown.
 */
const absentTruth = (value: ValueState<ExprValue>): Verdict =>
    value.state === 'unknown' ? value : known(value.state === 'absent');

/**
 * contains / containsAny / containsAll over a list of strings.
 */
const listTruth = (
    kind: 'contains' | 'containsAny' | 'containsAll',
    list: ValueState<ExprValue>,
    value: ValueState<ExprValue>,
): Verdict => {
    const values = settled([list, value]);
    if (!Array.isArray(values)) return values;
    const [held, wanted] = values;
    if (held.kind !== 'list') return mismatch();
    if (kind === 'contains') return wanted.kind === 'string' ? known(held.value.includes(wanted.value)) : mismatch();
    if (wanted.kind !== 'list') return mismatch();
    return known(
        kind === 'containsAny'
            ? wanted.value.some((item) => held.value.includes(item))
            : wanted.value.every((item) => held.value.includes(item)),
    );
};

/**
 * A stored setting value as an expression value, converted at the setting boundary: a number with a time unit becomes a
 * duration in seconds, every other value is passed as stored (a setting's own zero sentinel included). A value of the
 * wrong shape is unknown, never a default.
 */
const settingValue = (descriptor: ScenarioValueDescriptor, raw: unknown): ValueState<ExprValue> => {
    const malformed = () => unknownOf('setting-malformed', []);
    switch (descriptor.kind) {
        case 'number':
            if (typeof raw !== 'number' || !Number.isFinite(raw)) return malformed();
            return numeric(
                descriptor.quantity === 'duration' ? raw * UNIT_SECONDS[descriptor.unit] : raw,
                descriptor.quantity,
            );
        case 'boolean':
            return typeof raw === 'boolean' ? known({ kind: 'boolean', value: raw }) : malformed();
        case 'string':
            return typeof raw === 'string' ? known({ kind: 'string', value: raw }) : malformed();
        case 'enum':
            return typeof raw === 'string' && descriptor.values.includes(raw)
                ? known({ kind: 'string', value: raw })
                : malformed();
        case 'list':
            return Array.isArray(raw) && raw.every((item): item is string => typeof item === 'string')
                ? known({ kind: 'list', value: [...raw] })
                : malformed();
        default:
            return unknownOf('setting-not-expressible', []);
    }
};

/**
 * The type an expression reads from a setting of this descriptor, or null when the setting has no expression form.
 */
const exprTypeOfDescriptor = (descriptor: ScenarioValueDescriptor): ExprType | null => {
    switch (descriptor.kind) {
        case 'number':
            return { kind: 'number', quantity: descriptor.quantity };
        case 'boolean':
        case 'list':
            return { kind: descriptor.kind };
        case 'string':
        case 'enum':
            return { kind: 'string' };
        default:
            return null;
    }
};

/** Looks up what a setting key reads as in an expression: its type, or the reason it cannot be read. */
export type SettingTypeLookup = (key: string) => ExprType | string;

export type ExprIssue = { path: string; message: string };

/**
 * Whether an expression nests deeper than `levels` (stops looking past that depth).
 */
const nestsDeeperThan = (expr: ScenarioExpr, levels: number): boolean => {
    if (levels < 1) return true;
    switch (expr.kind) {
        case 'offset':
        case 'difference':
        case 'add':
        case 'subtract': {
            const [first, second] =
                expr.kind === 'offset'
                    ? [expr.from, expr.by]
                    : expr.kind === 'difference'
                      ? [expr.from, expr.to]
                      : [expr.left, expr.right];
            return nestsDeeperThan(first, levels - 1) || nestsDeeperThan(second, levels - 1);
        }
        case 'earlier':
        case 'later':
        case 'min':
        case 'max':
            return expr.of.some((item) => nestsDeeperThan(item, levels - 1));
        default:
            return false;
    }
};

const SAME_OR_INSTANT = 'two values of one quantity, or an instant and a duration';

const asNumber = (type: ExprType | null): Quantity | null => (type?.kind === 'number' ? type.quantity : null);

/**
 * The type of an expression, pushing one issue per mistake at the path of the part that caused it. A part that already
 * has an issue has no type, so the mistake is not reported again where it meets its neighbours.
 */
const typeOf = (expr: ScenarioExpr, path: string, lookup: SettingTypeLookup, issues: ExprIssue[]): ExprType | null => {
    const refuse = (message: string) => {
        issues.push({ path, message });
        return null;
    };
    switch (expr.kind) {
        case 'literal': {
            if (typeof expr.value !== 'number') {
                return typeof expr.value === 'boolean'
                    ? { kind: 'boolean' }
                    : typeof expr.value === 'string'
                      ? { kind: 'string' }
                      : { kind: 'list' };
            }
            const { quantity, unit } = expr as Extract<ScenarioExpr, { kind: 'literal'; value: number }>;
            if (quantity === 'duration' && unit === undefined) {
                return refuse('A duration needs a unit: seconds, minutes, hours or days');
            }
            if (quantity !== 'duration' && unit !== undefined) return refuse('Only a duration has a unit');
            return { kind: 'number', quantity };
        }
        case 'fact': {
            const definition = FACTS[expr.name];
            if (definition.takesSelect && !expr.select) return refuse(`${expr.name} needs a select`);
            if (!definition.takesSelect && expr.select) return refuse(`${expr.name} does not take a select`);
            if (!definition.takesWindow && expr.window !== undefined)
                return refuse(`${expr.name} does not take a window`);
            return definition.kind === 'number'
                ? { kind: 'number', quantity: definition.quantity }
                : { kind: definition.kind };
        }
        case 'setting': {
            const found = lookup(expr.key);
            return typeof found === 'string' ? refuse(found) : found;
        }
        case 'offset':
        case 'difference':
        case 'add':
        case 'subtract': {
            const [first, second] =
                expr.kind === 'offset'
                    ? [expr.from, expr.by]
                    : expr.kind === 'difference'
                      ? [expr.from, expr.to]
                      : [expr.left, expr.right];
            const [firstPath, secondPath] =
                expr.kind === 'offset'
                    ? ['from', 'by']
                    : expr.kind === 'difference'
                      ? ['from', 'to']
                      : ['left', 'right'];
            const left = typeOf(first, `${path}.${firstPath}`, lookup, issues);
            const right = typeOf(second, `${path}.${secondPath}`, lookup, issues);
            if (left === null || right === null) return null;
            const leftQuantity = asNumber(left);
            const rightQuantity = asNumber(right);
            const quantity =
                leftQuantity === null || rightQuantity === null
                    ? null
                    : arithmeticQuantity(expr.kind, leftQuantity, rightQuantity);
            if (quantity !== null) return { kind: 'number', quantity };
            return refuse(
                {
                    offset: 'offset moves an instant by a duration',
                    difference: 'difference needs two instants',
                    add: `add needs ${SAME_OR_INSTANT}`,
                    subtract: `subtract needs ${SAME_OR_INSTANT}; use difference for two instants`,
                }[expr.kind],
            );
        }
        default: {
            const types = expr.of.map((item, index) => typeOf(item, `${path}.of[${index}]`, lookup, issues));
            const { aggregateOperands } = SCENARIO_CAPS;
            if (expr.of.length < 2 || expr.of.length > aggregateOperands) {
                issues.push({ path: `${path}.of`, message: `${expr.kind} takes 2 to ${aggregateOperands} operands` });
                return null;
            }
            if (types.includes(null)) return null;
            const quantities = types.map(asNumber);
            const [first] = quantities;
            const sameQuantity = first !== null && quantities.every((quantity) => quantity === first);
            if (expr.kind === 'earlier' || expr.kind === 'later') {
                return sameQuantity && first === 'instant'
                    ? { kind: 'number', quantity: 'instant' }
                    : refuse(`${expr.kind} needs instants`);
            }
            return sameQuantity
                ? { kind: 'number', quantity: first }
                : refuse(`${expr.kind} needs numbers of one quantity`);
        }
    }
};

/**
 * Checks an expression before it is stored: its depth, its facts (a select exactly on entry facts), its settings
 * (through `lookup`), and that every quantity combines. Returns its type (null when it has an issue) and the issues,
 * each at a path under `path`.
 */
const checkExpression = (
    expr: ScenarioExpr,
    lookup: SettingTypeLookup,
    path: string,
): { type: ExprType | null; issues: ExprIssue[] } => {
    const limit = SCENARIO_CAPS.expressionDepth;
    if (nestsDeeperThan(expr, limit)) {
        return { type: null, issues: [{ path, message: `Expression nests deeper than ${limit} levels` }] };
    }
    const issues: ExprIssue[] = [];
    return { type: typeOf(expr, path, lookup, issues), issues };
};

const typeName = (type: ExprType) => `a ${type.kind}`;

/**
 * Why two types cannot be compared with `op`, or null when they can.
 */
const compareIssue = (op: ComparisonOp, left: ExprType, right: ExprType): string | null => {
    if (left.kind !== right.kind) return `Cannot compare ${typeName(left)} with ${typeName(right)}`;
    if (left.kind === 'number' && right.kind === 'number') {
        return left.quantity === right.quantity ? null : `Cannot compare ${left.quantity} with ${right.quantity}`;
    }
    return op === '=' || op === '!=' ? null : `${op} compares numbers only`;
};

/**
 * Why a list condition cannot take these types, or null when it can.
 */
const listIssue = (
    kind: 'contains' | 'containsAny' | 'containsAll',
    list: ExprType,
    value: ExprType,
): string | null => {
    if (list.kind !== 'list') return `${kind} needs a list`;
    if (kind === 'contains') return value.kind === 'string' ? null : 'contains needs a string to look for';
    return value.kind === 'list' ? null : `${kind} needs a list to look for`;
};

/**
 * Every fact (with its select) and setting an expression reads, in the order met.
 */
const exprReferences = (
    expr: ScenarioExpr,
): {
    facts: Array<{ name: FactName; select?: ScenarioSelector }>;
    settings: Array<{ key: string; view: SettingView }>;
} => {
    const facts: Array<{ name: FactName; select?: ScenarioSelector }> = [];
    const settings: Array<{ key: string; view: SettingView }> = [];
    const visit = (node: ScenarioExpr) => {
        switch (node.kind) {
            case 'fact':
                facts.push({ name: node.name, select: node.select });
                break;
            case 'setting':
                settings.push({ key: node.key, view: node.view });
                break;
            case 'offset':
                visit(node.from);
                visit(node.by);
                break;
            case 'difference':
                visit(node.from);
                visit(node.to);
                break;
            case 'add':
            case 'subtract':
                visit(node.left);
                visit(node.right);
                break;
            case 'earlier':
            case 'later':
            case 'min':
            case 'max':
                node.of.forEach(visit);
                break;
            default:
                break;
        }
    };
    visit(expr);
    return { facts, settings };
};

export {
    known,
    absent,
    unknownOf,
    isKnown,
    notTruth,
    allTruth,
    anyTruth,
    compare,
    evaluateExpression,
    compareValues,
    presentTruth,
    absentTruth,
    listTruth,
    settingValue,
    exprTypeOfDescriptor,
    checkExpression,
    compareIssue,
    listIssue,
    exprReferences,
};
