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
                </div>
            )}
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
