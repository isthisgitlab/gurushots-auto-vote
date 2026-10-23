import { useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { SETTINGS_SECTION_TITLES, useSettingsNav } from '@/contexts/SettingsNavContext';
import { matchesSettingFilter } from '@/utils/matchesSettingFilter';
import { SETTINGS_GRID_CLASS, SETTING_CELL_CLASS } from '@/utils/groupSettings';
import { ResetButton } from '@/components/ui/ResetButton';
import { ThemeSelect } from '@/components/ui/ThemeSelect';
import { ToneNote } from '@/components/ui/ToneNote';
import { BUILT_IN_TIMEZONES } from '../../../settings/uiDefaults';
import { SettingLabel, numberRangeMessage, parseNumberInput } from './SettingInput';
import { SettingsSectionPanel } from './SettingsSectionPanel';

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

/**
 * The label and description keys of the section's hand-written cells: the cells render them, and the settings
 * filter searches the same texts.
 */
export const APPLICATION_CELLS = {
    theme: { labelKey: 'app.theme', descKey: 'app.themeDesc' },
    language: { labelKey: 'app.language', descKey: 'app.languageDesc' },
    timezone: { labelKey: 'app.timezone', descKey: 'app.timezoneDesc' },
    checkFrequency: { labelKey: 'app.checkFrequency', descKey: 'app.checkFrequencyDesc' },
    reliability: { labelKey: 'app.reliability', descKey: 'app.apiMaxRetriesDesc' },
};

/**
 * Every text of the section's hand-written cells, for the settings filter.
 */
export const applicationCellTexts = (t: (key: string) => string): string[] =>
    Object.values(APPLICATION_CELLS).flatMap(({ labelKey, descKey }) => [t(labelKey), t(descKey)]);

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
    const { query } = useSettingsNav();
    const shown = matchesSettingFilter([t(labelKey), t(descKey)], query);
    return (
        <div className={`${SETTING_CELL_CLASS} ${shown ? '' : 'hidden'}`}>
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
 * Whether a draft reads as the form's value. An emptied field is held as NaN (see UiNumberInput), which equals nothing.
 */
const draftReads = (draft: string, committed: number): boolean => {
    const parsed = parseNumberInput(draft);
    return parsed === '' ? Number.isNaN(committed) : parsed === committed;
};

/**
 * One integer input of a multi-value UI setting. It keeps the typed text as a draft, so an emptied or half-typed
 * field is not snapped to a fallback mid-edit. What is typed goes to the form as it is, an emptied field as NaN:
 * Save refuses a value outside the range (or no number), so the field is marked, says its range and takes focus,
 * rather than the last in-range value typed on the way being saved. A field with `atLeastKey` is clamped up to that
 * sibling's value on blur, so a range can never invert.
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
    const range = { min: Number(min), max: Number(max) };
    const parsed = parseNumberInput(draft);
    const outOfRange = parsed === '' || parsed < range.min || parsed > range.max;
    const id = `ui-${key}`;
    const errorId = `${id}-error`;

    // The value changed from outside (a reset, Reset all, a clamp): the draft follows, unless it already reads as it.
    useEffect(() => {
        setDraft((typed) => (draftReads(typed, committed) ? typed : String(committed)));
    }, [committed]);

    return (
        <>
            <span className="text-sm">{t(labelKey)}</span>
            <input
                id={id}
                type="number"
                className={`input input-sm ${widthClass} ${outOfRange ? 'input-error' : ''}`}
                min={min}
                max={max}
                step={step}
                aria-label={t(labelKey)}
                aria-invalid={outOfRange || rejected || undefined}
                aria-describedby={outOfRange ? errorId : undefined}
                value={draft}
                onChange={(e) => {
                    const raw = e.currentTarget.value;
                    const next = parseNumberInput(raw);
                    setDraft(raw);
                    handleUiChange(key, next === '' ? Number.NaN : next);
                }}
                onBlur={() => {
                    // A floor that is itself out of range (typed, not yet refused) is not a value to clamp up to.
                    const floor = atLeastKey ? uiValues[atLeastKey] : null;
                    if (!outOfRange && floor !== null && parsed < floor && floor <= range.max) {
                        handleUiChange(key, floor);
                    }
                }}
            />
            {outOfRange && (
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
                        // Closing the field is this Escape's whole job: the modal stays open.
                        e.stopPropagation();
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
        <ResettableUiCell inputId="ui-theme" {...APPLICATION_CELLS.theme} onReset={() => handleResetUi('theme')}>
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
            {...APPLICATION_CELLS.language}
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
        <UiSettingCell inputId="ui-timezone" {...APPLICATION_CELLS.timezone}>
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
                    {BUILT_IN_TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>
                            {tz}
                        </option>
                    ))}
                    {customTimezones
                        .filter((tz) => !BUILT_IN_TIMEZONES.includes(tz))
                        .map((tz) => (
                            <option key={tz} value={tz}>
                                {tz}
                            </option>
                        ))}
                    {!BUILT_IN_TIMEZONES.includes(timezone) && !customTimezones.includes(timezone) && (
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
                    className={`btn btn-error btn-sm ${BUILT_IN_TIMEZONES.includes(timezone) ? 'invisible' : ''}`}
                    title={t('app.removeCurrentTimezone')}
                    aria-label={t('app.removeCurrentTimezone')}
                    onClick={timezoneInput.remove}
                >
                    ×
                </button>
                <ResetButton
                    label={resetLabel(t, APPLICATION_CELLS.timezone.labelKey)}
                    onClick={() => handleResetUi('timezone')}
                />
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
 * (rewards, missions, notifications, display) and the About and data block the modal renders below them.
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
        <SettingsSectionPanel id="application" title={t(SETTINGS_SECTION_TITLES.application)}>
            <div className={SETTINGS_GRID_CLASS}>
                <ThemeSetting {...ui} />
                <LanguageSetting {...ui} />
                <TimezoneSetting {...ui} timezoneInput={timezoneInput} />

                <UiNumberGroupCell
                    {...ui}
                    inputId="ui-checkFrequency"
                    {...APPLICATION_CELLS.checkFrequency}
                    fields={CHECK_FREQUENCY_FIELDS}
                    suffix={<span className="text-sm">{t('app.minutes')}</span>}
                />

                <UiNumberGroupCell
                    {...ui}
                    inputId="ui-reliability"
                    {...APPLICATION_CELLS.reliability}
                    fields={RELIABILITY_FIELDS}
                />
            </div>
            {children}
        </SettingsSectionPanel>
    );
}
