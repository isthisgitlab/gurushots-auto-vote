import { useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { secondsToHoursMinutes, hoursMinutesToSeconds } from '@/utils/timeFieldUnits';
import { ResetButton } from '@/components/ui/ResetButton';

// Used only to fingerprint a tag array for the draft-sync effect. A comma is
// fine here: tagsTextToArray splits user input on commas before storage, so a
// stored tag can never itself contain one, making this a collision-free
// separator. Compare with '' (empty string) which would treat ['ab','c'] and
// ['a','bc'] as identical.
const TAGS_FINGERPRINT_SEP = ',';

const tagsArrayToText = (arr) => (Array.isArray(arr) ? arr.join(', ') : '');
const tagsTextToArray = (text) =>
    text
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

/**
 * Tag list editor. Tracks the raw text locally so the user can type
 * commas and trailing spaces without the array round-trip eating them
 * mid-keystroke. Re-syncs when the array prop is replaced from outside
 * (reset button, reload).
 */
export function TagsField({ settingKey, value, onChange, onReset, placeholder, disabled = false }) {
    const { t } = useTranslation();
    const arr = Array.isArray(value) ? value : [];
    const [draft, setDraft] = useState(() => tagsArrayToText(arr));

    // propKey is a stable primitive fingerprint of the array prop. It is the
    // only dependency: `arr` is a fresh reference each render (would fire the
    // effect every render) and is fully captured by propKey; `draft` is read
    // inside but we only want to re-sync when the *external* prop changes, not
    // on every keystroke. When the effect fires, the `arr` closed over matches
    // the propKey that triggered it, so reading it here is correct.
    const propKey = arr.join(TAGS_FINGERPRINT_SEP);
    useEffect(() => {
        if (tagsTextToArray(draft).join(TAGS_FINGERPRINT_SEP) !== propKey) {
            setDraft(tagsArrayToText(arr));
        }
    }, [propKey]);

    const handleChange = (e) => {
        setDraft(e.target.value);
        onChange(settingKey, tagsTextToArray(e.target.value));
    };

    return (
        <div className="flex items-center gap-2">
            <input
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
export function ScheduleField({ settingKey, value, onChange, onReset, disabled = false }) {
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

// Mirrors MAX_SCHEDULED_FILL_ENTRIES in settings/schema.js (renderer-bundle-safe
// module that can't import that zod-carrying file — change both together, same
// convention as SCHEDULE_MAX_SECONDS above).
export const SCHEDULED_FILL_MAX_ENTRIES = 6;

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
export function TimeOfDayListField({ settingKey, label, value, onChange, onReset, disabled = false }) {
    const { t } = useTranslation();
    // The cap slice also bounds rendering: a hand-edited oversized array must
    // not paint hundreds of rows (the write path and load-time bounds pass
    // both enforce the cap already — this is the same defensive posture as
    // the decision/cadence consumers).
    const arr = (Array.isArray(value) ? value : []).slice(0, SCHEDULED_FILL_MAX_ENTRIES);
    const [rows, setRows] = useState(() => arr.slice());

    const emittedOf = (rowList) => {
        const seen = new Set();
        return rowList.filter((row) => {
            if (row === '' || seen.has(row)) return false;
            seen.add(row);
            return true;
        });
    };

    const propKey = arr.join(',');
    useEffect(() => {
        if (emittedOf(rows).join(',') !== propKey) {
            setRows(arr.slice());
        }
    }, [propKey]);

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
export function TimeListField({ settingKey, label, value, onChange, onReset, disabled = false }) {
    const { t } = useTranslation();
    // Cap slice bounds rendering against hand-edited oversized arrays (see
    // TimeOfDayListField).
    const arr = (Array.isArray(value) ? value : []).slice(0, SCHEDULED_FILL_MAX_ENTRIES);
    const [rows, setRows] = useState(() => arr.slice());

    const emittedOf = (rowList) => {
        const seen = new Set();
        return rowList.filter((row) => {
            if (!(row > 0) || seen.has(row)) return false;
            seen.add(row);
            return true;
        });
    };

    const propKey = arr.join(',');
    useEffect(() => {
        if (emittedOf(rows).join(',') !== propKey) {
            setRows(arr.slice());
        }
    }, [propKey]);

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
 * Schema-driven input renderer for settings
 */
export function SettingInput({ settingKey, config, value, onChange, onReset, disabled = false }) {
    const { t } = useTranslation();

    // Guard against missing config
    if (!config) {
        return null;
    }

    // Normalize value to prevent uncontrolled-to-controlled transitions
    const normalizedValue = value ?? config.default ?? getDefaultForType(config.type);

    if (config.type === 'tags') {
        return (
            <TagsField
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
            <ScheduleField
                settingKey={settingKey}
                value={normalizedValue}
                onChange={onChange}
                onReset={onReset}
                disabled={disabled}
            />
        );
    }

    // Scheduled-fill daily times: variable list of native time pickers. The
    // values look device-local but are interpreted in the app timezone
    // setting — the surrounding modal renders a hint naming the zone.
    if (config.type === 'timeOfDayList') {
        return (
            <TimeOfDayListField
                settingKey={settingKey}
                label={t(config.label)}
                value={normalizedValue}
                onChange={onChange}
                onReset={onReset}
                disabled={disabled}
            />
        );
    }

    // Scheduled-fill before-end offsets: variable list of hours+minutes rows.
    if (config.type === 'timeList') {
        return (
            <TimeListField
                settingKey={settingKey}
                label={t(config.label)}
                value={normalizedValue}
                onChange={onChange}
                onReset={onReset}
                disabled={disabled}
            />
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

        return (
            <div className="flex items-center gap-2">
                <input
                    type="number"
                    className="input input-bordered input-sm w-20"
                    min="0"
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
        return (
            <div className="flex items-center gap-2">
                <input
                    type="number"
                    className="input input-bordered input-sm w-24"
                    min={config.min}
                    max={config.max}
                    value={normalizedValue}
                    onChange={(e) => onChange(settingKey, parseInt(e.target.value, 10) || 0)}
                    disabled={disabled}
                />
                {config.unit && <span className="text-sm">{t(config.unit)}</span>}
                {onReset && <ResetButton title={t('app.resetToDefaultNotSaved')} onClick={() => onReset(settingKey)} />}
            </div>
        );
    }

    // Default: text input
    return (
        <div className="flex items-center gap-2">
            <input
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
