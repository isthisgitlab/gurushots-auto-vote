import { useTranslation } from '@/contexts/TranslationContext';
import { secondsToHoursMinutes, hoursMinutesToSeconds } from '@/utils/timeFieldUnits';

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
    default:
        return '';
    }
}

/**
 * Schema-driven input renderer for settings
 */
export function SettingInput({ settingKey, config, value, onChange, onReset }) {
    const { t } = useTranslation();

    // Guard against missing config
    if (!config) {
        return null;
    }

    // Normalize value to prevent uncontrolled-to-controlled transitions
    const normalizedValue = value ?? config.default ?? getDefaultForType(config.type);

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
                />
                <span className="text-sm">{t('app.hours')}</span>
                <input
                    type="number"
                    className="input input-bordered input-sm w-20"
                    min="0"
                    max="59"
                    value={minutes}
                    onChange={handleMinutesChange}
                />
                <span className="text-sm">{t('app.minutes')}</span>
                {onReset && (
                    <button
                        className="btn btn-ghost btn-sm"
                        title={t('app.resetToDefaultNotSaved')}
                        onClick={() => onReset(settingKey)}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
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
                />
                {onReset && (
                    <button
                        className="btn btn-ghost btn-sm"
                        title={t('app.resetToDefaultNotSaved')}
                        onClick={() => onReset(settingKey)}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
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
                />
                {config.unit && <span className="text-sm">{t(config.unit)}</span>}
                {onReset && (
                    <button
                        className="btn btn-ghost btn-sm"
                        title={t('app.resetToDefaultNotSaved')}
                        onClick={() => onReset(settingKey)}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
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
            />
            {onReset && (
                <button
                    className="btn btn-ghost btn-sm"
                    title={t('app.resetToDefaultNotSaved')}
                    onClick={() => onReset(settingKey)}
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                </button>
            )}
        </div>
    );
}
