import { useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { SETTINGS_GRID_CLASS, SETTING_CELL_CLASS } from '@/utils/groupSettings';
import { ResetButton } from '@/components/ui/ResetButton';
import { ThemeSelect } from '@/components/ui/ThemeSelect';
import { ToneNote } from '@/components/ui/ToneNote';
import { DEFAULT_TIMEZONE } from '../../../settings/uiDefaults';
import { SettingLabel, numberRangeMessage, parseNumberInput } from './SettingInput';

import type { ComponentChildren } from 'preact';
import type { useCustomTimezoneInput } from '@/hooks/useCustomTimezoneInput';
import type { UiChangeHandler, UiResetHandler, UiValues } from '../../../types/settingsEditor';
import type { ReactNode } from 'react';

export type TimezoneInputState = ReturnType<typeof useCustomTimezoneInput>;

/**
 * The UI-values half of useSettingsForm, as every UI setting row takes it.
 */
export interface UiFormProps {
    uiValues: UiValues;
    handleUiChange: UiChangeHandler;
    handleResetUi: UiResetHandler;
    /** The settings the last Save refused: their controls are marked invalid. */
    rejectedKeys: readonly string[];
}

// The section heading: where focus goes when a Save fails on the language, which has no key of its own to mark.
export const APPLICATION_HEADING_ID = 'settings-application-heading';

type UiNumberKey = 'checkFrequencyMin' | 'checkFrequencyMax' | 'apiMaxRetries' | 'apiRetryBaseDelayMs';

/**
 * One integer input of a multi-value UI setting (see UiNumberInputs).
 */
interface UiNumberField {
    key: UiNumberKey;
    labelKey: string;
    widthClass: string;
    min: string;
    max: string;
    step?: string;
    atLeastKey?: UiNumberKey;
}

/**
 * The accessible name of a UI setting's reset button: the action and the setting it resets.
 */
const resetLabel = (t: (key: string) => string, labelKey: string): string =>
    `${t('app.resetToDefault')}: ${t(labelKey)}`;

/**
 * One application (UI) setting: caption with the "UI setting" badge, description, then its controls.
 */
function UiSettingCell({
    inputId,
    group,
    labelKey,
    descKey,
    children,
}: {
    inputId: string;
    group?: boolean;
    labelKey: string;
    descKey: string;
    children?: ComponentChildren;
}) {
    const { t } = useTranslation();
    return (
        <div className={SETTING_CELL_CLASS}>
            <SettingLabel inputId={inputId} group={group}>
                <span className="font-medium">{t(labelKey)}</span>
                <span className="badge badge-ghost badge-sm ml-2">{t('app.uiSetting')}</span>
            </SettingLabel>
            <p className="text-xs text-base-content/70 mb-2">{t(descKey)}</p>
            {children}
        </div>
    );
}

/**
 * One integer input of a multi-value UI setting. It keeps the typed text as a draft, so an emptied or
 * half-typed field is not snapped to a fallback mid-edit: a draft inside the range is committed as it is typed,
 * one outside it is not, and on blur the last valid value comes back with the range message. A field with
 * `atLeastKey` is clamped up to that sibling's value on blur, so a range can never invert.
 */
function UiNumberInput({
    field: { key, labelKey, widthClass, min, max, step, atLeastKey },
    uiValues,
    handleUiChange,
    rejected,
}: {
    field: UiNumberField;
    uiValues: UiValues;
    handleUiChange: UiChangeHandler;
    rejected: boolean;
}) {
    const { t } = useTranslation();
    const committed = uiValues[key];
    const [draft, setDraft] = useState(String(committed));
    // Set when a blur put the last valid value back; the range message stays until the next edit.
    const [reverted, setReverted] = useState(false);
    const range = { min: Number(min), max: Number(max) };
    const parsed = parseNumberInput(draft);
    const outOfRange = parsed === '' || parsed < range.min || parsed > range.max;
    const id = `ui-${key}`;
    const errorId = `${id}-error`;

    // The value changed from outside (a reset, Reset all, a clamp): the draft follows, unless it already reads as it.
    useEffect(() => {
        setDraft((typed) => (parseNumberInput(typed) === committed ? typed : String(committed)));
        setReverted(false);
    }, [committed]);

    return (
        <>
            <span className="text-sm">{t(labelKey)}</span>
            <input
                id={id}
                type="number"
                className={`input input-sm ${widthClass} ${outOfRange || reverted ? 'input-error' : ''}`}
                min={min}
                max={max}
                step={step}
                aria-label={t(labelKey)}
                aria-invalid={outOfRange || reverted || rejected || undefined}
                aria-describedby={reverted ? errorId : undefined}
                value={draft}
                onChange={(e) => {
                    const raw = e.currentTarget.value;
                    const next = parseNumberInput(raw);
                    setDraft(raw);
                    setReverted(false);
                    if (next !== '' && next >= range.min && next <= range.max) handleUiChange(key, next);
                }}
                onBlur={() => {
                    if (outOfRange) {
                        setDraft(String(committed));
                        setReverted(true);
                    } else if (atLeastKey && parsed < uiValues[atLeastKey]) {
                        handleUiChange(key, uiValues[atLeastKey]);
                    }
                }}
            />
            {reverted && (
                <ToneNote tone="error" as="span" id={errorId} className="basis-full text-xs">
                    {numberRangeMessage(range, t)}
                </ToneNote>
            )}
        </>
    );
}

/**
 * A UI setting made of several number inputs, reset together. `suffix` is an optional trailing unit.
 */
function UiNumberGroupCell({
    inputId,
    labelKey,
    descKey,
    fields,
    suffix,
    uiValues,
    handleUiChange,
    handleResetUi,
    rejectedKeys,
}: UiFormProps & {
    inputId: string;
    labelKey: string;
    descKey: string;
    fields: UiNumberField[];
    suffix?: ComponentChildren;
}) {
    const { t } = useTranslation();
    return (
        <UiSettingCell inputId={inputId} group labelKey={labelKey} descKey={descKey}>
            <div className="flex items-center gap-2 flex-wrap" role="group" aria-labelledby={`${inputId}-label`}>
                {fields.map((field) => (
                    <UiNumberInput
                        key={field.key}
                        field={field}
                        uiValues={uiValues}
                        handleUiChange={handleUiChange}
                        rejected={rejectedKeys.includes(field.key)}
                    />
                ))}
                {suffix}
                <ResetButton
                    label={resetLabel(t, labelKey)}
                    onClick={() => fields.forEach(({ key }) => handleResetUi(key))}
                />
            </div>
        </UiSettingCell>
    );
}

const CHECK_FREQUENCY_FIELDS: UiNumberField[] = [
    {
        key: 'checkFrequencyMin',
        labelKey: 'app.checkFrequencyMin',
        widthClass: 'w-20',
        min: '1',
        max: '60',
    },
    {
        key: 'checkFrequencyMax',
        labelKey: 'app.checkFrequencyMax',
        widthClass: 'w-20',
        min: '1',
        max: '60',
        atLeastKey: 'checkFrequencyMin',
    },
];

const RELIABILITY_FIELDS: UiNumberField[] = [
    { key: 'apiMaxRetries', labelKey: 'app.apiMaxRetries', widthClass: 'w-20', min: '0', max: '10' },
    {
        key: 'apiRetryBaseDelayMs',
        labelKey: 'app.apiRetryBaseDelayMs',
        widthClass: 'w-24',
        min: '100',
        max: '10000',
        step: '100',
    },
];

const TIMEZONE_ERROR_ID = 'ui-customTimezone-error';

/**
 * The revealed "+" input: Enter or blur adds the typed zone, Escape discards it. A zone that is not valid is
 * flagged with a message; an empty field is not an error, there is just nothing to add.
 */
function CustomTimezoneInput({ timezoneInput }: { timezoneInput: TimezoneInputState }) {
    const { t } = useTranslation();
    return (
        <>
            <input
                ref={timezoneInput.inputRef}
                type="text"
                aria-label={t('app.addCustomTimezone')}
                placeholder={t('app.timezonePlaceholder')}
                className={`input input-sm mt-2 w-60 ${timezoneInput.error ? 'input-error' : ''}`}
                aria-invalid={timezoneInput.error || undefined}
                aria-describedby={timezoneInput.error ? TIMEZONE_ERROR_ID : undefined}
                value={timezoneInput.value}
                onChange={(e) => timezoneInput.change(e.currentTarget.value)}
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
            {timezoneInput.error && (
                <ToneNote tone="error" id={TIMEZONE_ERROR_ID} className="mt-1 text-xs">
                    {t('app.timezoneInvalid')}
                </ToneNote>
            )}
        </>
    );
}

/**
 * A UI setting whose controls share one row, ending in the setting's reset.
 */
function ResettableUiCell({
    inputId,
    labelKey,
    descKey,
    onReset,
    children,
}: {
    inputId: string;
    labelKey: string;
    descKey: string;
    onReset: () => void;
    children?: ComponentChildren;
}) {
    const { t } = useTranslation();
    return (
        <UiSettingCell inputId={inputId} labelKey={labelKey} descKey={descKey}>
            <div className="flex items-center gap-2">
                {children}
                <ResetButton label={resetLabel(t, labelKey)} onClick={onReset} />
            </div>
        </UiSettingCell>
    );
}

function ThemeSetting({ uiValues, handleUiChange, handleResetUi, rejectedKeys }: UiFormProps) {
    return (
        <ResettableUiCell
            inputId="ui-theme"
            labelKey="app.theme"
            descKey="app.themeDesc"
            onReset={() => handleResetUi('theme')}
        >
            <ThemeSelect
                id="ui-theme"
                value={uiValues.theme}
                onChange={(theme) => handleUiChange('theme', theme)}
                invalid={rejectedKeys.includes('theme')}
            />
        </ResettableUiCell>
    );
}

function LanguageSetting({ uiValues, handleUiChange, handleResetUi }: UiFormProps) {
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
                onChange={(e) => handleUiChange('language', e.currentTarget.value)}
            >
                <option value="en">{t('app.english')}</option>
                <option value="lv">{t('app.latvian')}</option>
            </select>
        </ResettableUiCell>
    );
}

function TimezoneSetting({
    uiValues,
    handleUiChange,
    handleResetUi,
    rejectedKeys,
    timezoneInput,
}: UiFormProps & { timezoneInput: TimezoneInputState }) {
    const { t } = useTranslation();
    const { timezone, customTimezones } = uiValues;
    return (
        <UiSettingCell inputId="ui-timezone" labelKey="app.timezone" descKey="app.timezoneDesc">
            <div className="flex items-center gap-2 flex-wrap">
                <select
                    id="ui-timezone"
                    className="select select-sm w-48"
                    aria-invalid={
                        rejectedKeys.includes('timezone') || rejectedKeys.includes('customTimezones') || undefined
                    }
                    value={timezone}
                    onChange={(e) => handleUiChange('timezone', e.currentTarget.value)}
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
                    className="btn btn-outline btn-sm"
                    title={t('app.addCustomTimezone')}
                    aria-label={t('app.addCustomTimezone')}
                    onClick={timezoneInput.toggle}
                >
                    +
                </button>
                <button
                    className={`btn btn-error btn-sm ${timezone !== DEFAULT_TIMEZONE ? '' : 'invisible'}`}
                    title={t('app.removeCurrentTimezone')}
                    aria-label={t('app.removeCurrentTimezone')}
                    onClick={timezoneInput.remove}
                >
                    ×
                </button>
                <ResetButton label={resetLabel(t, 'app.timezone')} onClick={() => handleResetUi('timezone')} />
            </div>
            {timezoneInput.visible && <CustomTimezoneInput timezoneInput={timezoneInput} />}
        </UiSettingCell>
    );
}

/**
 * The global modal's "Application Settings" section: theme, language,
 * timezone, check frequency and API retry. These are UI settings, edited
 * through useSettingsForm's `uiValues` half; `timezoneInput` is
 * useCustomTimezoneInput's state. `children` are the app-wide schema groups
 * (rewards, missions, notifications, display) the modal renders below them.
 */
export function ApplicationSettingsSection({
    uiValues,
    handleUiChange,
    handleResetUi,
    rejectedKeys,
    timezoneInput,
    children,
}: UiFormProps & { timezoneInput: TimezoneInputState; children?: ReactNode }) {
    const { t } = useTranslation();
    const ui = { uiValues, handleUiChange, handleResetUi, rejectedKeys };

    return (
        <div>
            <h4
                id={APPLICATION_HEADING_ID}
                tabIndex={-1}
                className="font-semibold text-base mb-3 border-b border-base-300 pb-2"
            >
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
            {children}
        </div>
    );
}
