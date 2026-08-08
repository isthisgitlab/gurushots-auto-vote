import { useState, useEffect, useCallback, useRef } from 'react';
import { getUiDefaultSettings } from '../../settings/uiDefaults';

/**
 * Module-scope defaults for the UI settings half of the modal. Sourced
 * from the same module settings.js getDefaultSettings() spreads
 * (settings/uiDefaults), so the form can never drift from the storage
 * layer; kept out of the hook body so per-setting reset and reset-all
 * share one object.
 */
export const DEFAULT_UI_VALUES = getUiDefaultSettings();

/**
 * Per-key fallback with the same semantics the hand-written init used:
 * arrays keep the Array.isArray guard, strings treat '' as unset (||),
 * and numeric/boolean keys use ?? so an explicit 0 / false from settings
 * is preserved rather than silently replaced by the default.
 */
const withFallback = (value, defaultValue) => {
    if (Array.isArray(defaultValue)) return Array.isArray(value) ? value : defaultValue;
    if (typeof defaultValue === 'string') return value || defaultValue;
    return value ?? defaultValue;
};

/**
 * Owns the form state behind the global Settings modal: hydrate-on-open,
 * UI vs schema-default tracking, change/reset handlers, plus a
 * `commit()` / `revert()` pair the caller drives from its Save / Cancel
 * buttons. The caller stays responsible for the surrounding lifecycle
 * (close, language toggle, threshold-scheduling notify, theme DOM revert).
 */
export function useSettingsForm({
    isOpen,
    schema,
    defaults,
    settings,
    refetchSettings,
    refetchSchema,
    updateSetting,
    // Optional: caller can override the persistence channel for global
    // defaults (default goes through window.api.setGlobalDefault). Tests
    // and alt-modal callers can pass a wrapper here without monkey-
    // patching window.api.
    setGlobalDefault = (key, value) => window.api.setGlobalDefault(key, value),
}) {
    const [formValues, setFormValues] = useState({});
    const [uiValues, setUiValues] = useState(DEFAULT_UI_VALUES);
    const [originalUiValues, setOriginalUiValues] = useState(null);
    const [originalFormValues, setOriginalFormValues] = useState(null);
    const [saving, setSaving] = useState(false);

    // Refetch from disk every time the modal opens so we never display
    // a value that another writer (CLI, another window) has since changed.
    useEffect(() => {
        if (isOpen) {
            refetchSettings();
            refetchSchema();
        }
    }, [isOpen, refetchSettings, refetchSchema]);

    // Init form values exactly once per open session. Without the guard,
    // each refetch produces a new defaults reference and re-runs this
    // effect, clobbering in-progress user edits.
    const formInitForOpenRef = useRef(false);
    const uiInitForOpenRef = useRef(false);
    useEffect(() => {
        if (!isOpen) {
            formInitForOpenRef.current = false;
            uiInitForOpenRef.current = false;
            return;
        }
        if (!formInitForOpenRef.current && defaults) {
            setFormValues({ ...defaults });
            setOriginalFormValues({ ...defaults });
            formInitForOpenRef.current = true;
        }
        if (!uiInitForOpenRef.current && settings) {
            const initialUiValues = {};
            for (const [key, defaultValue] of Object.entries(DEFAULT_UI_VALUES)) {
                initialUiValues[key] = withFallback(settings[key], defaultValue);
            }
            setUiValues(initialUiValues);
            setOriginalUiValues(initialUiValues);
            uiInitForOpenRef.current = true;
        }
    }, [isOpen, defaults, settings]);

    const handleFormChange = useCallback((key, value) => {
        setFormValues((prev) => ({ ...prev, [key]: value }));
    }, []);

    const handleUiChange = useCallback((key, value) => {
        setUiValues((prev) => ({ ...prev, [key]: value }));
        // Theme is the only UI value that touches the DOM live — applying
        // here keeps the change visible while the user is still editing.
        if (key === 'theme') {
            document.documentElement.setAttribute('data-theme', value);
        }
    }, []);

    const handleResetGlobal = useCallback(
        (key) => {
            if (schema && schema[key]) {
                setFormValues((prev) => ({ ...prev, [key]: schema[key].default }));
            }
        },
        [schema],
    );

    const handleResetUi = useCallback((key) => {
        setUiValues((prev) => ({ ...prev, [key]: DEFAULT_UI_VALUES[key] }));
        if (key === 'theme') {
            document.documentElement.setAttribute('data-theme', DEFAULT_UI_VALUES.theme);
        }
    }, []);

    const handleResetAll = useCallback(() => {
        if (schema) {
            const newFormValues = {};
            for (const [key, config] of Object.entries(schema)) {
                newFormValues[key] = config.default;
            }
            setFormValues(newFormValues);
        }
        setUiValues({ ...DEFAULT_UI_VALUES });
        document.documentElement.setAttribute('data-theme', DEFAULT_UI_VALUES.theme);
    }, [schema]);

    // Persist current UI + global-default values. The caller drives close
    // / language toggle / threshold notify around this call. Returns the
    // schema keys whose write was REJECTED (setGlobalDefault returns false
    // on schema/zod validation failure — e.g. a duplicate-count schedule)
    // so the caller can keep the modal open instead of silently dropping
    // the edit. The UI-values channel (updateSetting) has no comparable
    // return contract today, so only schema writes are checked here.
    const commit = useCallback(async () => {
        const rejectedKeys = [];
        setSaving(true);
        try {
            for (const [key, value] of Object.entries(uiValues)) {
                await updateSetting(key, value);
            }
            for (const [key, value] of Object.entries(formValues)) {
                const saved = await setGlobalDefault(key, value);
                if (saved === false) rejectedKeys.push(key);
            }
        } finally {
            setSaving(false);
        }
        // Note: not atomic — a mid-loop throw leaves earlier writes
        // persisted. revert() rolls in-memory React state only; an
        // IPC-level transaction would need broader settings layer
        // changes (out of scope for this hook).
        return rejectedKeys;
    }, [formValues, uiValues, updateSetting, setGlobalDefault]);

    // Roll in-memory state back to whatever the modal opened with. Theme
    // DOM revert is up to the caller — it owns the close sequence and may
    // want to skip the DOM write if the user never touched the theme.
    const revert = useCallback(() => {
        if (originalUiValues) setUiValues(originalUiValues);
        if (originalFormValues) setFormValues(originalFormValues);
    }, [originalUiValues, originalFormValues]);

    return {
        formValues,
        uiValues,
        saving,
        originalUiValues,
        originalFormValues,
        handleFormChange,
        handleUiChange,
        handleResetGlobal,
        handleResetUi,
        handleResetAll,
        commit,
        revert,
    };
}
