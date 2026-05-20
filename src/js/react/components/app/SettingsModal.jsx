import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettings } from '@/api/useSettings';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { groupSchemaEntries } from '@/utils/groupSettings';
import { SettingInput } from './SettingInput';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Global settings modal
 */
export function SettingsModal({ isOpen, onClose }) {
    const { t, language, setLanguage } = useTranslation();
    const { settings, updateSetting, refetch: refetchSettings } = useSettings();
    const { schema, defaults, groups, refetch: refetchSchema, loading: schemaLoading } = useSettingsSchema();

    const {
        formValues,
        uiValues,
        saving,
        originalUiValues,
        handleFormChange,
        handleUiChange,
        handleResetGlobal,
        handleResetUi,
        handleResetAll,
        commit,
        revert,
    } = useSettingsForm({
        isOpen,
        schema,
        defaults,
        settings,
        refetchSettings,
        refetchSchema,
        updateSetting,
    });

    // Timezone "+" toggle — local UI state, never persisted, so it stays
    // out of the form hook.
    const [tzInputVisible, setTzInputVisible] = useState(false);
    const [tzInputValue, setTzInputValue] = useState('');
    const [tzInputError, setTzInputError] = useState(false);

    // Reset the timezone input on every open so a stale "+" panel from a
    // previous session doesn't carry over.
    useEffect(() => {
        if (isOpen) {
            setTzInputVisible(false);
            setTzInputValue('');
            setTzInputError(false);
        }
    }, [isOpen]);

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
        const list = uiValues.customTimezones || [];
        const nextList = list.includes(value) ? list : [...list, value];
        handleUiChange('customTimezones', nextList);
        handleUiChange('timezone', value);
        setTzInputValue('');
        setTzInputError(false);
        setTzInputVisible(false);
    }, [tzInputValue, uiValues.customTimezones, handleUiChange]);

    const handleTimezoneRemove = useCallback(() => {
        const filtered = (uiValues.customTimezones || []).filter((tz) => tz !== uiValues.timezone);
        handleUiChange('customTimezones', filtered);
        handleUiChange('timezone', 'Europe/Riga');
    }, [uiValues.customTimezones, uiValues.timezone, handleUiChange]);

    const handleCancel = useCallback(() => {
        // Revert theme DOM if the user changed it during this open session.
        if (originalUiValues && originalUiValues.theme !== uiValues.theme) {
            document.documentElement.setAttribute('data-theme', originalUiValues.theme);
        }
        revert();
        onClose();
    }, [originalUiValues, uiValues.theme, revert, onClose]);

    const handleSave = useCallback(async () => {
        try {
            await commit();
            if (uiValues.language !== language) {
                setLanguage(uiValues.language);
            }
            if (window.handleThresholdSettingsChange) {
                await window.handleThresholdSettingsChange();
            }
            onClose();
        } catch (err) {
            await window.api.logError(`Error saving settings: ${err.message || err}`);
        }
    }, [commit, uiValues.language, language, setLanguage, onClose]);

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
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="2"
                                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                                />
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
                                    <button className="btn btn-ghost btn-sm" onClick={() => handleResetUi('theme')}>
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
                                    <button className="btn btn-ghost btn-sm" onClick={() => handleResetUi('language')}>
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
                                            <option key={tz} value={tz}>
                                                {tz}
                                            </option>
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
                                    >
                                        +
                                    </button>
                                    <button
                                        className={`btn btn-ghost btn-sm text-error ${uiValues.timezone !== 'Europe/Riga' ? '' : 'invisible'}`}
                                        title={t('app.removeCurrentTimezone')}
                                        onClick={handleTimezoneRemove}
                                    >
                                        ×
                                    </button>
                                    <button className="btn btn-ghost btn-sm" onClick={() => handleResetUi('timezone')}>
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
                                        onChange={(e) =>
                                            handleUiChange('checkFrequencyMin', parseInt(e.target.value, 10) || 1)
                                        }
                                    />
                                    <span className="text-sm">{t('app.checkFrequencyMax')}</span>
                                    <input
                                        type="number"
                                        className="input input-bordered input-sm w-20"
                                        min="1"
                                        max="60"
                                        value={uiValues.checkFrequencyMax}
                                        onChange={(e) =>
                                            handleUiChange('checkFrequencyMax', parseInt(e.target.value, 10) || 1)
                                        }
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
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth="2"
                                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                                            />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Challenge Defaults Section — grouped into static sub-sections */}
                    <div>
                        <h4 className="font-semibold text-base mb-3 border-b border-base-300 pb-2">
                            {t('app.challengeDefaults')}
                        </h4>
                        {groupSchemaEntries(schema, groups).map(({ id, label, entries }) => (
                            <div key={id} className="mb-4">
                                <h5 className="font-medium text-sm opacity-70 mb-2 mt-3">{t(label)}</h5>
                                <div className="space-y-4">
                                    {entries.map(([key, config]) => (
                                        <div key={key} className="form-control">
                                            <label className="label">
                                                <span className="label-text font-medium">{t(config.label)}</span>
                                                <span className="badge badge-ghost badge-xs ml-2">
                                                    {t('app.globalDefault')}
                                                </span>
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
                        ))}
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
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="2"
                                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                                />
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
