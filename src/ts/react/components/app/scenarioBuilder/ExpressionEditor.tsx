import { useId } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ToneNote } from '@/components/ui/ToneNote';
import * as vocabulary from '../../../../core/scenarios/vocabulary';
import { FACTS } from '../../../../core/scenarios/facts';
import {
    defaultExpression,
    expectedOfDescriptor,
    factGives,
    factExpression,
    expressionKindsFor,
    EXPRESSION_KINDS,
    COMPOSITE_KINDS,
} from '../../../../core/scenarios/builderSpec';
import { ItemEditor } from './ItemEditors';
import { useListFocus } from './listFocus';

import type { ExprExpected } from '../../../../core/scenarios/builderSpec';
import type { ComponentChildren } from 'preact';
import type { FactName, ScenarioStage } from '../../../../core/types/scenario';
import type { ScenarioValueDescriptor } from '../../../../core/types/settings';

/**
 * The editor for one live value (a typed expression): what it is built from —
 * a literal, a fact, a setting, or a combination — and each kind's own fields.
 * Controlled like every builder editor: `value` in, `onChange(next)` out; the
 * validator judges the result on save.
 *
 * The fact list offers only facts that run in the rule's stages and give what
 * `expected` names, and the setting list only the keys the context passes, so
 * the offered options are ones the backend accepts. (ItemEditors imports this
 * module for its expression fields, and the fact editor imports ItemEditors
 * back for an entry selector; each is used only at render time, so the cycle
 * is safe.)
 */

const CONTROL = 'input input-sm w-full';
const SELECT = 'select select-sm w-full';

/** What an expression editor needs: the stages it runs in, the keys it may reference, and its nesting depth. */
export type ExpressionContext = {
    stages: readonly ScenarioStage[];
    settingKeys: readonly string[];
    /** Each key's value descriptor: the setting list then offers only keys that give what the field expects. */
    descriptors?: Record<string, ScenarioValueDescriptor>;
    /** The value is worked out before a phase's overlay exists (a binding, a schedule): raw facts and base settings only. */
    baseOnly?: boolean;
    /** How many expressions sit above this one; the deepest level offers whole values only. */
    depth?: number;
};

/**
 * The facts this editor may offer: ones that run in every stage of the rule and give what is expected, and, before a
 * phase's overlay exists, only raw ones (a policy fact is derived from the effective settings).
 */
const eligibleFacts = (expected: ExprExpected, context: ExpressionContext): FactName[] =>
    vocabulary.FACT_NAMES.filter(
        (name) =>
            factGives(name, expected) &&
            (context.baseOnly !== true || FACTS[name].classification === 'raw') &&
            context.stages.every((stage) => FACTS[name].stages.includes(stage)),
    );

/** The setting keys this editor may offer: the context's, narrowed to the ones that give what is expected. */
const eligibleKeys = (expected: ExprExpected, context: ExpressionContext): string[] =>
    context.settingKeys.filter(
        (key) =>
            expected === 'any' ||
            context.descriptors === undefined ||
            expectedOfDescriptor(context.descriptors[key]) === expected,
    );

/** A literal's own kinds, by what the field needs: a quantity only a number, an untyped field every kind. */
const literalKindsOf = (expected: ExprExpected): readonly ('number' | 'boolean' | 'text' | 'list')[] => {
    if (expected === 'any') return ['number', 'boolean', 'text', 'list'];
    if (expected === 'boolean') return ['boolean'];
    if (expected === 'string') return ['text'];
    if (expected === 'list') return ['list'];
    return ['number'];
};

/** The kind a literal value currently is; undefined when the value is none of them (hand-edited JSON). */
const literalKindOf = (value: unknown): 'number' | 'boolean' | 'text' | 'list' | undefined => {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'text';
    if (Array.isArray(value)) return 'list';
    return undefined;
};

/** A setting key's label: its setting's name when the translations hold none for it. */
const settingLabel = (key: string, t: (key: string) => string): string => {
    const label = t(`app.${key}`);
    return label === `app.${key}` ? key : label;
};

/**
 * One literal, by its own kind: a number (with its quantity, and a unit when it is a duration), a yes/no, a text,
 * or a list of texts written comma-separated.
 */
function LiteralEditor({
    value,
    onChange,
    expected,
}: {
    value: Record<string, unknown>;
    onChange: (next: Record<string, unknown>) => void;
    expected: ExprExpected;
}) {
    const { t } = useTranslation();
    const kinds = literalKindsOf(expected);
    const kind = literalKindOf(value.value);
    const quantity = typeof value.quantity === 'string' ? value.quantity : 'count';
    return (
        <div className="space-y-1">
            {kinds.length > 1 && (
                <select
                    className={SELECT}
                    aria-label={t('app.sbLiteralKind')}
                    value={kind ?? ''}
                    onChange={(e) => {
                        const raw = e.currentTarget.value;
                        if (raw === 'number' || raw === 'boolean' || raw === 'text' || raw === 'list') {
                            // The select's 'text' is the plain string of a literal expression, and a number any
                            // quantity the field did not fix.
                            const expected: ExprExpected = raw === 'text' ? 'string' : raw === 'number' ? 'any' : raw;
                            onChange(defaultExpression('literal', expected, {}) as Record<string, unknown>);
                        }
                    }}
                >
                    {kind === undefined && <option value="">{t('app.sbPickType')}</option>}
                    {kinds.map((name) => (
                        <option key={name} value={name}>
                            {t(`app.sbLiteral_${name}`)}
                        </option>
                    ))}
                </select>
            )}
            {kind === 'number' && (
                <div className="flex gap-1">
                    <input
                        type="number"
                        className={CONTROL}
                        aria-label={t('app.sbField_value')}
                        value={value.value as number}
                        onChange={(e) => onChange({ ...value, value: Number(e.currentTarget.value) })}
                    />
                    {expected === 'any' && (
                        <select
                            className={SELECT}
                            aria-label={t('app.sbField_quantity')}
                            value={quantity}
                            onChange={(e) => {
                                const next = e.currentTarget.value;
                                onChange({
                                    ...value,
                                    quantity: next,
                                    ...(next === 'duration' && value.unit === undefined
                                        ? { unit: 'hours' as const }
                                        : {}),
                                    ...(next !== 'duration' ? { unit: undefined } : {}),
                                });
                            }}
                        >
                            {vocabulary.QUANTITIES.map((name) => (
                                <option key={name} value={name}>
                                    {t(`app.sbQuantity_${name}`)}
                                </option>
                            ))}
                        </select>
                    )}
                    {quantity === 'duration' && (
                        <select
                            className={SELECT}
                            aria-label={t('app.sbField_unit')}
                            value={typeof value.unit === 'string' ? value.unit : 'hours'}
                            onChange={(e) => onChange({ ...value, unit: e.currentTarget.value })}
                        >
                            {vocabulary.DURATION_UNITS.map((name) => (
                                <option key={name} value={name}>
                                    {t(`app.sbUnit_${name}`)}
                                </option>
                            ))}
                        </select>
                    )}
                </div>
            )}
            {kind === 'boolean' && (
                <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    aria-label={t('app.sbField_value')}
                    checked={value.value === true}
                    onChange={(e) => onChange({ kind: 'literal', value: e.currentTarget.checked })}
                />
            )}
            {kind === 'text' && (
                <input
                    type="text"
                    className={CONTROL}
                    aria-label={t('app.sbField_value')}
                    value={value.value as string}
                    onChange={(e) => onChange({ kind: 'literal', value: e.currentTarget.value })}
                />
            )}
            {kind === 'list' && (
                <input
                    type="text"
                    className={CONTROL}
                    aria-label={t('app.sbField_value')}
                    placeholder="sunset, night"
                    value={(value.value as string[]).join(', ')}
                    onChange={(e) =>
                        onChange({
                            kind: 'literal',
                            value: e.currentTarget.value
                                .split(',')
                                .map((part) => part.trim())
                                .filter((part) => part.length > 0),
                        })
                    }
                />
            )}
        </div>
    );
}

/** One labelled cell of the editor's field grid. */
function Cell({ label, children }: { label: string; children: ComponentChildren }) {
    return (
        <div role="group" aria-label={label} className="flex flex-col text-xs gap-1">
            <span className="opacity-70" aria-hidden="true">
                {label}
            </span>
            {children}
        </div>
    );
}

/**
 * One live value.
 */
export function ExpressionEditor({
    value,
    onChange,
    expected = 'any',
    context,
}: {
    value: unknown;
    onChange: (next: unknown) => void;
    /** What the value must give: a quantity, boolean / string / list, or anything. */
    expected?: ExprExpected;
    context: ExpressionContext;
}) {
    const { t } = useTranslation();
    const hintId = useId();
    const depth = context.depth ?? 0;
    const settingKeys = eligibleKeys(expected, context);
    // What the value must give decides the kinds; a fact or a setting is offered only when one can give it, and the deepest
    // expression may hold no other: only whole values are offered there.
    const offeredKinds = expressionKindsFor(expected).filter(
        (kind) =>
            (kind !== 'fact' || eligibleFacts(expected, context).length > 0) &&
            (kind !== 'setting' || settingKeys.length > 0) &&
            (depth < vocabulary.SCENARIO_CAPS.expressionDepth - 1 || !COMPOSITE_KINDS.has(kind)),
    );
    const item = (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<
        string,
        unknown
    >;
    const kind =
        typeof item.kind === 'string' && (EXPRESSION_KINDS as readonly string[]).includes(item.kind)
            ? (item.kind as (typeof EXPRESSION_KINDS)[number])
            : null;
    const stages = context.stages;
    const make = (next: (typeof EXPRESSION_KINDS)[number]) =>
        onChange(defaultExpression(next, expected, { stages, settingKeys, baseOnly: context.baseOnly }));
    const nested = (key: string, childExpected: ExprExpected) => (
        <ExpressionEditor
            value={item[key]}
            onChange={(next) => onChange({ ...item, [key]: next })}
            expected={childExpected}
            context={{ ...context, depth: depth + 1 }}
        />
    );

    return (
        <div className="rounded border border-base-300 bg-base-200 p-2 space-y-2">
            <select
                className={SELECT}
                aria-label={t('app.sbExprKind')}
                value={kind ?? ''}
                onChange={(e) => make(e.currentTarget.value as (typeof EXPRESSION_KINDS)[number])}
            >
                {kind === null && <option value="">{t('app.sbPickType')}</option>}
                {(kind === null || offeredKinds.includes(kind) ? offeredKinds : [kind, ...offeredKinds]).map((name) => (
                    <option key={name} value={name}>
                        {t(`app.sbExpr_${name}`)}
                    </option>
                ))}
            </select>
            {kind === null && (
                <p id={hintId} className="text-xs text-base-content/70">
                    {t('app.sbExprPickHint')}
                </p>
            )}
            {kind === 'literal' && <LiteralEditor value={item} onChange={onChange} expected={expected} />}
            {kind === 'fact' && (
                <div className="space-y-1">
                    <select
                        className={SELECT}
                        aria-label={t('app.sbField_name')}
                        value={
                            typeof item.name === 'string' &&
                            (vocabulary.FACT_NAMES as readonly string[]).includes(item.name)
                                ? item.name
                                : ''
                        }
                        onChange={(e) => onChange(factExpression(e.currentTarget.value, item))}
                    >
                        <option value="">{t('app.sbPickType')}</option>
                        {eligibleFacts(expected, context).map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                    {typeof item.name === 'string' && FACTS[item.name as FactName]?.takesSelect && (
                        <Cell label={t('app.sbField_select')}>
                            <ItemEditor
                                kind="selector"
                                value={item.select}
                                onChange={(next) => onChange({ ...item, select: next })}
                            />
                        </Cell>
                    )}
                    {typeof item.name === 'string' && FACTS[item.name as FactName]?.takesWindow && (
                        <Cell label={t('app.sbField_window')}>
                            <input
                                type="text"
                                className={CONTROL}
                                placeholder="1h"
                                aria-label={t('app.sbField_window')}
                                value={
                                    typeof item.window === 'string' || typeof item.window === 'number'
                                        ? String(item.window)
                                        : ''
                                }
                                onChange={(e) =>
                                    onChange({
                                        ...item,
                                        window: e.currentTarget.value === '' ? undefined : e.currentTarget.value,
                                    })
                                }
                            />
                        </Cell>
                    )}
                </div>
            )}
            {kind === 'setting' && (
                <div className="flex gap-1">
                    <select
                        className={SELECT}
                        aria-label={t('app.sbField_key')}
                        value={typeof item.key === 'string' ? item.key : ''}
                        onChange={(e) => onChange({ ...item, key: e.currentTarget.value })}
                    >
                        <option value="">{t('app.sbPickType')}</option>
                        {settingKeys.map((key) => (
                            <option key={key} value={key}>
                                {settingLabel(key, t)}
                            </option>
                        ))}
                    </select>
                    <select
                        className={SELECT}
                        aria-label={t('app.sbField_view')}
                        value={typeof item.view === 'string' ? item.view : 'base'}
                        onChange={(e) => onChange({ ...item, view: e.currentTarget.value })}
                    >
                        {vocabulary.SETTING_VIEWS.filter((view) => context.baseOnly !== true || view === 'base').map(
                            (view) => (
                                <option key={view} value={view}>
                                    {t(`app.sbView_${view}`)}
                                </option>
                            ),
                        )}
                    </select>
                </div>
            )}
            {kind === 'offset' && (
                <div className="space-y-1">
                    {nested('from', 'instant')}
                    {nested('by', 'duration')}
                    <select
                        className={SELECT}
                        aria-label={t('app.sbField_direction')}
                        value={typeof item.direction === 'string' ? item.direction : 'before'}
                        onChange={(e) => onChange({ ...item, direction: e.currentTarget.value })}
                    >
                        <option value="before">{t('app.sbOpt_direction_before')}</option>
                        <option value="after">{t('app.sbOpt_direction_after')}</option>
                    </select>
                </div>
            )}
            {kind === 'difference' && (
                <div className="space-y-1">
                    {nested('from', 'instant')}
                    {nested('to', 'instant')}
                </div>
            )}
            {(kind === 'add' || kind === 'subtract') && (
                <div className="space-y-1">
                    {nested('left', expected === 'any' ? 'duration' : expected)}
                    {nested('right', expected === 'any' ? 'duration' : expected)}
                </div>
            )}
            {(kind === 'earlier' || kind === 'later') && (
                <OperandList value={item} onChange={onChange} expected="instant" context={context} depth={depth} />
            )}
            {(kind === 'min' || kind === 'max') && (
                <OperandList
                    value={item}
                    onChange={onChange}
                    expected={expected === 'any' ? 'count' : expected}
                    context={context}
                    depth={depth}
                />
            )}
        </div>
    );
}

/**
 * The operand list of an aggregate (`earlier`, `later`, `min`, `max`): 2 to the vocabulary's cap, each a whole
 * expression of the kind's own quantity.
 */
function OperandList({
    value,
    onChange,
    expected,
    context,
    depth,
}: {
    value: Record<string, unknown>;
    onChange: (next: unknown) => void;
    expected: ExprExpected;
    context: ExpressionContext;
    depth: number;
}) {
    const { t } = useTranslation();
    const focus = useListFocus();
    const list = Array.isArray(value.of) ? value.of : [];
    const full = list.length >= vocabulary.SCENARIO_CAPS.aggregateOperands;
    return (
        <div className="space-y-1">
            {list.map((operand, index) => (
                <div key={index} {...focus.row} className="flex gap-1 items-start">
                    <div className="flex-1 min-w-0">
                        <ExpressionEditor
                            value={operand}
                            onChange={(next) =>
                                onChange({
                                    kind: value.kind,
                                    of: list.map((old, i) => (i === index ? next : old)),
                                })
                            }
                            expected={expected}
                            context={{ ...context, depth: depth + 1 }}
                        />
                    </div>
                    <button
                        type="button"
                        className="btn btn-sm btn-ghost text-error shrink-0"
                        {...focus.remove}
                        aria-label={t('app.actionOnItem', { action: t('app.sbRemove'), item: `${index + 1}` })}
                        disabled={list.length <= 2}
                        onClick={() => {
                            focus.afterRemove(index);
                            onChange({ kind: value.kind, of: list.filter((_, i) => i !== index) });
                        }}
                    >
                        {t('app.sbRemove')}
                    </button>
                </div>
            ))}
            <button
                type="button"
                className="btn btn-sm"
                {...focus.add}
                disabled={full}
                onClick={() => {
                    focus.afterAdd(list.length);
                    onChange({
                        kind: value.kind,
                        of: [...list, defaultExpression('literal', expected, { stages: context.stages })],
                    });
                }}
            >
                {t('app.sbAddOperand')}
            </button>
            {full && (
                <ToneNote tone="info" className="text-xs">
                    {t('app.sbOperandCap')}
                </ToneNote>
            )}
        </div>
    );
}
