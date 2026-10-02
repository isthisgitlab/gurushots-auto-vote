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
} from '../../../../scenarios/builderSpec';
import { COMPARISON_OPS, CURRENCIES, BOOLEAN_ENTRY_FIELDS, isOneOf } from '../../../../scenarios/vocabulary';
import { moveItem } from '../../../../scenarios/builderModel';

import type { ComponentChildren } from 'preact';
import type { FieldSpec } from '../../../../scenarios/builderSpec';

type ValueChange = (next: unknown) => void;

/**
 * The scenario builder's generic form engine: one editor for any condition,
 * action or entry selector, rendered from the scenarios/builderSpec.ts table.
 * Every editor is controlled — `value` in, `onChange(next)` out — and never
 * validates; the real validator runs on save and on simulate.
 */

const CONTROL = 'input input-sm input-bordered w-full';
const SELECT = 'select select-sm select-bordered w-full';

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
}: {
    value: string | number | undefined;
    onChange: ValueChange;
    label: string;
    type?: 'text' | 'number';
}) {
    return (
        <input
            {...(type === 'number' ? { type: 'number' as const } : { type: 'text' as const })}
            aria-label={label}
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
 * The input for one field, by its kind. `item` is the whole item (entryValue reads its field).
 */
function FieldInput({
    field,
    value,
    onChange,
    item,
    phases,
    label,
}: {
    field: FieldSpec;
    value: unknown;
    onChange: ValueChange;
    item: Record<string, unknown>;
    phases: string[];
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
        case 'slot':
            return field.optional ? (
                <OptionalText label={label} value={scalar} onChange={onChange} />
            ) : (
                <ValueInput type="text" label={label} value={scalar} onChange={onChange} />
            );
        case 'time':
            return <ValueInput type="time" label={label} value={scalar} onChange={onChange} />;
        case 'text':
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
        case 'conditions':
            return <ConditionList value={value} onChange={onChange} phases={phases} />;
        default:
            // 'condition' — one nested condition
            return <ItemEditor kind="condition" value={value} onChange={onChange} phases={phases} />;
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
};

/**
 * A new value for one field of `item`. Switching an entry condition between a
 * number field and a yes/no field also resets its comparison and value, which
 * the validator would otherwise reject.
 */
const withField = (item: Record<string, unknown>, field: FieldSpec, next: unknown): Record<string, unknown> => {
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
    controls = null,
}: {
    kind: keyof typeof KINDS;
    value: unknown;
    onChange: (next: Record<string, unknown>) => void;
    phases?: string[];
    controls?: ComponentChildren;
}) {
    const { t } = useTranslation();
    const spec = KINDS[kind];
    const item = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const type = item[spec.key] as string;
    // An unknown type (hand-edited JSON) shows no fields until a known one is picked.
    const fields = spec.table[type] ?? [];
    return (
        <div className={`rounded border border-base-300 p-2 space-y-2 ${kind === 'selector' ? 'bg-base-200' : ''}`}>
            <div className="flex gap-2 items-center">
                <select
                    className={SELECT}
                    aria-label={t('app.sbPickType')}
                    value={type}
                    onChange={(e) => onChange(spec.make(e.currentTarget.value, { phases }))}
                >
                    {spec.types.map((name) => (
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
                                onChange={(next) => onChange(withField(item, field, next))}
                            />
                        </Field>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Remove / move buttons for one list item.
 */
function ListControls({
    index,
    count,
    onMove,
    onRemove,
}: {
    index: number;
    count: number;
    onMove: (delta: number) => void;
    onRemove: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex gap-1 shrink-0">
            <button type="button" className="btn btn-xs btn-ghost" disabled={index === 0} onClick={() => onMove(-1)}>
                <span aria-hidden="true">↑</span>
                <span className="sr-only">{t('app.sbMoveUp')}</span>
            </button>
            <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={index === count - 1}
                onClick={() => onMove(1)}
            >
                <span aria-hidden="true">↓</span>
                <span className="sr-only">{t('app.sbMoveDown')}</span>
            </button>
            <button type="button" className="btn btn-xs btn-ghost text-error" onClick={onRemove}>
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
    addLabel,
}: {
    kind: 'condition' | 'action';
    value: unknown;
    onChange: (next: unknown[]) => void;
    phases: string[];
    addLabel: string;
}) {
    const { t } = useTranslation();
    const spec = KINDS[kind];
    const list: unknown[] = Array.isArray(value) ? value : [];
    return (
        <div className="space-y-2">
            {list.map((item, index) => (
                <ItemEditor
                    // Items have no identity of their own; the position is what the user edits.
                    key={`${index}:${(item as Record<string, unknown> | null | undefined)?.[spec.key]}`}
                    kind={kind}
                    value={item}
                    phases={phases}
                    onChange={(next) => onChange(list.map((old, i) => (i === index ? next : old)))}
                    controls={
                        <ListControls
                            index={index}
                            count={list.length}
                            onMove={(delta) => onChange(moveItem(list, index, delta))}
                            onRemove={() => onChange(list.filter((_, i) => i !== index))}
                        />
                    }
                />
            ))}
            <select
                className="select select-xs select-bordered"
                aria-label={t(addLabel)}
                value=""
                onChange={(e) => onChange([...list, spec.make(e.currentTarget.value, { phases })])}
            >
                <option value="">{t(addLabel)}</option>
                {spec.types.map((name) => (
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
}: {
    value: unknown;
    onChange: (next: unknown[]) => void;
    phases: string[];
}) {
    return (
        <ItemList kind="condition" value={value} onChange={onChange} phases={phases} addLabel="app.sbAddCondition" />
    );
}

/**
 * A rule's actions, in order.
 */
export function ActionList({
    value,
    onChange,
    phases,
}: {
    value: unknown;
    onChange: (next: unknown[]) => void;
    phases: string[];
}) {
    return <ItemList kind="action" value={value} onChange={onChange} phases={phases} addLabel="app.sbAddAction" />;
}
