import { useId } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import {
    CONDITION_FIELDS,
    ACTION_FIELDS,
    SELECTOR_FIELDS,
    CONDITION_TYPES,
    ACTION_TYPES,
    SELECTOR_TYPES,
    ENTRY_FIELDS,
    defaultCondition,
    defaultAction,
    defaultSelector,
    defaultFieldValue,
    defaultExpression,
    expectedOfDescriptor,
    DEFAULT_SETTING_KEY,
    automationOperationsFor,
} from '../../../../core/scenarios/builderSpec';
import {
    COMPARISON_OPS,
    CURRENCIES,
    BOOLEAN_ENTRY_FIELDS,
    STAGE_ACTIONS,
    CONDITION_STAGES,
    isOneOf,
} from '../../../../core/scenarios/vocabulary';
import { moveItem } from '../../../../core/scenarios/builderModel';
import { ExpressionEditor } from './ExpressionEditor';
import { useListFocus } from './listFocus';

import type { ListFocus } from './listFocus';
import type { ComponentChildren } from 'preact';
import type { FieldSpec } from '../../../../core/scenarios/builderSpec';
import type { ScenarioValueDescriptor } from '../../../../core/types/settings';
import type { ScenarioStage } from '../../../../core/types/scenario';
import type { ScenarioScope } from '../../../../core/types/settings';

type ValueChange = (next: unknown) => void;

/**
 * The scenario builder's generic form engine: one editor for any condition,
 * action or entry selector, rendered from the scenarios/builderSpec.ts table.
 * Every editor is controlled — `value` in, `onChange(next)` out — and never
 * validates; the real validator runs on save and on simulate.
 *
 * What the document's scope and the rule's stages allow decides which types
 * the selects offer (a condition must run in every stage, an action be
 * available in every one), which keys a setSetting step may change, and which
 * facts and settings a live value may read — so no option the backend refuses
 * is offered.
 */

const CONTROL = 'input input-sm w-full';
const SELECT = 'select select-sm w-full';

/** What the item editors need of the document and the rule they edit. */
export type BuilderScope = {
    scope: ScenarioScope;
    /** The stages the rule runs in; every offered type must hold in all of them. */
    stages: readonly ScenarioStage[];
    /** The keys a phase of this scope may write (the capability catalogue's phaseWrite). */
    writableKeys: readonly string[];
    /** The keys a live value may reference (read as a value with an expression form). */
    readableKeys: readonly string[];
    /** Each writable key's value descriptor, for the literal control of a setSetting value. */
    descriptors: Record<string, ScenarioValueDescriptor>;
    /** The stored scenario names a handoff may name. */
    scenarios: readonly string[];
    /** The saved profile names a useProfile step may name. */
    profiles: readonly string[];
};

/** A scope with nothing offered: the stages of a plain challenge rule, no keys, no names. */
export const EMPTY_SCOPE: BuilderScope = {
    scope: 'challenge',
    stages: ['active'],
    writableKeys: [],
    readableKeys: [],
    descriptors: {},
    scenarios: [],
    profiles: [],
};

/** A setting key's label: its setting's name when the translations hold none for it. */
const settingLabel = (key: string, t: (key: string) => string): string => {
    const label = t(`app.${key}`);
    return label === `app.${key}` ? key : label;
};

/** A literal the descriptor accepts, for a key whose value the user has not chosen yet. */
const descriptorDefault = (descriptor: ScenarioValueDescriptor | undefined): unknown => {
    switch (descriptor?.kind) {
        case 'boolean':
            return false;
        case 'number':
            return 0;
        case 'enum':
            return descriptor.values[0];
        case 'string':
            return '';
        case 'list':
            return [];
        default:
            return 0;
    }
};

/**
 * One labelled cell of an item's field grid — a named group, since a cell can
 * hold a whole nested editor; simple controls also carry the label themselves.
 */
function Field({ label, children }: { label: string; children: ComponentChildren }) {
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
 * A text input whose empty value means "leave the optional field out".
 */
function OptionalText({
    value,
    onChange,
    label,
    type = 'text',
    placeholder,
    describedBy,
}: {
    value: string | number | undefined;
    onChange: ValueChange;
    label: string;
    type?: 'text' | 'number';
    placeholder?: string;
    describedBy?: string;
}) {
    return (
        <input
            {...(type === 'number' ? { type: 'number' as const } : { type: 'text' as const })}
            aria-label={label}
            aria-describedby={describedBy}
            placeholder={placeholder}
            className={CONTROL}
            value={value ?? ''}
            onChange={(e) => {
                const raw = e.currentTarget.value;
                if (raw === '') onChange(undefined);
                else onChange(type === 'number' ? Number(raw) : raw);
            }}
        />
    );
}

/**
 * An optional duration, with an example of the notation and a caption naming the forms it takes.
 */
function DurationInput({
    value,
    onChange,
    label,
}: {
    value: string | number | undefined;
    onChange: ValueChange;
    label: string;
}) {
    const { t } = useTranslation();
    const hintId = useId();
    return (
        <>
            <OptionalText label={label} value={value} onChange={onChange} placeholder="1d 6h" describedBy={hintId} />
            <span id={hintId} className="text-base-content/70">
                {t('app.sbDurationHint')}
            </span>
        </>
    );
}

/**
 * "best" or a remembered photo (by memory slot).
 */
function PhotoSourceInput({ value, onChange, label }: { value: unknown; onChange: ValueChange; label: string }) {
    const { t } = useTranslation();
    const fromMemory = typeof value === 'object' && value !== null;
    return (
        <div className="flex gap-1">
            <select
                className={SELECT}
                aria-label={label}
                value={fromMemory ? 'memory' : 'best'}
                onChange={(e) => onChange(e.currentTarget.value === 'memory' ? { memory: 'held' } : 'best')}
            >
                <option value="best">{t('app.sbPhotoBest')}</option>
                <option value="memory">{t('app.sbPhotoMemory')}</option>
            </select>
            {fromMemory && (
                <input
                    type="text"
                    className={CONTROL}
                    aria-label={t('app.sbField_slot')}
                    value={(value as { memory?: string }).memory}
                    onChange={(e) => onChange({ memory: e.currentTarget.value })}
                />
            )}
        </div>
    );
}

/**
 * Boost / turbo states: any of the listed ones, labelled in words (the raw state is the tooltip).
 */
function StatesInput({
    value,
    options,
    labels,
    onChange,
}: {
    value: unknown;
    options: string[];
    labels: string | undefined;
    onChange: ValueChange;
}) {
    const { t } = useTranslation();
    const selected = new Set(Array.isArray(value) ? value : []);
    return (
        <div className="flex flex-wrap gap-2">
            {options.map((state) => (
                <label key={state} className="label cursor-pointer gap-1 p-0" title={state}>
                    <input
                        type="checkbox"
                        className="checkbox checkbox-xs"
                        checked={selected.has(state)}
                        onChange={(e) => {
                            const next = new Set(selected);
                            if (e.currentTarget.checked) next.add(state);
                            else next.delete(state);
                            onChange(options.filter((option) => next.has(option)));
                        }}
                    />
                    <span>{t(`app.sbState_${labels}_${state}`)}</span>
                </label>
            ))}
        </div>
    );
}

/**
 * A single-line input for one field; a number field reports a number, any other kind its text.
 */
function ValueInput({
    type,
    label,
    value,
    onChange,
}: {
    type: 'text' | 'number' | 'time';
    label: string;
    value: string | number | undefined;
    onChange: ValueChange;
}) {
    return (
        <input
            // A plain `type={type}` fails typecheck: preact's discriminated input props reject the
            // widened union (Type '"number" | "text" | "time"' is not assignable to type 'Signalish<"color" | …>').
            {...(type === 'number'
                ? { type: 'number' as const }
                : type === 'time'
                  ? { type: 'time' as const }
                  : { type: 'text' as const })}
            aria-label={label}
            className={CONTROL}
            value={value}
            onChange={(e) => onChange(type === 'number' ? Number(e.currentTarget.value) : e.currentTarget.value)}
        />
    );
}

/**
 * A select over a fixed list of choices; `onChange` gets the chosen option's raw text.
 */
function ChoiceSelect({
    label,
    value,
    choices,
    onChange,
}: {
    label: string;
    value: string | number | undefined;
    choices: { value: string | number; label: string | number }[];
    onChange: (raw: string) => void;
}) {
    return (
        <select aria-label={label} className={SELECT} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
            {choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                    {choice.label}
                </option>
            ))}
        </select>
    );
}

/**
 * A value a setSetting step writes: a literal in the setting's stored form (a control the key's
 * descriptor picks), or a live value worked out when the step runs.
 */
function SettingValueInput({
    item,
    value,
    onChange,
    scope,
    label,
}: {
    item: Record<string, unknown>;
    value: unknown;
    onChange: ValueChange;
    scope: BuilderScope;
    label: string;
}) {
    const { t } = useTranslation();
    const descriptor = scope.descriptors[String(item.key)] ?? scope.descriptors[DEFAULT_SETTING_KEY];
    const live = typeof value === 'object' && value !== null && !Array.isArray(value);
    // What a live value must give is what the setting takes (the validator's own typing of it): a yes/no setting a yes/no, a
    // percentage setting a percentage. A setting with no expression form can be given an untyped one, which the validator judges.
    const expected = expectedOfDescriptor(descriptor) ?? 'any';
    return (
        <div className="space-y-1">
            <select
                className={SELECT}
                aria-label={t('app.sbValueKind')}
                value={live ? 'live' : 'literal'}
                onChange={(e) =>
                    onChange(
                        e.currentTarget.value === 'live'
                            ? defaultExpression('literal', expected, {})
                            : descriptorDefault(descriptor),
                    )
                }
            >
                <option value="literal">{t('app.sbExpr_literal')}</option>
                <option value="live">{t('app.sbLiveValue')}</option>
            </select>
            {live ? (
                <ExpressionEditor
                    value={value}
                    onChange={onChange}
                    expected={expected}
                    context={{ stages: scope.stages, settingKeys: scope.readableKeys, descriptors: scope.descriptors }}
                />
            ) : (
                <LiteralByDescriptor label={label} descriptor={descriptor} value={value} onChange={onChange} />
            )}
        </div>
    );
}

/** A literal in a setting's stored form: the control its value descriptor picks. */
export function LiteralByDescriptor({
    label,
    descriptor,
    value,
    onChange,
}: {
    label: string;
    descriptor: ScenarioValueDescriptor | undefined;
    value: unknown;
    onChange: ValueChange;
}) {
    const { t } = useTranslation();
    switch (descriptor?.kind) {
        case 'boolean':
            return (
                <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    aria-label={label}
                    checked={value === true}
                    onChange={(e) => onChange(e.currentTarget.checked)}
                />
            );
        case 'enum':
            return (
                <ChoiceSelect
                    label={label}
                    value={String(value)}
                    choices={descriptor.values.map((option) => ({
                        value: option,
                        label: t(`app.${option}`) === `app.${option}` ? option : t(`app.${option}`),
                    }))}
                    onChange={(raw) => onChange(raw)}
                />
            );
        case 'string':
            return <ValueInput type="text" label={label} value={value as string} onChange={onChange} />;
        case 'list':
            return (
                <input
                    type="text"
                    className={CONTROL}
                    placeholder="a, b"
                    aria-label={label}
                    value={Array.isArray(value) ? value.join(', ') : ''}
                    onChange={(e) =>
                        onChange(
                            e.currentTarget.value
                                .split(',')
                                .map((part) => part.trim())
                                .filter((part) => part.length > 0),
                        )
                    }
                />
            );
        case 'other':
            return <ValueInput type="text" label={label} value={value as string} onChange={onChange} />;
        default:
            // A number, or a key with no descriptor the scope knows: a number input either way.
            return <ValueInput type="number" label={label} value={value as number} onChange={onChange} />;
    }
}

/**
 * One test an `entryCount` / `entriesWhere` list holds, over one entry field.
 */
function PredicateEditor({
    value,
    onChange,
    label,
    focus,
}: {
    value: unknown;
    onChange: ValueChange;
    label: string;
    focus: ListFocus;
}) {
    const { t } = useTranslation();
    const item = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const set = (next: Record<string, unknown>) => onChange({ ...item, ...next });
    const booleanField = isOneOf(BOOLEAN_ENTRY_FIELDS, item.field);
    return (
        <div role="group" aria-label={label} {...focus.row} className="flex flex-wrap gap-1 items-center">
            <ChoiceSelect
                label={t('app.sbField_field')}
                value={String(item.field ?? '')}
                choices={ENTRY_FIELDS.map((entryField) => ({
                    value: entryField,
                    label: t(`app.sbEntryField_${entryField}`),
                }))}
                onChange={(field) =>
                    set(
                        isOneOf(BOOLEAN_ENTRY_FIELDS, field)
                            ? { field, op: '=', value: true }
                            : { field, op: '>=', value: 0 },
                    )
                }
            />
            <ChoiceSelect
                label={t('app.sbField_op')}
                value={String(item.op ?? '>=')}
                choices={COMPARISON_OPS.map((op) => ({ value: op, label: op }))}
                onChange={(op) => set({ op })}
            />
            {booleanField ? (
                <ChoiceSelect
                    label={t('app.sbField_value')}
                    value={String(item.value)}
                    choices={[
                        { value: 'true', label: t('app.sbTrue') },
                        { value: 'false', label: t('app.sbFalse') },
                    ]}
                    onChange={(raw) => set({ value: raw === 'true' })}
                />
            ) : (
                <ValueInput
                    type="number"
                    label={t('app.sbField_value')}
                    value={item.value as number}
                    onChange={(value) => set({ value })}
                />
            )}
            <button
                type="button"
                className="btn btn-sm btn-ghost text-error"
                {...focus.remove}
                aria-label={label}
                onClick={() => onChange(undefined)}
            >
                {t('app.sbRemove')}
            </button>
        </div>
    );
}

/**
 * The list of entry tests an `entryCount` / `entriesWhere` condition (or a `matching` selector) holds.
 */
function PredicateList({ value, onChange }: { value: unknown; onChange: ValueChange }) {
    const { t } = useTranslation();
    const focus = useListFocus();
    const list = Array.isArray(value) ? value : [];
    return (
        <div className="space-y-1">
            {list.map((predicate, index) => (
                <PredicateEditor
                    key={index}
                    value={predicate}
                    label={t('app.actionOnItem', { action: t('app.sbRemove'), item: `${index + 1}` })}
                    focus={focus}
                    onChange={(next) => {
                        if (next === undefined) focus.afterRemove(index);
                        onChange(
                            next === undefined
                                ? list.filter((_, i) => i !== index)
                                : list.map((old, i) => (i === index ? next : old)),
                        );
                    }}
                />
            ))}
            <button
                type="button"
                className="btn btn-sm"
                {...focus.add}
                onClick={() => {
                    focus.afterAdd(list.length);
                    onChange([...list, { field: 'votes', op: '>=', value: 0 }]);
                }}
            >
                {t('app.sbAddPredicate')}
            </button>
        </div>
    );
}

/**
 * The input for one field, by its kind. `item` is the whole item (entryValue reads its field).
 */
function FieldInput({
    field,
    value,
    onChange,
    item,
    phases,
    scope,
    label,
}: {
    field: FieldSpec;
    value: unknown;
    onChange: ValueChange;
    item: Record<string, unknown>;
    phases: string[];
    scope: BuilderScope;
    label: string;
}) {
    const { t } = useTranslation();
    // The plain controls' value. Its type is whatever the field's kind puts
    // there, or anything at all in hand-edited JSON; the controls render it
    // as given and the validator judges it on save.
    const scalar = value as string | number | undefined;
    switch (field.kind) {
        case 'op':
            return (
                <ChoiceSelect
                    label={label}
                    value={scalar}
                    choices={COMPARISON_OPS.map((op) => ({ value: op, label: op }))}
                    onChange={onChange}
                />
            );
        case 'number':
        case 'percent':
            return field.optional ? (
                <OptionalText type="number" label={label} value={scalar} onChange={onChange} />
            ) : (
                <ValueInput type="number" label={label} value={scalar} onChange={onChange} />
            );
        case 'duration':
            return <DurationInput label={label} value={scalar} onChange={onChange} />;
        case 'slot':
            return field.optional ? (
                <OptionalText label={label} value={scalar} onChange={onChange} />
            ) : (
                <ValueInput type="text" label={label} value={scalar} onChange={onChange} />
            );
        case 'time':
            return <ValueInput type="time" label={label} value={scalar} onChange={onChange} />;
        case 'text':
        case 'photoId':
        case 'entryId':
            return <ValueInput type="text" label={label} value={scalar} onChange={onChange} />;
        case 'states':
            return (
                <StatesInput
                    value={value}
                    // Every 'states' field in builderSpec lists its options.
                    options={field.options as string[]}
                    labels={field.labels}
                    onChange={onChange}
                />
            );
        case 'currency':
            return (
                <ChoiceSelect
                    label={label}
                    value={scalar}
                    choices={CURRENCIES.map((currency) => ({
                        value: currency,
                        label: t(`app.sbCurrency_${currency}`),
                    }))}
                    onChange={onChange}
                />
            );
        case 'phase':
            return (
                <ChoiceSelect
                    label={label}
                    value={scalar}
                    choices={phases.map((phase) => ({ value: phase, label: phase }))}
                    onChange={onChange}
                />
            );
        case 'enum':
            return (
                <ChoiceSelect
                    label={label}
                    value={scalar}
                    choices={(field.labels === 'automation'
                        ? automationOperationsFor(scope.stages)
                        : (field.options as string[])
                    ).map((option) => ({
                        value: option,
                        label: t(`app.sbOpt_${field.labels}_${option}`),
                    }))}
                    onChange={onChange}
                />
            );
        case 'settingKey':
            return (
                <ChoiceSelect
                    label={label}
                    value={scalar}
                    choices={scope.writableKeys.map((key) => ({ value: key, label: settingLabel(key, t) }))}
                    onChange={onChange}
                />
            );
        case 'scenarioRef':
            return (
                <ChoiceSelect
                    label={label}
                    value={scalar ?? ''}
                    choices={[
                        { value: '', label: t('app.sbHandoffNone') },
                        ...scope.scenarios.map((name) => ({ value: name, label: name })),
                    ]}
                    onChange={(raw) => onChange(raw === '' ? null : raw)}
                />
            );
        case 'profileRef':
            return (
                <ChoiceSelect
                    label={label}
                    value={scalar ?? ''}
                    choices={[
                        { value: '', label: t('app.sbProfileNone') },
                        ...scope.profiles.map((name) => ({ value: name, label: name })),
                    ]}
                    onChange={(raw) => onChange(raw === '' ? null : raw)}
                />
            );
        case 'selector':
            return <ItemEditor kind="selector" value={value} onChange={onChange} />;
        case 'photoSource':
            return <PhotoSourceInput label={label} value={value} onChange={onChange} />;
        case 'entryField':
            return (
                <ChoiceSelect
                    label={label}
                    value={scalar}
                    choices={ENTRY_FIELDS.map((entryField) => ({
                        value: entryField,
                        label: t(`app.sbEntryField_${entryField}`),
                    }))}
                    onChange={onChange}
                />
            );
        case 'entryValue':
            return isOneOf(BOOLEAN_ENTRY_FIELDS, item.field) ? (
                <ChoiceSelect
                    label={label}
                    value={String(value)}
                    choices={[
                        { value: 'true', label: t('app.sbTrue') },
                        { value: 'false', label: t('app.sbFalse') },
                    ]}
                    onChange={(raw) => onChange(raw === 'true')}
                />
            ) : (
                <ValueInput type="number" label={label} value={scalar} onChange={onChange} />
            );
        case 'boolean':
            return (
                <input
                    type="checkbox"
                    aria-label={label}
                    className="checkbox checkbox-sm"
                    checked={value === true}
                    onChange={(e) => onChange(e.currentTarget.checked ? true : undefined)}
                />
            );
        case 'slotIndex':
            return (
                <ChoiceSelect
                    label={label}
                    value={scalar}
                    choices={[1, 2, 3, 4, 0].map((index) => ({
                        value: index,
                        label: index === 0 ? t('app.sbSlotLast') : index,
                    }))}
                    onChange={(raw) => onChange(Number(raw))}
                />
            );
        case 'predicates':
            return <PredicateList value={value} onChange={onChange} />;
        case 'settingValue':
            return <SettingValueInput item={item} value={value} onChange={onChange} scope={scope} label={label} />;
        case 'expression':
            return (
                <ExpressionEditor
                    value={value}
                    onChange={onChange}
                    expected={(field.quantity as never) ?? 'any'}
                    context={{ stages: scope.stages, settingKeys: scope.readableKeys, descriptors: scope.descriptors }}
                />
            );
        case 'conditions':
            return <ConditionList value={value} onChange={onChange} phases={phases} scope={scope} />;
        default:
            // 'condition' — one nested condition
            return <ItemEditor kind="condition" value={value} onChange={onChange} phases={phases} scope={scope} />;
    }
}

const KINDS = {
    condition: {
        table: CONDITION_FIELDS,
        key: 'type',
        types: CONDITION_TYPES,
        label: 'app.sbCond_',
        make: defaultCondition,
    },
    action: { table: ACTION_FIELDS, key: 'type', types: ACTION_TYPES, label: 'app.sbAct_', make: defaultAction },
    selector: { table: SELECTOR_FIELDS, key: 'by', types: SELECTOR_TYPES, label: 'app.sbSel_', make: defaultSelector },
} as const;

/**
 * The types offered for a kind under the rule's stages: a condition must run in every stage, an
 * action be available in every one; a selector is offered as it is.
 */
const offeredTypes = (kind: keyof typeof KINDS, scope: BuilderScope): string[] =>
    KINDS[kind].types.filter((type) => {
        if (kind === 'selector') return true;
        if (kind === 'condition') {
            const allowed = CONDITION_STAGES[type as keyof typeof CONDITION_STAGES];
            return (
                allowed === undefined || scope.stages.every((stage) => (allowed as readonly string[]).includes(stage))
            );
        }
        // An automation step must name an operation its stages allow: with none (a rule in both stages) it is not offered at all.
        if (type === 'runAutomation' && automationOperationsFor(scope.stages).length === 0) return false;
        return scope.stages.every((stage) => (STAGE_ACTIONS[stage] as readonly string[]).includes(type));
    });

/**
 * A new value for one field of `item`. Switching an entry condition between a
 * number field and a yes/no field also resets its comparison and value, which
 * the validator would otherwise reject; switching a setSetting key resets its
 * value to a literal the new key takes.
 */
const withField = (
    item: Record<string, unknown>,
    field: FieldSpec,
    next: unknown,
    scope: BuilderScope,
): Record<string, unknown> => {
    const updated = { ...item };
    if (next === undefined) delete updated[field.key];
    else updated[field.key] = next;
    if (
        field.kind === 'entryField' &&
        isOneOf(BOOLEAN_ENTRY_FIELDS, next) !== isOneOf(BOOLEAN_ENTRY_FIELDS, item.field)
    ) {
        const toBoolean = isOneOf(BOOLEAN_ENTRY_FIELDS, next);
        updated.op = toBoolean ? '=' : '>=';
        updated.value = toBoolean ? true : defaultFieldValue({ key: 'value', kind: 'entryValue' });
        if (toBoolean) delete updated.window;
    }
    // A type select only fires on a real change, so a settingKey change always brings a fresh value.
    if (field.kind === 'settingKey') {
        updated.value = descriptorDefault(scope.descriptors[String(next)]);
    }
    return updated;
};

/**
 * One condition, action or selector: its type, and its fields.
 */
export function ItemEditor({
    kind,
    value,
    onChange,
    phases = [],
    scope = EMPTY_SCOPE,
    controls = null,
    handoffAllowed = true,
}: {
    kind: keyof typeof KINDS;
    value: unknown;
    onChange: (next: Record<string, unknown>) => void;
    phases?: string[];
    scope?: BuilderScope;
    controls?: ComponentChildren;
    /** Whether this item may be a handoff: only the last step of its rule, and only one (the validator refuses any other). */
    handoffAllowed?: boolean;
}) {
    const { t } = useTranslation();
    const spec = KINDS[kind];
    const item = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const type = item[spec.key] as string;
    // An unknown type (hand-edited JSON) shows no fields until a known one is picked.
    const fields = spec.table[type] ?? [];
    const offered = offeredTypes(kind, scope).filter((name) => handoffAllowed || name !== 'handoffScenario');
    // The type the item has now is always listed, so the select shows what the item is.
    const options =
        offered.includes(type) || !(spec.types as readonly string[]).includes(type) ? offered : [type, ...offered];
    return (
        <div className={`rounded border border-base-300 p-2 space-y-2 ${kind === 'selector' ? 'bg-base-200' : ''}`}>
            <div className="flex flex-wrap gap-2 items-center">
                <select
                    className={`${SELECT} min-w-40 flex-1`}
                    aria-label={t('app.sbPickType')}
                    value={type}
                    onChange={(e) =>
                        onChange(
                            spec.make(e.currentTarget.value, {
                                phases,
                                stages: scope.stages,
                                settingKeys: scope.writableKeys,
                            }),
                        )
                    }
                >
                    {options.map((name) => (
                        <option key={name} value={name}>
                            {t(`${spec.label}${name}`)}
                        </option>
                    ))}
                </select>
                {controls}
            </div>
            {fields.length > 0 && (
                <div className="grid gap-2 sm:grid-cols-2">
                    {fields.map((field) => (
                        <Field key={field.key} label={t(`app.sbField_${field.key}`)}>
                            <FieldInput
                                field={field}
                                label={t(`app.sbField_${field.key}`)}
                                value={item[field.key]}
                                item={item}
                                phases={phases}
                                scope={scope}
                                onChange={(next) => onChange(withField(item, field, next, scope))}
                            />
                        </Field>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Remove / move buttons for one list item. `itemName` (what the item is, and its place in the list) goes into each
 * button's accessible name, since a list repeats the same three buttons per item.
 */
function ListControls({
    index,
    count,
    itemName,
    upBlocked,
    downBlocked,
    onMove,
    onRemove,
    removeMarks,
}: {
    index: number;
    count: number;
    itemName: string;
    /** The list's marks for a remove button (where the focus lands after a remove). */
    removeMarks: ListFocus['remove'];
    /** The item may not move up / down (a handoff stays the last step of its rule). */
    upBlocked: boolean;
    downBlocked: boolean;
    onMove: (delta: number) => void;
    onRemove: () => void;
}) {
    const { t } = useTranslation();
    const nameOf = (actionKey: string) => t('app.actionOnItem', { action: t(actionKey), item: itemName });
    return (
        <div className="flex gap-1 shrink-0">
            <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={index === 0 || upBlocked}
                aria-label={nameOf('app.sbMoveUp')}
                onClick={() => onMove(-1)}
            >
                <span aria-hidden="true">↑</span>
            </button>
            <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={index === count - 1 || downBlocked}
                aria-label={nameOf('app.sbMoveDown')}
                onClick={() => onMove(1)}
            >
                <span aria-hidden="true">↓</span>
            </button>
            <button
                type="button"
                className="btn btn-sm btn-ghost text-error"
                {...removeMarks}
                aria-label={nameOf('app.sbRemove')}
                onClick={onRemove}
            >
                {t('app.sbRemove')}
            </button>
        </div>
    );
}

/**
 * An editable list of conditions or actions, with add / move / remove.
 */
function ItemList({
    kind,
    value,
    onChange,
    phases,
    scope,
    addLabel,
}: {
    kind: 'condition' | 'action';
    value: unknown;
    onChange: (next: unknown[]) => void;
    phases: string[];
    scope: BuilderScope;
    addLabel: string;
}) {
    const { t } = useTranslation();
    const focus = useListFocus();
    const spec = KINDS[kind];
    const list: unknown[] = Array.isArray(value) ? value : [];
    // A handoff must be the last step of its rule: nothing is added after it or moved past it, and there is at most one.
    const isHandoff = (item: unknown) =>
        kind === 'action' && (item as Record<string, unknown> | null | undefined)?.type === 'handoffScenario';
    const handoffHeld = list.some(isHandoff);
    const offered = offeredTypes(kind, scope).filter((name) => !(handoffHeld && name === 'handoffScenario'));
    // "<type> <position>", e.g. "Boost an entry 2": names the item in its buttons.
    const itemName = (item: unknown, index: number) => {
        const type = (item as Record<string, unknown> | null | undefined)?.[spec.key];
        return `${typeof type === 'string' ? t(`${spec.label}${type}`) : ''} ${index + 1}`.trim();
    };
    return (
        <div className="space-y-2">
            {list.map((item, index) => (
                <ItemEditor
                    // Items have no identity of their own; the position is what the user edits.
                    key={`${index}:${(item as Record<string, unknown> | null | undefined)?.[spec.key]}`}
                    kind={kind}
                    value={item}
                    phases={phases}
                    scope={scope}
                    handoffAllowed={
                        index === list.length - 1 && !list.some((other, at) => at !== index && isHandoff(other))
                    }
                    onChange={(next) => onChange(list.map((old, i) => (i === index ? next : old)))}
                    controls={
                        <ListControls
                            index={index}
                            count={list.length}
                            itemName={itemName(item, index)}
                            upBlocked={isHandoff(item)}
                            downBlocked={isHandoff(list[index + 1])}
                            onMove={(delta) => onChange(moveItem(list, index, delta))}
                            removeMarks={focus.remove}
                            onRemove={() => {
                                focus.afterRemove(index);
                                onChange(list.filter((_, i) => i !== index));
                            }}
                        />
                    }
                />
            ))}
            <select
                className="select select-sm"
                {...focus.add}
                aria-label={t(addLabel)}
                value=""
                onChange={(e) => {
                    const added = spec.make(e.currentTarget.value, {
                        phases,
                        stages: scope.stages,
                        settingKeys: scope.writableKeys,
                    });
                    // A handoff at the end keeps the end: the new step goes before it.
                    const at = isHandoff(list[list.length - 1]) ? list.length - 1 : list.length;
                    onChange([...list.slice(0, at), added, ...list.slice(at)]);
                }}
            >
                <option value="">{t(addLabel)}</option>
                {offered.map((name) => (
                    <option key={name} value={name}>
                        {t(`${spec.label}${name}`)}
                    </option>
                ))}
            </select>
        </div>
    );
}

/**
 * A rule's (or an any/all group's) conditions.
 */
export function ConditionList({
    value,
    onChange,
    phases,
    scope = EMPTY_SCOPE,
}: {
    value: unknown;
    onChange: (next: unknown[]) => void;
    phases: string[];
    scope?: BuilderScope;
}) {
    return (
        <ItemList
            kind="condition"
            value={value}
            onChange={onChange}
            phases={phases}
            scope={scope}
            addLabel="app.sbAddCondition"
        />
    );
}

/**
 * A rule's actions, in order.
 */
export function ActionList({
    value,
    onChange,
    phases,
    scope = EMPTY_SCOPE,
}: {
    value: unknown;
    onChange: (next: unknown[]) => void;
    phases: string[];
    scope?: BuilderScope;
}) {
    return (
        <ItemList
            kind="action"
            value={value}
            onChange={onChange}
            phases={phases}
            scope={scope}
            addLabel="app.sbAddAction"
        />
    );
}
