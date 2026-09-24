import { Fragment } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { SETTINGS_GRID_CLASS, SETTING_CELL_CLASS } from '@/utils/groupSettings';
import { ResetButton } from '@/components/ui/ResetButton';
import { DEFAULT_TIMEZONE } from '../../../settings/uiDefaults';
import { SettingLabel } from './SettingInput';

/** One application (UI) setting: caption with the "UI setting" badge, description, then its controls. */
function UiSettingCell({ inputId, group, labelKey, descKey, children }) {
    const { t } = useTranslation();
    return (
        <div className={SETTING_CELL_CLASS}>
            <SettingLabel inputId={inputId} group={group}>
                <span className="font-medium">{t(labelKey)}</span>
                <span className="badge badge-ghost badge-xs ml-2">{t('app.uiSetting')}</span>
            </SettingLabel>
            <p className="text-xs text-base-content/60 mb-2">{t(descKey)}</p>
            {children}
        </div>
    );
}

/**
 * Captioned integer inputs for a multi-value UI setting. An unparseable entry
 * falls back to the field's `fallback`; a field with `atLeastKey` is clamped up
 * to that sibling's value once the user leaves it, so a range can never invert.
 */
function UiNumberInputs({ fields, uiValues, handleUiChange }) {
    const { t } = useTranslation();
    return fields.map(({ key, labelKey, widthClass, min, max, step, fallback, atLeastKey }) => (
        <Fragment key={key}>
            <span className="text-sm">{t(labelKey)}</span>
            <input
                type="number"
                className={`input input-sm ${widthClass}`}
                min={min}
                max={max}
                step={step}
                aria-label={t(labelKey)}
                value={uiValues[key]}
                onChange={(e) => handleUiChange(key, parseInt(e.target.value, 10) || fallback)}
                onBlur={
                    atLeastKey &&
                    ((e) => {
                        if ((parseInt(e.target.value, 10) || fallback) < uiValues[atLeastKey]) {
                            handleUiChange(key, uiValues[atLeastKey]);
                        }
                    })
                }
            />
        </Fragment>
    ));
}

/** A UI setting made of several number inputs, reset together. `suffix` is an optional trailing unit. */
function UiNumberGroupCell({ inputId, labelKey, descKey, fields, suffix, uiValues, handleUiChange, handleResetUi }) {
    return (
        <UiSettingCell inputId={inputId} group labelKey={labelKey} descKey={descKey}>
            <div className="flex items-center gap-2 flex-wrap" role="group" aria-labelledby={`${inputId}-label`}>
                <UiNumberInputs fields={fields} uiValues={uiValues} handleUiChange={handleUiChange} />
                {suffix}
                <ResetButton onClick={() => fields.forEach(({ key }) => handleResetUi(key))} />
            </div>
        </UiSettingCell>
    );
}

const CHECK_FREQUENCY_FIELDS = [
    {
        key: 'checkFrequencyMin',
        labelKey: 'app.checkFrequencyMin',
        widthClass: 'w-20',
        min: '1',
        max: '60',
        fallback: 1,
    },
    {
        key: 'checkFrequencyMax',
        labelKey: 'app.checkFrequencyMax',
        widthClass: 'w-20',
        min: '1',
        max: '60',
        fallback: 1,
        atLeastKey: 'checkFrequencyMin',
    },
];

const RELIABILITY_FIELDS = [
    { key: 'apiMaxRetries', labelKey: 'app.apiMaxRetries', widthClass: 'w-20', min: '0', max: '10', fallback: 0 },
    {
        key: 'apiRetryBaseDelayMs',
        labelKey: 'app.apiRetryBaseDelayMs',
        widthClass: 'w-24',
        min: '100',
        max: '10000',
        step: '100',
        fallback: 1000,
    },
];

/** The revealed "+" input: Enter or blur adds the typed zone, Escape discards it. */
function CustomTimezoneInput({ timezoneInput }) {
    const { t } = useTranslation();
    return (
        <input
            ref={timezoneInput.inputRef}
            type="text"
            aria-label={t('app.addCustomTimezone')}
            placeholder={t('app.timezonePlaceholder')}
            className={`input input-sm mt-2 w-60 ${timezoneInput.error ? 'input-error' : ''}`}
            value={timezoneInput.value}
            onChange={(e) => timezoneInput.change(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    timezoneInput.add();
                } else if (e.key === 'Escape') {
                    timezoneInput.close();
                }
            }}
            onBlur={timezoneInput.add}
        />
    );
}

/** A UI setting whose controls share one row, ending in the setting's reset. */
function ResettableUiCell({ inputId, labelKey, descKey, onReset, children }) {
    return (
        <UiSettingCell inputId={inputId} labelKey={labelKey} descKey={descKey}>
            <div className="flex items-center gap-2">
                {children}
                <ResetButton onClick={onReset} />
            </div>
        </UiSettingCell>
    );
}

function ThemeSetting({ uiValues, handleUiChange, handleResetUi }) {
    const { t } = useTranslation();
    return (
        <ResettableUiCell
            inputId="ui-theme"
            labelKey="app.theme"
            descKey="app.themeDesc"
            onReset={() => handleResetUi('theme')}
        >
            <span className="text-sm">{t('common.light')}</span>
            <input
                id="ui-theme"
                type="checkbox"
                className="toggle toggle-sm"
                checked={uiValues.theme === 'dark'}
                onChange={(e) => handleUiChange('theme', e.target.checked ? 'dark' : 'light')}
            />
            <span className="text-sm">{t('common.dark')}</span>
        </ResettableUiCell>
    );
}

function LanguageSetting({ uiValues, handleUiChange, handleResetUi }) {
    const { t } = useTranslation();
    return (
        <ResettableUiCell
            inputId="ui-language"
            labelKey="app.language"
            descKey="app.languageDesc"
            onReset={() => handleResetUi('language')}
        >
            <select
                id="ui-language"
                className="select select-sm"
                value={uiValues.language}
                onChange={(e) => handleUiChange('language', e.target.value)}
            >
                <option value="en">{t('app.english')}</option>
                <option value="lv">{t('app.latvian')}</option>
            </select>
        </ResettableUiCell>
    );
}

function TimezoneSetting({ uiValues, handleUiChange, handleResetUi, timezoneInput }) {
    const { t } = useTranslation();
    const { timezone, customTimezones } = uiValues;
    return (
        <UiSettingCell inputId="ui-timezone" labelKey="app.timezone" descKey="app.timezoneDesc">
            <div className="flex items-center gap-2 flex-wrap">
                <select
                    id="ui-timezone"
                    className="select select-sm w-48"
                    value={timezone}
                    onChange={(e) => handleUiChange('timezone', e.target.value)}
                >
                    <option value={DEFAULT_TIMEZONE}>{DEFAULT_TIMEZONE}</option>
                    {customTimezones.map((tz) => (
                        <option key={tz} value={tz}>
                            {tz}
                        </option>
                    ))}
                    {timezone !== DEFAULT_TIMEZONE && !customTimezones.includes(timezone) && (
                        <option value={timezone}>{timezone}</option>
                    )}
                </select>
                <button
                    className="btn btn-ghost btn-sm"
                    title={t('app.addCustomTimezone')}
                    aria-label={t('app.addCustomTimezone')}
                    onClick={timezoneInput.toggle}
                >
                    +
                </button>
                <button
                    className={`btn btn-ghost btn-sm text-error ${timezone !== DEFAULT_TIMEZONE ? '' : 'invisible'}`}
                    title={t('app.removeCurrentTimezone')}
                    aria-label={t('app.removeCurrentTimezone')}
                    onClick={timezoneInput.remove}
                >
                    ×
                </button>
                <ResetButton onClick={() => handleResetUi('timezone')} />
            </div>
            {timezoneInput.visible && <CustomTimezoneInput timezoneInput={timezoneInput} />}
        </UiSettingCell>
    );
}

/**
 * The global modal's "Application Settings" section: theme, language,
 * timezone, check frequency and API retry. These are UI settings, edited
 * through useSettingsForm's `uiValues` half; `timezoneInput` is
 * useCustomTimezoneInput's state.
 */
export function ApplicationSettingsSection({ uiValues, handleUiChange, handleResetUi, timezoneInput }) {
    const { t } = useTranslation();
    const ui = { uiValues, handleUiChange, handleResetUi };

    return (
        <div>
            <h4 className="font-semibold text-base mb-3 border-b border-base-300 pb-2">
                {t('app.applicationSettings')}
            </h4>
            <div className={SETTINGS_GRID_CLASS}>
                <ThemeSetting {...ui} />
                <LanguageSetting {...ui} />
                <TimezoneSetting {...ui} timezoneInput={timezoneInput} />

                <UiNumberGroupCell
                    {...ui}
                    inputId="ui-checkFrequency"
                    labelKey="app.checkFrequency"
                    descKey="app.checkFrequencyDesc"
                    fields={CHECK_FREQUENCY_FIELDS}
                    suffix={<span className="text-sm">{t('app.minutes')}</span>}
                />

                <UiNumberGroupCell
                    {...ui}
                    inputId="ui-reliability"
                    labelKey="app.reliability"
                    descKey="app.apiMaxRetriesDesc"
                    fields={RELIABILITY_FIELDS}
                />
            </div>
        </div>
    );
}
