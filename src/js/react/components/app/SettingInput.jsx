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
function TagsField({ settingKey, value, onChange, onReset, placeholder, disabled = false }) {
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
