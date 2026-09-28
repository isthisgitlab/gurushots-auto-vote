/**
 * Types shared by the settings-editing components (the global and
 * per-challenge settings modals and their fields, src/js/react/components/app/
 * Setting*.jsx and friends). Type-only: nothing here exists at runtime.
 */
import type { SerializableSchemaEntry } from '../ipc/settings.handlers';
import type { getUiDefaultSettings } from '../settings/uiDefaults';

/** The settings schema as get-settings-schema sends it: key -> projected entry (no validators). */
export type RendererSchema = Record<string, SerializableSchemaEntry>;

/** Translation lookup handed to the pure helpers (the `t` of useTranslation). */
export type Translate = (key: string) => string;

/** A settings field's change callback: the setting key and its new value. */
export type SettingChangeHandler = (key: string, value: unknown) => void;

/** A settings field's per-key reset. */
export type SettingResetHandler = (key: string) => void;

/** One inline hint under a setting: DaisyUI text-colour classes plus the translated sentence. */
export interface SettingHint {
    tone: string;
    text: string;
}

/** A modal's per-setting hint resolver. */
export type HintsFor = (key: string) => SettingHint[];

/**
 * The props every schema-driven field component receives (SettingInput's
 * FIELD_BY_TYPE). `value` is already normalised against the schema default but
 * still untrusted (a hand-edited settings file), so each field narrows it.
 * `onReset` null/absent = the field has no reset button.
 */
export interface SettingFieldProps {
    id: string;
    settingKey: string;
    config: SerializableSchemaEntry;
    value: unknown;
    onChange: SettingChangeHandler;
    onReset?: SettingResetHandler | null;
    disabled?: boolean;
}

/** The application (UI, non-schema) settings the global modal edits. */
export type UiValues = ReturnType<typeof getUiDefaultSettings>;

/** Change one UI setting in the global modal's form state. */
export type UiChangeHandler = <K extends keyof UiValues>(key: K, value: UiValues[K]) => void;

/** Reset one UI setting in the global modal's form state to its default. */
export type UiResetHandler = (key: keyof UiValues) => void;
