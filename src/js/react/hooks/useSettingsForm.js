import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Module-scope defaults for the UI settings half of the modal. Kept out
 * of the hook body so per-setting reset and reset-all share one source of
 * truth (the original component duplicated this object three times).
 */
export const DEFAULT_UI_VALUES = {
    theme: 'light',
    language: 'en',
    timezone: 'Europe/Riga',
    customTimezones: [],
    stayLoggedIn: false,
    // Stored as seconds — settings.js sets default 30 and api-client.js
    // multiplies by 1000 before handing to axios. The pre-refactor modal
    // used 30000 here, which silently corrupted the stored timeout to
    // ~8h on the first Save. Aligned with the storage layer.
    apiTimeout: 30,
    checkFrequencyMin: 3,
    checkFrequencyMax: 3,
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
            const initialUiValues = {
                theme: settings.theme || 'light',
                language: settings.language || 'en',
                timezone: settings.timezone || 'Europe/Riga',
                customTimezones: Array.isArray(settings.customTimezones) ? settings.customTimezones : [],
                stayLoggedIn: settings.stayLoggedIn || false,
                apiTimeout: settings.apiTimeout || 30,
                checkFrequencyMin: settings.checkFrequencyMin ?? 3,
                checkFrequencyMax: settings.checkFrequencyMax ?? 3,
            };
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
    // / language toggle / threshold notify around this call.
    const commit = useCallback(async () => {
        setSaving(true);
        try {
            for (const [key, value] of Object.entries(uiValues)) {
                await updateSetting(key, value);
            }
            for (const [key, value] of Object.entries(formValues)) {
                await setGlobalDefault(key, value);
            }
        } finally {
            setSaving(false);
        }
        // Note: not atomic — a mid-loop throw leaves earlier writes
        // persisted. revert() rolls in-memory React state only; an
        // IPC-level transaction would need broader settings layer
        // changes (out of scope for this hook).
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
