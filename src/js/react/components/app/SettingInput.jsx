import { useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useLatestRef } from '@/hooks/useLatestRef';
import { secondsToHoursMinutes, hoursMinutesToSeconds } from '@/utils/timeFieldUnits';
import { ResetButton } from '@/components/ui/ResetButton';
import { MAX_SCHEDULED_FILL_ENTRIES } from '../../../settings/limits';

// Used only to fingerprint a list value for the draft-sync hook below. A comma
// is fine here: tagsTextToArray splits user input on commas before storage, so
// a stored tag can never itself contain one, and the time lists hold "HH:MM"
// strings or integer seconds — a collision-free separator for all three.
// Compare with '' (empty string) which would treat ['ab','c'] and ['a','bc']
// as identical.
const LIST_FINGERPRINT_SEP = ',';

/**
 * Local draft for a list-valued setting. The draft re-syncs from `value` only
 * when the stored list's fingerprint changes AND the draft doesn't already
 * emit it, so an edit never gets overwritten by its own round-trip through
 * onChange, while an external replace (reset button, reload) does land.
 *
 * `toDraft(value)` builds the draft and `draftKeyOf(draft)` fingerprints what
 * the draft would emit; both must be module-level (stable) functions. The
 * value is read through a ref because it is a fresh array every render — the
 * fingerprint, not its identity, is what should re-trigger the sync.
 */
function useListDraft(value, toDraft, draftKeyOf) {
    const [draft, setDraft] = useState(() => toDraft(value));
    const valueRef = useLatestRef(value);
    const valueKey = value.join(LIST_FINGERPRINT_SEP);
    useEffect(() => {
        setDraft((current) => (draftKeyOf(current) === valueKey ? current : toDraft(valueRef.current)));
    }, [valueKey, valueRef, toDraft, draftKeyOf]);
    return [draft, setDraft];
}

// Setting types rendered as several controls (each with its own aria-label)
// rather than one: their caption names a role="group" wrapper instead of
// pointing a <label> at a single control.
const GROUP_TYPES = new Set(['time', 'schedule', 'timeOfDayList', 'timeList']);

/**
 * Caption for a setting control, shared by the global and per-challenge
 * settings modals. A single-control setting gets a real <label> tied to the
 * control by `inputId`; a multi-control one (`group`, derived from the schema
 * `type` for SettingInput) gets a caption whose id `${inputId}-label` names the
 * control group.
 */
export function SettingLabel({ inputId, type, group = GROUP_TYPES.has(type), children }) {
    if (group) {
        return (
            <div className="label" id={`${inputId}-label`}>
                {children}
            </div>
        );
    }
    return (
        <label className="label" htmlFor={inputId}>
            {children}
        </label>
    );
}

// Callers pass TagsField's already-normalised array, so no guard is needed here.
const tagsArrayToText = (arr) => arr.join(', ');
const tagsTextToArray = (text) =>
    text
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
const tagsDraftKey = (text) => tagsTextToArray(text).join(LIST_FINGERPRINT_SEP);

/**
 * Tag list editor. Tracks the raw text locally so the user can type
 * commas and trailing spaces without the array round-trip eating them
 * mid-keystroke. Re-syncs when the array prop is replaced from outside
 * (reset button, reload).
 */
export function TagsField({ id, settingKey, value, onChange, onReset, placeholder, disabled = false }) {
    const { t } = useTranslation();
    const arr = Array.isArray(value) ? value : [];
    const [draft, setDraft] = useListDraft(arr, tagsArrayToText, tagsDraftKey);

    const handleChange = (e) => {
        setDraft(e.target.value);
        onChange(settingKey, tagsTextToArray(e.target.value));
    };

    return (
        <div className="flex items-center gap-2">
            <input
                id={id}
                type="text"
                className="input input-bordered input-sm flex-1"
                placeholder={placeholder}
                value={draft}
                onChange={handleChange}
                disabled={disabled}
            />
            {onReset && <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />}
        </div>
    );
}

// The schedule covers images 2–4: entry 1 always exists (joining a challenge
// IS submitting a photo) and GuruShots challenges allow at most 4 images.
// The seconds cap mirrors MAX_SCHEDULE_SECONDS in settings/schema.js.
const SCHEDULE_COUNTS = [2, 3, 4];
const SCHEDULE_MAX_SECONDS = 30 * 24 * 3600;

/**
 * Auto-fill schedule editor: three FIXED rows — Image 2, Image 3, Image 4 —
 * each just a time-before-close ("have ≥ N entries once ≤ this much time
 * remains"). 0h 0m = off: that image gets no scheduled trigger of its own,
 * though it may still be filled while catching up to a later step (the
 * trigger is max-based). Emits only rows with seconds > 0, ordered by count,
 * so "all off" emits [] — the runtime's 'no-schedule' state. Rebuilding from
 * the three fixed slots is lossy by design: any stored row not keyed by
 * counts 2/3/4 is dropped on the first edit (the load-time sanitizer in
 * settings.js removes such rows anyway).
 */
function ScheduleField({ settingKey, value, onChange, onReset, disabled }) {
    const { t } = useTranslation();
    const rows = Array.isArray(value) ? value : [];
    const secondsFor = (count) => {
        const row = rows.find((r) => r && typeof r === 'object' && r.count === count);
        return Number.isFinite(row?.seconds) ? row.seconds : 0;
    };

    const emit = (count, seconds) => {
        const next = SCHEDULE_COUNTS.map((c) => ({ count: c, seconds: c === count ? seconds : secondsFor(c) })).filter(
            (row) => row.seconds > 0,
        );
        onChange(settingKey, next);
    };

    const activeRows = SCHEDULE_COUNTS.map((c) => ({ count: c, seconds: secondsFor(c) })).filter(
        (row) => row.seconds > 0,
    );
    // A row is dead when another ACTIVE row reaches at least the same count no
    // later (larger-or-equal threshold): the max-based trigger never needs it.
    // Off rows are excluded entirely — they show only the off hint, never a
    // dominated badge on top (a deliberate off state is not a mistake).
    const isDominated = (count, seconds) =>
        activeRows.some(
            (other) =>
                other.count >= count && other.seconds >= seconds && (other.count > count || other.seconds > seconds),
        );

    return (
        <div className="space-y-2">
            {SCHEDULE_COUNTS.map((count) => {
                const seconds = secondsFor(count);
                const { hours, minutes } = secondsToHoursMinutes(seconds);
                const off = seconds === 0;
                // Full bounds check, not just the cap: a hand-corrupted negative
                // or fractional value renders as 0h 0m (secondsToHoursMinutes
                // clamps) yet isn't `off`, so without this it would show a
                // spurious dominated badge instead of being flagged invalid.
                const outOfRange =
                    !off && (!Number.isInteger(seconds) || seconds < 0 || seconds > SCHEDULE_MAX_SECONDS);
                const dominated = !off && !outOfRange && isDominated(count, seconds);
                const hintId = `${settingKey}-row-${count}-hint`;
                const rowLabel = `${t('app.autoFillScheduleImage')} ${count}`;
                return (
                    <div key={count} className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm w-20">{rowLabel} ≤</span>
                        <input
                            type="number"
                            className={`input input-bordered input-sm w-16 ${outOfRange ? 'input-error' : ''}`}
                            min="0"
                            max={SCHEDULE_MAX_SECONDS / 3600}
                            aria-label={`${rowLabel} ${t('app.hours')}`}
                            aria-describedby={hintId}
                            value={hours}
                            onChange={(e) => emit(count, hoursMinutesToSeconds(parseInt(e.target.value, 10), minutes))}
                            disabled={disabled}
                        />
                        <span className="text-sm">{t('app.hours')}</span>
                        <input
                            type="number"
                            className={`input input-bordered input-sm w-16 ${outOfRange ? 'input-error' : ''}`}
                            min="0"
                            max="59"
                            aria-label={`${rowLabel} ${t('app.minutes')}`}
                            aria-describedby={hintId}
                            value={minutes}
                            onChange={(e) => emit(count, hoursMinutesToSeconds(hours, parseInt(e.target.value, 10)))}
                            disabled={disabled}
                        />
                        <span className="text-sm">{t('app.minutes')}</span>
                        <span aria-live="polite" id={hintId} className="text-xs">
                            {off && <span className="opacity-60">{t('app.autoFillScheduleOff')}</span>}
                            {outOfRange && <span className="text-error">{t('app.autoFillScheduleOutOfRange')}</span>}
                            {dominated && (
                                <span className="badge badge-warning badge-xs">
                                    {t('app.autoFillScheduleDominated')}
                                </span>
                            )}
                        </span>
                    </div>
                );
            })}
            {activeRows.length === 0 && (
                <div role="status" className="text-xs text-warning">
                    {t('app.autoFillScheduleEmpty')}
                </div>
            )}
            {onReset && (
                <div className="flex items-center gap-2">
                    <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />
                </div>
            )}
        </div>
    );
}

// Single source of truth: settings/limits.js is dependency-free, so importing
// it here costs the renderer bundle nothing (unlike settings/schema.js, which
// requires zod). Re-exported under the local name its consumers already use.
export const SCHEDULED_FILL_MAX_ENTRIES = MAX_SCHEDULED_FILL_ENTRIES;

// What a time-list draft emits: rows in order, dropping drafts (`isDraft`) and
// duplicates (first wins).
const emittedRowsOf = (rowList, isDraft) => {
    const seen = new Set();
    return rowList.filter((row) => {
        if (isDraft(row) || seen.has(row)) return false;
        seen.add(row);
        return true;
    });
};
// A blank time input is a draft; a 0-second (or non-positive) offset is too.
const emittedTimesOf = (rowList) => emittedRowsOf(rowList, (row) => row === '');
const emittedSecondsOf = (rowList) => emittedRowsOf(rowList, (row) => !(row > 0));
const timeOfDayDraftKey = (rows) => emittedTimesOf(rows).join(LIST_FINGERPRINT_SEP);
const timeListDraftKey = (rows) => emittedSecondsOf(rows).join(LIST_FINGERPRINT_SEP);
const copyRows = (arr) => arr.slice();

/**
 * Variable add/remove row-list editor for the scheduled-fill daily times
 * (`type: 'timeOfDayList'`): one native <input type="time"> per row. Row-list
 * structure follows TitleTagRulesEditor (the codebase's add/remove-row
 * precedent); draft sync follows TagsField's fingerprint pattern. Emission
 * drops empty rows (a just-added row stays a local draft, never emitting an
 * invalid '' entry) and dedupes first-wins so a duplicate row can't block
 * saving; the duplicate row itself is flagged inline. A11y: per-row hint ids
 * (ScheduleField-style — one shared region could only expose one row's text),
 * indexed aria-labels on the inputs AND the remove buttons, and a persistent
 * role="status" message at the entry cap (a disabled add button is skipped by
 * Tab, so its reason must be perceivable without hover).
 */
function TimeOfDayListField({ settingKey, label, value, onChange, onReset, disabled }) {
    const { t } = useTranslation();
    // The cap slice also bounds rendering: a hand-edited oversized array must
    // not paint hundreds of rows (the write path and load-time bounds pass
    // both enforce the cap already — this is the same defensive posture as
    // the decision/cadence consumers).
    const arr = (Array.isArray(value) ? value : []).slice(0, SCHEDULED_FILL_MAX_ENTRIES);
    const [rows, setRows] = useListDraft(arr, copyRows, timeOfDayDraftKey);
    const emittedOf = emittedTimesOf;

    const update = (nextRows) => {
        setRows(nextRows);
        onChange(settingKey, emittedOf(nextRows));
    };

    const atCap = rows.length >= SCHEDULED_FILL_MAX_ENTRIES;

    return (
        <div className="space-y-2">
            {rows.map((row, i) => {
                const duplicate = row !== '' && rows.indexOf(row) !== i;
                const hintId = `${settingKey}-row-${i}-hint`;
                return (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                        <input
                            type="time"
                            className={`input input-bordered input-sm w-32 ${duplicate ? 'input-error' : ''}`}
                            aria-label={`${label} ${i + 1}`}
                            aria-describedby={hintId}
                            value={row}
                            onChange={(e) => update(rows.map((r, j) => (j === i ? e.target.value : r)))}
                            disabled={disabled}
                        />
                        <button
                            className="btn btn-ghost btn-sm"
                            aria-label={`${t('app.scheduledFillRemoveEntry')} ${i + 1}`}
                            onClick={() => update(rows.filter((_, j) => j !== i))}
                            disabled={disabled}
                        >
                            ✕
                        </button>
                        {/* No draft hint here, unlike TimeListField: a blank native
                            time input visibly reads as empty, while a 0h 0m pair
                            over there looks like a filled, valid value. */}
                        <span aria-live="polite" id={hintId} className="text-xs">
                            {duplicate && <span className="text-error">{t('app.scheduledFillDuplicateEntry')}</span>}
                        </span>
                    </div>
                );
            })}
            <div className="flex items-center gap-2 flex-wrap">
                <button
                    className="btn btn-outline btn-sm"
                    onClick={() => update([...rows, ''])}
                    disabled={disabled || atCap}
                >
                    {t('app.scheduledFillAddTime')}
                </button>
                {rows.length === 0 && (
                    <span role="status" className="text-sm opacity-70">
                        {t('app.scheduledFillTimeOff')}
                    </span>
                )}
                {atCap && (
                    <span role="status" className="text-xs text-warning">
                        {t('app.scheduledFillMaxEntries').replace('{0}', String(SCHEDULED_FILL_MAX_ENTRIES))}
                    </span>
                )}
                {onReset && <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />}
            </div>
        </div>
    );
}

/**
 * Variable add/remove row-list editor for the scheduled-fill before-end
 * offsets (`type: 'timeList'`): one hours+minutes pair per row, each stored
 * as seconds. 0-second rows stay local drafts (ScheduleField's
 * emit-only-active precedent). Same dedupe/cap/a11y behavior as
 * TimeOfDayListField above.
 */
function TimeListField({ settingKey, label, value, onChange, onReset, disabled }) {
    const { t } = useTranslation();
    // Cap slice bounds rendering against hand-edited oversized arrays (see
    // TimeOfDayListField).
    const arr = (Array.isArray(value) ? value : []).slice(0, SCHEDULED_FILL_MAX_ENTRIES);
    const [rows, setRows] = useListDraft(arr, copyRows, timeListDraftKey);
    const emittedOf = emittedSecondsOf;

    const update = (nextRows) => {
        setRows(nextRows);
        onChange(settingKey, emittedOf(nextRows));
    };

    const atCap = rows.length >= SCHEDULED_FILL_MAX_ENTRIES;

    return (
        <div className="space-y-2">
            {rows.map((row, i) => {
                const seconds = Number.isFinite(row) ? row : 0;
                const { hours, minutes } = secondsToHoursMinutes(seconds);
                const duplicate = seconds > 0 && rows.indexOf(row) !== i;
                // ScheduleField's full bounds check (not just the ceiling):
                // the zod validator would reject the save with only the
                // generic "check the highlighted values" banner — so the
                // offending row must actually highlight. Negative/fractional
                // hand-edited values render as 0h 0m yet aren't drafts, so
                // without the full check they'd silently look like one.
                const outOfRange =
                    seconds !== 0 && (!Number.isInteger(seconds) || seconds < 0 || seconds > SCHEDULE_MAX_SECONDS);
                const rowError = duplicate || outOfRange;
                const hintId = `${settingKey}-row-${i}-hint`;
                const setRow = (nextSeconds) => update(rows.map((r, j) => (j === i ? nextSeconds : r)));
                return (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                        <input
                            type="number"
                            className={`input input-bordered input-sm w-16 ${rowError ? 'input-error' : ''}`}
                            min="0"
                            max={SCHEDULE_MAX_SECONDS / 3600}
                            aria-label={`${label} ${i + 1} ${t('app.hours')}`}
                            aria-describedby={hintId}
                            value={hours}
                            onChange={(e) => setRow(hoursMinutesToSeconds(parseInt(e.target.value, 10), minutes))}
                            disabled={disabled}
                        />
                        <span className="text-sm">{t('app.hours')}</span>
                        <input
                            type="number"
                            className={`input input-bordered input-sm w-16 ${rowError ? 'input-error' : ''}`}
                            min="0"
                            max="59"
                            aria-label={`${label} ${i + 1} ${t('app.minutes')}`}
                            aria-describedby={hintId}
                            value={minutes}
                            onChange={(e) => setRow(hoursMinutesToSeconds(hours, parseInt(e.target.value, 10)))}
                            disabled={disabled}
                        />
                        <span className="text-sm">{t('app.minutes')}</span>
                        <button
                            className="btn btn-ghost btn-sm"
                            aria-label={`${t('app.scheduledFillRemoveEntry')} ${i + 1}`}
                            onClick={() => update(rows.filter((_, j) => j !== i))}
                            disabled={disabled}
                        >
                            ✕
                        </button>
                        <span aria-live="polite" id={hintId} className="text-xs">
                            {seconds === 0 && <span className="opacity-60">{t('app.scheduledFillEntryDraft')}</span>}
                            {outOfRange && <span className="text-error">{t('app.autoFillScheduleOutOfRange')}</span>}
                            {duplicate && <span className="text-error">{t('app.scheduledFillDuplicateEntry')}</span>}
                        </span>
                    </div>
                );
            })}
            <div className="flex items-center gap-2 flex-wrap">
                <button
                    className="btn btn-outline btn-sm"
                    onClick={() => update([...rows, 0])}
                    disabled={disabled || atCap}
                >
                    {t('app.scheduledFillAddBeforeEnd')}
                </button>
                {rows.length === 0 && (
                    <span role="status" className="text-sm opacity-70">
                        {t('app.scheduledFillBeforeEndOff')}
                    </span>
                )}
                {atCap && (
                    <span role="status" className="text-xs text-warning">
                        {t('app.scheduledFillMaxEntries').replace('{0}', String(SCHEDULED_FILL_MAX_ENTRIES))}
                    </span>
                )}
                {onReset && <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />}
            </div>
        </div>
    );
}

/**
 * Get default value for a config type to prevent uncontrolled inputs
 */
function getDefaultForType(type) {
    switch (type) {
        case 'time':
        case 'number':
            return 0;
        case 'boolean':
            return false;
        case 'tags':
        case 'schedule':
        case 'timeOfDayList':
        case 'timeList':
            return [];
        default:
            return '';
    }
}

/**
 * Schema-driven input renderer for settings. `id` goes on the control a
 * SettingLabel with the same `inputId` points at; multi-control types instead
 * render a role="group" named by that caption (see SettingLabel).
 */
export function SettingInput({
    settingKey,
    config,
    value,
    onChange,
    onReset,
    disabled = false,
    id = `setting-${settingKey}`,
}) {
    const { t } = useTranslation();

    // Guard against missing config
    if (!config) {
        return null;
    }

    // Normalize value to prevent uncontrolled-to-controlled transitions
    const normalizedValue = value ?? config.default ?? getDefaultForType(config.type);
    const groupProps = { role: 'group', 'aria-labelledby': `${id}-label` };

    if (config.type === 'tags') {
        return (
            <TagsField
                id={id}
                settingKey={settingKey}
                value={normalizedValue}
                onChange={onChange}
                onReset={onReset}
                placeholder={t('app.tagsPlaceholder')}
                disabled={disabled}
            />
        );
    }

    if (config.type === 'schedule') {
        return (
            <div {...groupProps}>
                <ScheduleField
                    settingKey={settingKey}
                    value={normalizedValue}
                    onChange={onChange}
                    onReset={onReset}
                    disabled={disabled}
                />
            </div>
        );
    }

    // Scheduled-fill daily times: variable list of native time pickers. The
    // values look device-local but are interpreted in the app timezone
    // setting — the surrounding modal renders a hint naming the zone.
    if (config.type === 'timeOfDayList') {
        return (
            <div {...groupProps}>
                <TimeOfDayListField
                    settingKey={settingKey}
                    label={t(config.label)}
                    value={normalizedValue}
                    onChange={onChange}
                    onReset={onReset}
                    disabled={disabled}
                />
            </div>
        );
    }

    // Scheduled-fill before-end offsets: variable list of hours+minutes rows.
    if (config.type === 'timeList') {
        return (
            <div {...groupProps}>
                <TimeListField
                    settingKey={settingKey}
                    label={t(config.label)}
                    value={normalizedValue}
                    onChange={onChange}
                    onReset={onReset}
                    disabled={disabled}
                />
            </div>
        );
    }

    // Handle time type (hours + minutes). Stored as seconds.
    if (config.type === 'time') {
        const { hours, minutes } = secondsToHoursMinutes(normalizedValue);

        const handleHoursChange = (e) => {
            onChange(settingKey, hoursMinutesToSeconds(parseInt(e.target.value, 10), minutes));
        };

        const handleMinutesChange = (e) => {
            onChange(settingKey, hoursMinutesToSeconds(hours, parseInt(e.target.value, 10)));
        };

        const label = t(config.label);
        return (
            <div className="flex items-center gap-2" {...groupProps}>
                <input
                    type="number"
                    className="input input-bordered input-sm w-20"
                    min="0"
                    aria-label={`${label} ${t('app.hours')}`}
                    value={hours}
                    onChange={handleHoursChange}
                    disabled={disabled}
                />
                <span className="text-sm">{t('app.hours')}</span>
                <input
                    type="number"
                    className="input input-bordered input-sm w-20"
                    min="0"
                    max="59"
                    aria-label={`${label} ${t('app.minutes')}`}
                    value={minutes}
                    onChange={handleMinutesChange}
                    disabled={disabled}
                />
                <span className="text-sm">{t('app.minutes')}</span>
                {onReset && <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />}
            </div>
        );
    }

    // Handle boolean type (checkbox)
    if (config.type === 'boolean') {
        return (
            <div className="flex items-center gap-2">
                <input
                    id={id}
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={!!normalizedValue}
                    onChange={(e) => onChange(settingKey, e.target.checked)}
                    disabled={disabled}
                />
                {onReset && <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />}
            </div>
        );
    }

    // Handle number type
    if (config.type === 'number') {
        const hasMin = typeof config.min === 'number';
        const hasMax = typeof config.max === 'number';
        // An emptied field must count as invalid in its own right. `Number('')` is 0, so for
        // the settings whose min is 0 (exposureTarget, finalWindowExposureTarget, and the two
        // entry-slot indexes) a blank field otherwise looked in-range: no border, no message,
        // and Save then wrote '' straight through to zod, which rejects it — producing the
        // generic "check the highlighted values" banner with nothing highlighted, the exact
        // failure this was meant to end.
        const isBlank = normalizedValue === '' || normalizedValue === null || normalizedValue === undefined;
        const numericValue = Number(normalizedValue);
        const invalid =
            isBlank ||
            !Number.isFinite(numericValue) ||
            (hasMin && numericValue < config.min) ||
            (hasMax && numericValue > config.max);
        const rangeMessage =
            hasMin && hasMax
                ? t('app.validationOutOfRange').replace('{min}', config.min).replace('{max}', config.max)
                : hasMin
                  ? t('app.validationAtLeast').replace('{min}', config.min)
                  : t('app.validationInvalidValue');

        return (
            <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                    <input
                        id={id}
                        type="number"
                        className={`input input-bordered input-sm w-24 ${invalid ? 'input-error' : ''}`}
                        min={config.min}
                        max={config.max}
                        value={normalizedValue}
                        onChange={(e) => {
                            // Clearing the field used to write 0 via `parseInt(...) || 0`,
                            // which zod then rejected for min-1 keys like exposure — the user
                            // saw a save failure for a value they never typed. Keep an empty
                            // field empty and let the range check below explain it.
                            const raw = e.target.value;
                            if (raw === '') {
                                onChange(settingKey, '');
                                return;
                            }
                            const parsed = parseInt(raw, 10);
                            onChange(settingKey, Number.isNaN(parsed) ? '' : parsed);
                        }}
                        disabled={disabled}
                    />
                    {config.unit && <span className="text-sm">{t(config.unit)}</span>}
                    {onReset && (
                        <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />
                    )}
                </div>
                {invalid && <span className="text-error text-xs">{rangeMessage}</span>}
            </div>
        );
    }

    // Default: text input
    return (
        <div className="flex items-center gap-2">
            <input
                id={id}
                type="text"
                className="input input-bordered input-sm"
                value={normalizedValue}
                onChange={(e) => onChange(settingKey, e.target.value)}
                disabled={disabled}
            />
            {onReset && <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />}
        </div>
    );
}
