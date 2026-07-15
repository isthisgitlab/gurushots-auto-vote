import { useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { secondsToHoursMinutes, hoursMinutesToSeconds } from '@/utils/timeFieldUnits';

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
            {onReset && (
                <button
                    className="btn btn-ghost btn-sm"
                    title={t('app.resetToDefaultNotSaved')}
                    onClick={() => onReset(settingKey)}
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                    </svg>
                </button>
            )}
        </div>
    );
}

// Bounds mirror the fillSchedule zod validator in settings/schema.js — the
// editor blocks what the schema would reject so a Save rarely fails validation.
const SCHEDULE_MIN_COUNT = 2;
const SCHEDULE_MAX_COUNT = 20;
const SCHEDULE_MAX_ROWS = 20;
const SCHEDULE_MAX_SECONDS = 30 * 24 * 3600; // mirrors MAX_SCHEDULE_SECONDS in the schema

const lowestUnusedScheduleCount = (rows) => {
    const used = new Set(rows.map((row) => row?.count));
    for (let count = SCHEDULE_MIN_COUNT; count <= SCHEDULE_MAX_COUNT; count++) {
        if (!used.has(count)) return count;
    }
    return null;
};

/**
 * Auto-fill schedule editor: one row per { count, seconds } step, meaning
 * "have ≥ count entries once ≤ seconds remain". Rows render in array order —
 * NOT live-sorted — so a row never jumps position mid-keystroke while its
 * count is being edited; the add button inserts at the sorted position
 * instead, which keeps a normally-edited list ordered. Duplicate counts and
 * out-of-range values (rejected by the schema) and dominated rows (legal but
 * dead under the max-based trigger) are flagged inline as the user types.
 */
export function ScheduleField({ settingKey, value, onChange, onReset, disabled = false }) {
    const { t } = useTranslation();
    const rows = Array.isArray(value) ? value : [];

    const updateRow = (index, patch) => {
        onChange(
            settingKey,
            rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
        );
    };
    const removeRow = (index) => {
        onChange(
            settingKey,
            rows.filter((_, i) => i !== index),
        );
    };

    const nextCount = lowestUnusedScheduleCount(rows);
    const addDisabled = disabled || rows.length >= SCHEDULE_MAX_ROWS || nextCount === null;
    const addRow = () => {
        if (addDisabled) return;
        // Insert at the sorted position (rows render in array order) so the
        // list stays ordered without ever re-sorting under the user's cursor.
        const insertAt = rows.findIndex((row) => (row?.count ?? 0) > nextCount);
        const next = [...rows];
        next.splice(insertAt === -1 ? rows.length : insertAt, 0, { count: nextCount, seconds: 3600 });
        onChange(settingKey, next);
    };

    const isDuplicate = (index) => rows.some((other, i) => i !== index && other?.count === rows[index]?.count);
    // Values the zod schema would reject at save time — flagged per-row so the
    // user sees WHICH row blocks the save, not just the generic save error.
    const isOutOfRange = (index) => {
        const row = rows[index];
        return (
            !Number.isInteger(row?.count) ||
            row.count < SCHEDULE_MIN_COUNT ||
            row.count > SCHEDULE_MAX_COUNT ||
            !Number.isInteger(row?.seconds) ||
            row.seconds < 0 ||
            row.seconds > SCHEDULE_MAX_SECONDS
        );
    };
    // A row is dead when another row reaches at least the same count no later
    // (larger-or-equal threshold): the max-based trigger then never needs it.
    const isDominated = (index) =>
        rows.some(
            (other, i) =>
                i !== index &&
                other?.count >= rows[index]?.count &&
                other?.seconds >= rows[index]?.seconds &&
                (other?.count > rows[index]?.count || other?.seconds > rows[index]?.seconds),
        );

    return (
        <div className="space-y-2">
            {rows.map((row, index) => {
                const { hours, minutes } = secondsToHoursMinutes(row?.seconds);
                const duplicate = isDuplicate(index);
                const outOfRange = !duplicate && isOutOfRange(index);
                const dominated = !duplicate && !outOfRange && isDominated(index);
                const hintId = duplicate || outOfRange || dominated ? `${settingKey}-row-${index}-hint` : undefined;
                return (
                    <div key={index} className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm">{t('app.autoFillScheduleImage')}</span>
                        <input
                            type="number"
                            className={`input input-bordered input-sm w-16 ${duplicate || outOfRange ? 'input-error' : ''}`}
                            min={SCHEDULE_MIN_COUNT}
                            max={SCHEDULE_MAX_COUNT}
                            aria-label={t('app.autoFillScheduleImageCount')}
                            aria-describedby={hintId}
                            value={row?.count ?? SCHEDULE_MIN_COUNT}
                            onChange={(e) => updateRow(index, { count: parseInt(e.target.value, 10) || 0 })}
                            disabled={disabled}
                        />
                        <span className="text-sm">≤</span>
                        <input
                            type="number"
                            className={`input input-bordered input-sm w-16 ${outOfRange ? 'input-error' : ''}`}
                            min="0"
                            max={SCHEDULE_MAX_SECONDS / 3600}
                            aria-label={t('app.hours')}
                            aria-describedby={hintId}
                            value={hours}
                            onChange={(e) =>
                                updateRow(index, {
                                    seconds: hoursMinutesToSeconds(parseInt(e.target.value, 10), minutes),
                                })
                            }
                            disabled={disabled}
                        />
                        <span className="text-sm">{t('app.hours')}</span>
                        <input
                            type="number"
                            className="input input-bordered input-sm w-16"
                            min="0"
                            max="59"
                            aria-label={t('app.minutes')}
                            aria-describedby={hintId}
                            value={minutes}
                            onChange={(e) =>
                                updateRow(index, {
                                    seconds: hoursMinutesToSeconds(hours, parseInt(e.target.value, 10)),
                                })
                            }
                            disabled={disabled}
                        />
                        <span className="text-sm">{t('app.minutes')}</span>
                        <button
                            className="btn btn-ghost btn-sm text-error"
                            title={t('app.autoFillScheduleRemoveStep')}
                            aria-label={t('app.autoFillScheduleRemoveStep')}
                            onClick={() => removeRow(index)}
                            disabled={disabled}
                        >
                            ×
                        </button>
                        <span aria-live="polite" id={hintId} className="text-xs">
                            {duplicate && <span className="text-error">{t('app.autoFillScheduleDuplicate')}</span>}
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
            {rows.length === 0 && (
                <div role="status" className="text-xs text-warning">
                    {t('app.autoFillScheduleEmpty')}
                </div>
            )}
            <div className="flex items-center gap-2">
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={addRow}
                    disabled={addDisabled}
                    title={addDisabled && !disabled ? t('app.autoFillScheduleAddDisabled') : undefined}
                >
                    + {t('app.autoFillScheduleAddStep')}
                </button>
                {onReset && (
                    <button
                        className="btn btn-ghost btn-sm"
                        title={t('app.resetToDefaultNotSaved')}
                        onClick={() => onReset(settingKey)}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                            />
                        </svg>
                    </button>
                )}
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
                {onReset && (
                    <button
                        className="btn btn-ghost btn-sm"
                        title={t('app.resetToDefaultNotSaved')}
                        onClick={() => onReset(settingKey)}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                            />
                        </svg>
                    </button>
                )}
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
                {onReset && (
                    <button
                        className="btn btn-ghost btn-sm"
                        title={t('app.resetToDefaultNotSaved')}
                        onClick={() => onReset(settingKey)}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                            />
                        </svg>
                    </button>
                )}
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
                {onReset && (
                    <button
                        className="btn btn-ghost btn-sm"
                        title={t('app.resetToDefaultNotSaved')}
                        onClick={() => onReset(settingKey)}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                            />
                        </svg>
                    </button>
                )}
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
            {onReset && (
                <button
                    className="btn btn-ghost btn-sm"
                    title={t('app.resetToDefaultNotSaved')}
                    onClick={() => onReset(settingKey)}
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                    </svg>
                </button>
            )}
        </div>
    );
}
