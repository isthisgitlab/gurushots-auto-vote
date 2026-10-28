/**
 * The shared cell of the two hours + minutes editors and the fractional-hours
 * draft pair: NumberUnitInput is one number input plus its unit text (the cell
 * HoursMinutesInputs in TimeSettingFields renders twice for durations stored
 * as seconds), and HoursMinutesDraftField edits a value stored as fractional
 * hours that may be blank (a rule's inherit, an unset setting).
 */

import { useTranslation } from '@/contexts/TranslationContext';
import { useLatestRef } from '@/hooks/useLatestRef';
import { secondsToHoursMinutes, hoursMinutesToSeconds } from '@/utils/timeFieldUnits';
import { MAX_JOIN_WINDOW_HOURS } from '../../../settings/limits';
import { SAVE_ERROR_ID } from '@/components/ui/ModalActionRow';

import { useEffect, useState } from 'react';

/**
 * One number input followed by its unit text — the cell both hours + minutes
 * editors render twice. `describedBy` arrives already resolved: each caller
 * keeps its own rule for when the described region is named.
 */
export function NumberUnitInput({
    value,
    onChange,
    max,
    unitKey,
    labelPrefix,
    className,
    invalid,
    rejected,
    describedBy,
    placeholder,
    disabled,
}: {
    value: string;
    onChange: (next: string) => void;
    max?: number;
    unitKey: 'app.hours' | 'app.minutes';
    labelPrefix: string;
    className: string;
    invalid?: boolean;
    rejected?: boolean;
    describedBy?: string;
    placeholder?: string;
    disabled?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <>
            <input
                type="number"
                className={className}
                min="0"
                max={max}
                aria-label={`${labelPrefix} ${t(unitKey)}`}
                aria-invalid={invalid || rejected || undefined}
                aria-describedby={describedBy}
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChange(e.currentTarget.value)}
                disabled={disabled}
            />
            <span className="text-sm">{t(unitKey)}</span>
        </>
    );
}

// undefined, null and '' are the same blank.
const asStoredHours = (value: number | '' | null | undefined): number | '' =>
    value === '' || value === null || value === undefined ? '' : value;

// What one draft string counts as. A non-integer, negative or NaN draft is
// clamped or floored exactly as hoursMinutesToSeconds does its arguments.
const parseCount = (draft: string): number => Math.floor(Number(draft) || 0);

// The clamped pair two drafts produce: parseCount's rules plus the total cap —
// at MAX_JOIN_WINDOW_HOURS the minutes have no room and are forced to 0.
const clampDraftPair = (hoursDraft: string, minutesDraft: string): { hours: number; minutes: number } => {
    const hours = Math.min(MAX_JOIN_WINDOW_HOURS, Math.max(0, parseCount(hoursDraft)));
    const minutes = hours >= MAX_JOIN_WINDOW_HOURS ? 0 : Math.max(0, Math.min(59, parseCount(minutesDraft)));
    return { hours, minutes };
};

// The stored value the drafts emit: both empty is the blank ('' = inherit),
// else fractional hours — hoursMinutesToSeconds' seconds ÷ 3600, capped.
const draftsToValue = (hoursDraft: string, minutesDraft: string): number | '' => {
    if (hoursDraft === '' && minutesDraft === '') return '';
    const { hours, minutes } = clampDraftPair(hoursDraft, minutesDraft);
    return Math.min(MAX_JOIN_WINDOW_HOURS, hoursMinutesToSeconds(hours, minutes) / 3600);
};

// The drafts a stored value shows. A blank renders empty inputs, so the off 0
// stays distinguishable from inherit; a number rounds to whole minutes — a
// non-zero window never rounds down to the off 0 — then splits as usual
// (secondsToHoursMinutes reads a NaN value as 0h 0m).
const draftsOfStored = (value: number | ''): { hours: string; minutes: string } => {
    if (value === '') return { hours: '', minutes: '' };
    let mins = Math.round(value * 60);
    if (value > 0 && mins === 0) mins = 1;
    const { hours, minutes } = secondsToHoursMinutes(mins * 60);
    return { hours: String(hours), minutes: String(minutes) };
};

/**
 * An hours + minutes pair editing one value stored as fractional hours that
 * may be blank (a rule's inherit, a challenge modal's unset setting).
 *
 * Unlike HoursMinutesInputs each input keeps its own STRING draft, so clearing
 * reaches the blank instead of coercing to 0: both drafts empty emit '', an
 * empty side counts as 0. The drafts re-sync from `value` only when it does
 * not equal what they produce (another rule, reset, reload — every blank form
 * treated alike); after a clamp the normalised string is written back to the
 * draft, so the inputs never show a value that is not stored (999 → 720,
 * 1.5 → 1). A NaN value never leaves the component.
 */
export function HoursMinutesDraftField({
    value,
    onChange,
    label,
    labelId,
    id,
    invalid,
    rejected,
    describedBy,
    placeholder,
    disabled,
}: {
    value: number | '' | null | undefined;
    onChange: (next: number | '') => void;
    /** Both inputs' aria-label prefix ("<label> hours" / "<label> minutes"). */
    label: string;
    /** The visible caption's id; the group carries aria-labelledby={labelId}. */
    labelId: string;
    /** Put on the group with tabIndex={-1}: what a refused Save focuses. */
    id?: string;
    invalid?: boolean;
    rejected?: boolean;
    describedBy?: string;
    placeholder?: string;
    disabled?: boolean;
}) {
    const [drafts, setDrafts] = useState(() => draftsOfStored(asStoredHours(value)));
    const draftsRef = useLatestRef(drafts);
    const incoming = asStoredHours(value);

    // Keyed on the stored value alone (the drafts ride in through the ref):
    // re-running on every keystroke would fight the in-flight draft against
    // the not-yet-updated prop, exactly what useListDraft avoids.
    useEffect(() => {
        const current = draftsRef.current;
        if (draftsToValue(current.hours, current.minutes) === incoming) return;
        setDrafts(draftsOfStored(incoming));
    }, [incoming, draftsRef]);

    const update = (side: 'hours' | 'minutes', raw: string) => {
        const raws = { ...drafts, [side]: raw };
        const pair = clampDraftPair(raws.hours, raws.minutes);
        // Write the clamped count back (999 → 720, 1.5 → 1); a cleared input
        // stays cleared — it is the blank, not a 0.
        const next = {
            hours: raws.hours === '' ? '' : String(pair.hours),
            minutes: raws.minutes === '' ? '' : String(pair.minutes),
        };
        setDrafts(next);
        onChange(draftsToValue(next.hours, next.minutes));
    };

    const className = `input input-sm w-16${invalid ? ' input-error' : ''}`;
    // The "inherit" placeholder names the blank: with one draft still holding
    // half of a real value, a placeholder would advertise inherit beside it.
    const shownPlaceholder = drafts.hours === '' && drafts.minutes === '' ? placeholder : undefined;
    return (
        <div
            {...(id ? { id, tabIndex: -1 } : {})}
            className="flex items-center gap-2"
            role="group"
            aria-labelledby={labelId}
            aria-describedby={rejected ? SAVE_ERROR_ID : undefined}
        >
            <NumberUnitInput
                value={drafts.hours}
                onChange={(raw) => update('hours', raw)}
                max={MAX_JOIN_WINDOW_HOURS}
                unitKey="app.hours"
                labelPrefix={label}
                className={className}
                invalid={invalid}
                rejected={rejected}
                describedBy={invalid ? describedBy : undefined}
                placeholder={shownPlaceholder}
                disabled={disabled}
            />
            <NumberUnitInput
                value={drafts.minutes}
                onChange={(raw) => update('minutes', raw)}
                max={59}
                unitKey="app.minutes"
                labelPrefix={label}
                className={className}
                invalid={invalid}
                rejected={rejected}
                describedBy={invalid ? describedBy : undefined}
                placeholder={shownPlaceholder}
                disabled={disabled}
            />
        </div>
    );
}
