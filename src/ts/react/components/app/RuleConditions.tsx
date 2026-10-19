import { useEffect, useId, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ToneNote } from '@/components/ui/ToneNote';
import { RuleNumberField } from './RuleFields';
import { normalizeRuleClosesAt } from '../../../settings/challengeRules';

import type { LooseRecord, TitleRule } from '../../../types/settings';
import type { RulePatchHandler } from './RuleFields';

/**
 * Photo counts a rule may be keyed on. GuruShots challenges carry at most four
 * submissions, and the settings sanitizer bounds the stored value independently
 * — this list only decides what the dropdown offers.
 */
const PICS_CHOICES = [1, 2, 3, 4];

// Mirrors MAX_RULE_RUNTIME_HOURS in settings/challengeRules.ts; the sanitizer is
// the real gate.
const MAX_RUNTIME_HOURS = 2000;

// Runtime-range conditions: any-length when blank.
const RUNTIME_FIELDS = [
    { settingKey: 'minHours', labelKey: 'app.titleRuleMinHours' },
    { settingKey: 'maxHours', labelKey: 'app.titleRuleMaxHours' },
].map((field) => ({
    ...field,
    unitKey: 'app.unitHours',
    placeholderKey: 'app.titleRuleAnyLength',
    min: 1,
    max: MAX_RUNTIME_HOURS,
}));

// Mirrors MAX_CLOSE_TIMES_PER_RULE in settings/titleRuleSanitize.ts; the sanitizer is the real gate.
const MAX_CLOSE_TIMES = 24;

// The editable end-time list of a rule, read the way the matcher reads it (normalizeRuleCloseTimes): the list
// when it holds an entry that is not blank (a non-text entry counts, and shows as an invalid row), else
// `closesAt`. Stored rules carry `closesAtTimes` only when they list more than one, `closesAt` mirroring the
// first. Always at least one row so a fresh rule shows an input. A list of two or more blank rows with a blank
// `closesAt` is the editor's own (Add time on a blank row, or a cleared row): the matcher reads it as any time,
// as it reads one blank row, so the rows stay on screen.
const closeTimeRows = (rule: TitleRule): { rows: unknown[]; fromList: boolean } => {
    const list: unknown = rule.closesAtTimes;
    const fromList =
        Array.isArray(list) &&
        (list.some((entry) => typeof entry !== 'string' || entry.trim() !== '') ||
            (list.length > 1 && (rule.closesAt ?? '') === ''));
    return { rows: fromList ? list : [rule.closesAt ?? ''], fromList };
};

// A `closesAtTimes` that is present but not a list makes the rule match nothing, whatever `closesAt` says.
const hasMalformedList = (rule: TitleRule): boolean => {
    const list: unknown = rule.closesAtTimes;
    return list !== undefined && list !== null && !Array.isArray(list);
};

// Patch for a new time list. `closesAt` follows the first row so the saved shape stays readable by single-time
// code; the list is only kept for two or more rows, so cutting back to one leaves none behind, and no rows
// leaves neither field. The sanitizer drops blank rows.
const closeTimesPatch = (times: string[]): LooseRecord => ({
    closesAt: times[0],
    closesAtTimes: times.length > 1 ? times : undefined,
});

// A saved row that is not a strict HH:MM (a hand-edited file) renders blank in a time input, while the rule
// matches nothing and saving is rejected: the row says so in text, not only colour. A blank row is a new one.
const isInvalidTime = (row: unknown, trimmed: boolean): boolean =>
    normalizeRuleClosesAt(trimmed && typeof row === 'string' ? row.trim() : row) === false;

function CloseTimeRow({
    value,
    invalid,
    index,
    count,
    onChange,
    onRemove,
}: {
    value: string;
    invalid: boolean;
    index: number;
    count: number;
    onChange: (time: string) => void;
    onRemove: () => void;
}) {
    const { t } = useTranslation();
    const messageId = useId();
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
                <input
                    type="time"
                    className={`input input-sm min-w-32 flex-1 ${invalid ? 'input-error' : ''}`}
                    aria-invalid={invalid ? 'true' : undefined}
                    aria-describedby={invalid ? messageId : undefined}
                    aria-label={`${t('app.titleRuleClosesAtRow')} ${index + 1} ${t('app.of')} ${count}`}
                    value={value}
                    onChange={(e) => onChange(e.currentTarget.value)}
                />
                {(count > 1 || invalid) && (
                    <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        title={t('app.removeCloseTime')}
                        aria-label={`${t('app.removeCloseTime')} ${index + 1}`}
                        onClick={onRemove}
                    >
                        ×
                    </button>
                )}
            </div>
            {invalid && (
                <ToneNote tone="error" as="span" id={messageId} className="text-xs">
                    {t('app.titleRuleClosesAtInvalid')}
                </ToneNote>
            )}
        </div>
    );
}

// The end times the challenge card shows (app timezone, any date); closing at any one is enough; blank = any time.
function RuleClosesAtField({ rule, onPatch }: { rule: TitleRule; onPatch: RulePatchHandler }) {
    const { t } = useTranslation();
    const { rows, fromList } = closeTimeRows(rule);
    // The matcher trims a listed time, and reads the single one as it is.
    const times = rows.map((row) => (typeof row === 'string' ? (fromList ? row.trim() : row) : ''));
    const malformedList = hasMalformedList(rule);
    const listRef = useRef<HTMLDivElement>(null);
    const addRef = useRef<HTMLButtonElement>(null);
    // Where focus goes once a removed row is gone: the row that took its place, else Add time.
    const focusAfterRemove = useRef<number | null>(null);
    useEffect(() => {
        const at = focusAfterRemove.current;
        if (at === null) return;
        focusAfterRemove.current = null;
        const inputs = listRef.current?.querySelectorAll<HTMLInputElement>('input[type="time"]');
        (inputs?.[at] ?? addRef.current)?.focus();
    });
    return (
        <div ref={listRef} className="flex flex-col gap-1">
            <span className="text-sm">{t('app.titleRuleClosesAt')}</span>
            {rows.map((row, index) => (
                // Index key: rows are only appended or removed, and the input is controlled.
                <CloseTimeRow
                    key={index}
                    value={times[index]}
                    invalid={isInvalidTime(row, fromList) || (malformedList && index === 0)}
                    index={index}
                    count={rows.length}
                    onChange={(next) => onPatch(closeTimesPatch(times.map((time, i) => (i === index ? next : time))))}
                    onRemove={() => {
                        focusAfterRemove.current = index;
                        onPatch(closeTimesPatch(times.filter((_, i) => i !== index)));
                    }}
                />
            ))}
            <button
                ref={addRef}
                type="button"
                className="btn btn-outline btn-sm self-start"
                disabled={rows.length >= MAX_CLOSE_TIMES}
                onClick={() => onPatch(closeTimesPatch([...times, '']))}
            >
                + {t('app.addCloseTime')}
            </button>
        </div>
    );
}

export function RuleClassConditions({ rule, onPatch }: { rule: TitleRule; onPatch: RulePatchHandler }) {
    const { t } = useTranslation();
    return (
        <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
                <span className="text-sm">{t('app.titleRuleChallengeTag')}</span>
                <input
                    type="text"
                    className="input input-sm w-full"
                    placeholder={t('app.titleRuleChallengeTagPlaceholder')}
                    aria-label={t('app.titleRuleChallengeTag')}
                    value={rule.challengeTag ?? ''}
                    onChange={(e) => onPatch({ challengeTag: e.currentTarget.value })}
                />
            </div>
            <div className="flex flex-col gap-1">
                <span className="text-sm">{t('app.titleRuleType')}</span>
                <input
                    type="text"
                    list="gs-rule-types"
                    className="input input-sm w-full"
                    placeholder={t('app.titleRuleTypePlaceholder')}
                    aria-label={t('app.titleRuleType')}
                    value={rule.type ?? ''}
                    onChange={(e) => onPatch({ type: e.currentTarget.value })}
                />
            </div>
            <div className="flex flex-col gap-1">
                <span className="text-sm">{t('app.titleRulePics')}</span>
                <select
                    aria-label={t('app.titleRulePics')}
                    className="select select-sm w-full"
                    value={String(rule.pics ?? '')}
                    onChange={(event) => {
                        const next = event.currentTarget.value;
                        onPatch({ pics: next === '' ? '' : Number(next) });
                    }}
                >
                    <option value="">{t('app.titleRuleAnyPics')}</option>
                    {PICS_CHOICES.map((count) => (
                        <option key={count} value={count}>
                            {count}
                        </option>
                    ))}
                </select>
            </div>
            <RuleClosesAtField rule={rule} onPatch={onPatch} />
            <div className="grid grid-cols-2 gap-2">
                {RUNTIME_FIELDS.map((field) => (
                    <RuleNumberField key={field.settingKey} {...field} rule={rule} onPatch={onPatch} />
                ))}
            </div>
        </div>
    );
}
