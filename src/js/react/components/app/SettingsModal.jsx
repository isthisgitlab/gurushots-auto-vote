import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettings } from '@/api/useSettings';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { SettingInput } from './SettingInput';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Global settings modal
 */
export function SettingsModal({ isOpen, onClose }) {
    const { t, language, setLanguage } = useTranslation();
    const { settings, updateSetting, refetch: refetchSettings } = useSettings();
    const { schema, defaults, refetch: refetchSchema, loading: schemaLoading } = useSettingsSchema();

    // Local state for form values
    const [formValues, setFormValues] = useState({});
    const [uiValues, setUiValues] = useState({
        theme: 'light',
        language: 'en',
        timezone: 'Europe/Riga',
        customTimezones: [],
        stayLoggedIn: false,
        apiTimeout: 30000,
        checkFrequencyMin: 3,
        checkFrequencyMax: 3,
    });
    const [saving, setSaving] = useState(false);
    // Timezone "+" toggle — local UI state, never persisted.
    const [tzInputVisible, setTzInputVisible] = useState(false);
    const [tzInputValue, setTzInputValue] = useState('');
    const [tzInputError, setTzInputError] = useState(false);
    // Store original values to revert on cancel
    const [originalUiValues, setOriginalUiValues] = useState(null);
    const [originalFormValues, setOriginalFormValues] = useState(null);

    // Refetch from disk every time the modal opens so we never display
    // a value that another writer (CLI, another window) has since changed.
    useEffect(() => {
        if (isOpen) {
            refetchSettings();
            refetchSchema();
        }
    }, [isOpen, refetchSettings, refetchSchema]);

    // Initialize form values when modal opens
    useEffect(() => {
        if (isOpen && defaults) {
            setFormValues({ ...defaults });
            setOriginalFormValues({ ...defaults });
        }
        if (isOpen && settings) {
            const initialUiValues = {
                theme: settings.theme || 'light',
                language: settings.language || 'en',
                timezone: settings.timezone || 'Europe/Riga',
                customTimezones: Array.isArray(settings.customTimezones) ? settings.customTimezones : [],
                stayLoggedIn: settings.stayLoggedIn || false,
                apiTimeout: settings.apiTimeout || 30000,
                checkFrequencyMin: settings.checkFrequencyMin ?? 3,
                checkFrequencyMax: settings.checkFrequencyMax ?? 3,
            };
            setUiValues(initialUiValues);
            setOriginalUiValues(initialUiValues);
            setTzInputVisible(false);
            setTzInputValue('');
            setTzInputError(false);
        }
    }, [isOpen, defaults, settings]);

    const handleFormChange = useCallback((key, value) => {
        setFormValues((prev) => ({ ...prev, [key]: value }));
    }, []);

    const handleUiChange = useCallback((key, value) => {
        setUiValues((prev) => ({ ...prev, [key]: value }));

        // Immediately apply theme change
        if (key === 'theme') {
            document.documentElement.setAttribute('data-theme', value);
        }
    }, []);

    const handleResetGlobal = useCallback(async (key) => {
        if (schema && schema[key]) {
            setFormValues((prev) => ({ ...prev, [key]: schema[key].default }));
        }
    }, [schema]);

    const handleResetUi = useCallback((key) => {
        const defaultUiValues = {
            theme: 'light',
            language: 'en',
            timezone: 'Europe/Riga',
            customTimezones: [],
            stayLoggedIn: false,
            apiTimeout: 30000,
            checkFrequencyMin: 3,
            checkFrequencyMax: 3,
        };
        setUiValues((prev) => ({ ...prev, [key]: defaultUiValues[key] }));

        if (key === 'theme') {
            document.documentElement.setAttribute('data-theme', defaultUiValues.theme);
        }
    }, []);

    const handleResetAll = useCallback(async () => {
        // Reset all global defaults to schema defaults
        if (schema) {
            const newFormValues = {};
            for (const [key, config] of Object.entries(schema)) {
                newFormValues[key] = config.default;
            }
            setFormValues(newFormValues);
        }

        // Reset UI settings
        setUiValues({
            theme: 'light',
            language: 'en',
            timezone: 'Europe/Riga',
            customTimezones: [],
            stayLoggedIn: false,
            apiTimeout: 30000,
            checkFrequencyMin: 3,
            checkFrequencyMax: 3,
        });
        document.documentElement.setAttribute('data-theme', 'light');
    }, [schema]);

    const isValidTimezone = (tz) => {
        try {
            new Intl.DateTimeFormat(undefined, { timeZone: tz });
            return true;
        } catch {
            return false;
        }
    };

    const handleTimezoneAdd = useCallback(() => {
        const value = tzInputValue.trim();
        if (!value || !isValidTimezone(value)) {
            setTzInputError(true);
            return;
        }
        setUiValues((prev) => {
            const list = prev.customTimezones || [];
            const nextList = list.includes(value) ? list : [...list, value];
            return { ...prev, customTimezones: nextList, timezone: value };
        });
        setTzInputValue('');
        setTzInputError(false);
        setTzInputVisible(false);
    }, [tzInputValue]);

    const handleTimezoneRemove = useCallback(() => {
        setUiValues((prev) => ({
            ...prev,
            customTimezones: (prev.customTimezones || []).filter((tz) => tz !== prev.timezone),
            timezone: 'Europe/Riga',
        }));
    }, []);

    const handleCancel = useCallback(() => {
        // Revert theme to original if it was changed
        if (originalUiValues && originalUiValues.theme !== uiValues.theme) {
            document.documentElement.setAttribute('data-theme', originalUiValues.theme);
        }
        // Reset state to original values
        if (originalUiValues) {
            setUiValues(originalUiValues);
        }
        if (originalFormValues) {
            setFormValues(originalFormValues);
        }
        onClose();
    }, [originalUiValues, originalFormValues, uiValues.theme, onClose]);

    const handleSave = useCallback(async () => {
        setSaving(true);
        try {
            // Save UI settings
            for (const [key, value] of Object.entries(uiValues)) {
                await updateSetting(key, value);
            }

            // Save global defaults
            for (const [key, value] of Object.entries(formValues)) {
                await window.api.setGlobalDefault(key, value);
            }

            // Update language if changed
            if (uiValues.language !== language) {
                setLanguage(uiValues.language);
            }

            // Notify threshold scheduling update
            if (window.handleThresholdSettingsChange) {
                await window.handleThresholdSettingsChange();
            }

            onClose();
        } catch (err) {
            await window.api.logError(`Error saving settings: ${err.message || err}`);
        } finally {
            setSaving(false);
        }
    }, [formValues, uiValues, updateSetting, onClose, language, setLanguage]);

    if (!isOpen) return null;

    return (
        <Modal isOpen={isOpen} onClose={handleCancel} title={t('app.globalSettings')}>
            {schemaLoading ? (
                <LoadingSpinner text={t('common.loading')} />
            ) : (
                <div className="space-y-6">
                    {/* Top Action Buttons */}
                    <div className="flex justify-end gap-2">
                        <button className="btn btn-latvian" onClick={handleSave} disabled={saving}>
                            {saving && <span className="loading loading-spinner loading-xs" />}
                            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                            </svg>
                            {t('app.save')}
                        </button>
                        <button className="btn btn-warning" onClick={handleResetAll}>
                            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            {t('app.resetAll')}
                        </button>
                        <button className="btn" onClick={handleCancel}>
                            {t('app.cancel')}
                        </button>
                    </div>

                    {/* Application Settings Section */}
                    <div>
                        <h4 className="font-semibold text-base mb-3 border-b border-base-300 pb-2">
                            {t('app.applicationSettings')}
                        </h4>
                        <div className="space-y-4">
                            {/* Theme */}
                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text font-medium">{t('app.theme')}</span>
                                    <span className="badge badge-ghost badge-xs ml-2">{t('app.uiSetting')}</span>
                                </label>
                                <p className="text-xs text-base-content/60 mb-2">{t('app.themeDesc')}</p>
                                <div className="flex items-center gap-2">
                                    <span className="text-sm">{t('common.light')}</span>
                                    <input
                                        type="checkbox"
                                        className="toggle toggle-sm"
                                        checked={uiValues.theme === 'dark'}
                                        onChange={(e) => handleUiChange('theme', e.target.checked ? 'dark' : 'light')}
                                    />
                                    <span className="text-sm">{t('common.dark')}</span>
                                    <button
                                        className="btn btn-ghost btn-sm"
                                        onClick={() => handleResetUi('theme')}
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            {/* Language */}
                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text font-medium">{t('app.language')}</span>
                                    <span className="badge badge-ghost badge-xs ml-2">{t('app.uiSetting')}</span>
                                </label>
                                <p className="text-xs text-base-content/60 mb-2">{t('app.languageDesc')}</p>
                                <div className="flex items-center gap-2">
                                    <select
                                        className="select select-bordered select-sm"
                                        value={uiValues.language}
                                        onChange={(e) => handleUiChange('language', e.target.value)}
                                    >
                                        <option value="en">{t('app.english')}</option>
                                        <option value="lv">{t('app.latvian')}</option>
                                    </select>
                                    <button
                                        className="btn btn-ghost btn-sm"
                                        onClick={() => handleResetUi('language')}
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            {/* Timezone */}
                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text font-medium">{t('app.timezone')}</span>
                                    <span className="badge badge-ghost badge-xs ml-2">{t('app.uiSetting')}</span>
                                </label>
                                <p className="text-xs text-base-content/60 mb-2">{t('app.timezoneDesc')}</p>
                                <div className="flex items-center gap-2">
                                    <select
                                        className="select select-bordered select-sm w-48"
                                        value={uiValues.timezone}
                                        onChange={(e) => handleUiChange('timezone', e.target.value)}
                                    >
                                        <option value="Europe/Riga">Europe/Riga</option>
                                        {(uiValues.customTimezones || []).map((tz) => (
                                            <option key={tz} value={tz}>{tz}</option>
                                        ))}
                                        {uiValues.timezone !== 'Europe/Riga' &&
                                            !(uiValues.customTimezones || []).includes(uiValues.timezone) && (
                                            <option value={uiValues.timezone}>{uiValues.timezone}</option>
                                        )}
                                    </select>
                                    <button
                                        className="btn btn-ghost btn-sm"
                                        title={t('app.addCustomTimezone')}
                                        onClick={() => {
                                            setTzInputVisible((v) => !v);
                                            setTzInputError(false);
                                        }}
                                    >+</button>
                                    <button
                                        className={`btn btn-ghost btn-sm text-error ${uiValues.timezone !== 'Europe/Riga' ? '' : 'invisible'}`}
                                        title={t('app.removeCurrentTimezone')}
                                        onClick={handleTimezoneRemove}
                                    >×</button>
                                    <button
                                        className="btn btn-ghost btn-sm"
                                        onClick={() => handleResetUi('timezone')}
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                        </svg>
                                    </button>
                                </div>
                                {tzInputVisible && (
                                    <input
                                        type="text"
                                        placeholder={t('app.timezonePlaceholder')}
                                        className={`input input-bordered input-sm mt-2 w-60 ${tzInputError ? 'input-error' : ''}`}
                                        value={tzInputValue}
                                        onChange={(e) => {
                                            setTzInputValue(e.target.value);
                                            if (tzInputError) setTzInputError(false);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                handleTimezoneAdd();
                                            } else if (e.key === 'Escape') {
                                                setTzInputVisible(false);
                                                setTzInputValue('');
                                                setTzInputError(false);
                                            }
                                        }}
                                        onBlur={handleTimezoneAdd}
                                        autoFocus
                                    />
                                )}
                            </div>

                            {/* Check Frequency */}
                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text font-medium">{t('app.checkFrequency')}</span>
                                    <span className="badge badge-ghost badge-xs ml-2">{t('app.uiSetting')}</span>
                                </label>
                                <p className="text-xs text-base-content/60 mb-2">{t('app.checkFrequencyDesc')}</p>
                                <div className="flex items-center gap-2">
                                    <span className="text-sm">{t('app.checkFrequencyMin')}</span>
                                    <input
                                        type="number"
                                        className="input input-bordered input-sm w-20"
                                        min="1"
                                        max="60"
                                        value={uiValues.checkFrequencyMin}
                                        onChange={(e) => handleUiChange('checkFrequencyMin', parseInt(e.target.value, 10) || 1)}
                                    />
                                    <span className="text-sm">{t('app.checkFrequencyMax')}</span>
                                    <input
                                        type="number"
                                        className="input input-bordered input-sm w-20"
                                        min="1"
                                        max="60"
                                        value={uiValues.checkFrequencyMax}
                                        onChange={(e) => handleUiChange('checkFrequencyMax', parseInt(e.target.value, 10) || 1)}
                                        onBlur={(e) => {
                                            const v = parseInt(e.target.value, 10) || 1;
                                            if (v < uiValues.checkFrequencyMin) {
                                                handleUiChange('checkFrequencyMax', uiValues.checkFrequencyMin);
                                            }
                                        }}
                                    />
                                    <span className="text-sm">{t('app.minutes')}</span>
                                    <button
                                        className="btn btn-ghost btn-sm"
                                        onClick={() => {
                                            handleResetUi('checkFrequencyMin');
                                            handleResetUi('checkFrequencyMax');
                                        }}
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Challenge Defaults Section */}
                    <div>
                        <h4 className="font-semibold text-base mb-3 border-b border-base-300 pb-2">
                            {t('app.challengeDefaults')}
                        </h4>
                        <div className="space-y-4">
                            {schema && Object.entries(schema).map(([key, config]) => (
                                <div key={key} className="form-control">
                                    <label className="label">
                                        <span className="label-text font-medium">{t(config.label)}</span>
                                        <span className="badge badge-ghost badge-xs ml-2">{t('app.globalDefault')}</span>
                                    </label>
                                    <p className="text-xs text-base-content/60 mb-2">{t(config.description)}</p>
                                    <SettingInput
                                        settingKey={key}
                                        config={config}
                                        value={formValues[key] ?? config.default}
                                        onChange={handleFormChange}
                                        onReset={handleResetGlobal}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Bottom Action Buttons */}
                    <div className="flex justify-end gap-2 pt-4 border-t border-base-300">
                        <button className="btn btn-latvian" onClick={handleSave} disabled={saving}>
                            {saving && <span className="loading loading-spinner loading-xs" />}
                            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                            </svg>
                            {t('app.save')}
                        </button>
                        <button className="btn btn-warning" onClick={handleResetAll}>
                            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            {t('app.resetAll')}
                        </button>
                        <button className="btn" onClick={handleCancel}>
                            {t('app.cancel')}
                        </button>
                    </div>
                </div>
            )}
        </Modal>
    );
}
