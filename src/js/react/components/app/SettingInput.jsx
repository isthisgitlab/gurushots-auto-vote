import { useTranslation } from '@/contexts/TranslationContext';
import { useListDraft, LIST_FINGERPRINT_SEP } from '@/hooks/useListDraft';
import { SettingResetButton } from './SettingResetButton';
import { TimeField, ScheduleField, TimeOfDayListField, TimeListField } from './TimeSettingFields';
import { useScenarios } from '@/api/useScenarios';
import { interp } from '@/utils/interp';

export { SCHEDULED_FILL_MAX_ENTRIES } from './TimeSettingFields';

// Setting types rendered as several controls (each with its own aria-label)
// rather than one: their caption names a role="group" wrapper instead of
// pointing a <label> at a single control.
const GROUP_TYPES = new Set(['time', 'schedule', 'timeOfDayList', 'timeList']);

/**
 * Caption for a setting control, shared by the global and per-challenge
 * settings modals. A single-control setting gets a real <label> tied to the
 * control by `inputId`; a multi-control one (`group`, derived from the schema
 * `type` for SettingInput) gets a caption whose id `${inputId}-label` names the
 * control group.
 */
export function SettingLabel({ inputId, type, group = GROUP_TYPES.has(type), children }) {
    if (group) {
        return (
            <div className="label" id={`${inputId}-label`}>
                {children}
            </div>
        );
    }
    return (
        <label className="label" htmlFor={inputId}>
            {children}
        </label>
    );
}

/** One-line setting control(s) followed by the setting's reset button. */
function ControlRow({ settingKey, onReset, children }) {
    return (
        <div className="flex items-center gap-2">
            {children}
            <SettingResetButton settingKey={settingKey} onReset={onReset} />
        </div>
    );
}

// Callers pass TagsField's already-normalised array, so no guard is needed here.
const tagsArrayToText = (arr) => arr.join(', ');
const tagsTextToArray = (text) =>
    text
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
const tagsDraftKey = (text) => tagsTextToArray(text).join(LIST_FINGERPRINT_SEP);

/**
 * Tag list editor. Tracks the raw text locally so the user can type
 * commas and trailing spaces without the array round-trip eating them
 * mid-keystroke. Re-syncs when the array prop is replaced from outside
 * (reset button, reload).
 */
export function TagsField({ id, settingKey, value, onChange, onReset, placeholder, disabled = false }) {
    const arr = Array.isArray(value) ? value : [];
    const [draft, setDraft] = useListDraft(arr, tagsArrayToText, tagsDraftKey);

    const handleChange = (e) => {
        setDraft(e.target.value);
        onChange(settingKey, tagsTextToArray(e.target.value));
    };

    return (
        <ControlRow settingKey={settingKey} onReset={onReset}>
            <input
                id={id}
                type="text"
                className="input input-sm flex-1"
                placeholder={placeholder}
                value={draft}
                onChange={handleChange}
                disabled={disabled}
            />
        </ControlRow>
    );
}

/** A schema `tags` setting: TagsField with the shared placeholder. */
function TagsSetting({ id, settingKey, value, onChange, onReset, disabled }) {
    const { t } = useTranslation();
    return (
        <TagsField
            id={id}
            settingKey={settingKey}
            value={value}
            onChange={onChange}
            onReset={onReset}
            placeholder={t('app.tagsPlaceholder')}
            disabled={disabled}
        />
    );
}

function BooleanField({ id, settingKey, value, onChange, onReset, disabled }) {
    return (
        <ControlRow settingKey={settingKey} onReset={onReset}>
            <input
                id={id}
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={!!value}
                onChange={(e) => onChange(settingKey, e.target.checked)}
                disabled={disabled}
            />
        </ControlRow>
    );
}

/**
 * Whether a number field's value is outside what the schema accepts. An
 * emptied field counts as invalid in its own right: `Number('')` is 0, so for
 * the settings whose min is 0 (exposureTarget, finalWindowExposureTarget, and
 * the two entry-slot indexes) a blank field would otherwise look in-range — no
 * border, no message — while Save writes '' straight through to zod, which
 * rejects it with the generic "check the highlighted values" banner and
 * nothing highlighted.
 */
function isNumberInvalid(value, { min, max }) {
    if (value === '' || value === null || value === undefined) return true;
    const numeric = Number(value);
    return (
        !Number.isFinite(numeric) ||
        (typeof min === 'number' && numeric < min) ||
        (typeof max === 'number' && numeric > max)
    );
}

function numberRangeMessage({ min, max }, t) {
    const hasMin = typeof min === 'number';
    if (hasMin && typeof max === 'number') {
        return t('app.validationOutOfRange').replace('{min}', min).replace('{max}', max);
    }
    return hasMin ? t('app.validationAtLeast').replace('{min}', min) : t('app.validationInvalidValue');
}

/**
 * Parse a number input's raw text. Clearing the field keeps it empty ('')
 * rather than writing 0, which zod rejects for min-1 keys like exposure — the
 * range check then explains the blank instead of a save failure for a value
 * the user never typed.
 */
function parseNumberInput(raw) {
    if (raw === '') return '';
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? '' : parsed;
}

function NumberField({ id, settingKey, config, value, onChange, onReset, disabled }) {
    const { t } = useTranslation();
    const invalid = isNumberInvalid(value, config);
    return (
        <div className="flex flex-col gap-1">
            <ControlRow settingKey={settingKey} onReset={onReset}>
                <input
                    id={id}
                    type="number"
                    className={`input input-sm w-24 ${invalid ? 'input-error' : ''}`}
                    min={config.min}
                    max={config.max}
                    value={value}
                    onChange={(e) => onChange(settingKey, parseNumberInput(e.target.value))}
                    disabled={disabled}
                />
                {config.unit && <span className="text-sm">{t(config.unit)}</span>}
            </ControlRow>
            {invalid && <span className="text-error text-xs">{numberRangeMessage(config, t)}</span>}
        </div>
    );
}

function TextField({ id, settingKey, value, onChange, onReset, disabled }) {
    return (
        <ControlRow settingKey={settingKey} onReset={onReset}>
            <input
                id={id}
                type="text"
                className="input input-sm"
                value={value}
                onChange={(e) => onChange(settingKey, e.target.value)}
                disabled={disabled}
            />
        </ControlRow>
    );
}

/**
 * The `scenario` assignment: a pick of the stored scenarios ('' = none). A
 * name that no longer exists stays visible — marked as missing — so the user
 * sees the stale assignment instead of it silently reading as "none".
 */
function ScenarioField({ id, settingKey, value, onChange, onReset, disabled }) {
    const { t } = useTranslation();
    const { scenarios } = useScenarios();
    const names = Object.keys(scenarios);
    const current = String(value);
    const selected = names.find((name) => name.toLowerCase() === current.toLowerCase()) ?? current;
    const missing = current !== '' && !names.includes(selected);
    return (
        <ControlRow settingKey={settingKey} onReset={onReset}>
            <select
                id={id}
                className="select select-sm"
                value={selected}
                onChange={(e) => onChange(settingKey, e.target.value)}
                disabled={disabled}
            >
                <option value="">{t('app.scenarioNone')}</option>
                {names.map((name) => (
                    <option key={name} value={name}>
                        {name}
                    </option>
                ))}
                {missing && (
                    <option value={current}>{interp(t('app.scenarioMissingOption'), { name: current })}</option>
                )}
            </select>
        </ControlRow>
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

// Field component per schema `type`; anything else renders as a text input.
// Every field takes the same props: { id, settingKey, config, value, onChange,
// onReset, disabled }. The timeOfDayList values look device-local but are
// interpreted in the app timezone setting — the surrounding modal renders a
// hint naming the zone.
const FIELD_BY_TYPE = new Map([
    ['tags', TagsSetting],
    ['schedule', ScheduleField],
    ['timeOfDayList', TimeOfDayListField],
    ['timeList', TimeListField],
    ['time', TimeField],
    ['boolean', BooleanField],
    ['number', NumberField],
    ['scenario', ScenarioField],
]);

// Row-list fields render inside a role="group" wrapper named by the
// SettingLabel caption; TimeField carries that role on its own row.
const GROUP_WRAPPED_TYPES = new Set(['schedule', 'timeOfDayList', 'timeList']);

/**
 * Schema-driven input renderer for settings. `id` goes on the control a
 * SettingLabel with the same `inputId` points at; multi-control types instead
 * render a role="group" named by that caption (see SettingLabel).
 */
export function SettingInput({
    settingKey,
    config,
    value,
    onChange,
    onReset,
    disabled = false,
    id = `setting-${settingKey}`,
}) {
    // Guard against missing config
    if (!config) {
        return null;
    }

    const Field = FIELD_BY_TYPE.get(config.type) ?? TextField;
    const field = (
        <Field
            id={id}
            settingKey={settingKey}
            config={config}
            // Normalize value to prevent uncontrolled-to-controlled transitions
            value={value ?? config.default ?? getDefaultForType(config.type)}
            onChange={onChange}
            onReset={onReset}
            disabled={disabled}
        />
    );
    if (!GROUP_WRAPPED_TYPES.has(config.type)) return field;
    return (
        <div role="group" aria-labelledby={`${id}-label`}>
            {field}
        </div>
    );
}
