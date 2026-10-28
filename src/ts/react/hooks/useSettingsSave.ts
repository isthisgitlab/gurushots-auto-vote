import { useCallback, useEffect, useState } from 'react';
import { settingsTabId } from '@/contexts/SettingsNavContext';
import * as ipc from '@/api/ipc';
import { errorMessage } from '../../errorMessage';

import type { SettingsNav } from '@/contexts/SettingsNavContext';
import type { SettingsBand, SettingsSection, SettingsTab, SettingsTabId } from '@/utils/groupSettings';
import type { useAutovote } from '@/contexts/AutovoteContext';
import type { useTranslation } from '@/contexts/TranslationContext';
import type { useSettingsSchema } from '@/api/useSettingsSchema';
import type { useSettingsForm } from '@/hooks/useSettingsForm';
import type { useTitleRules } from '@/hooks/useTitleRules';

type FormState = ReturnType<typeof useSettingsForm>;
type UiValues = FormState['uiValues'];

/**
 * The settings modal's save flow and its questions: the save outcome (the refused keys and
 * where their focus goes), the scenario draft's dirty flag, the question on screen, and the
 * handlers — dismiss, Save, Cancel and the Save itself. Split out of SettingsModal, which
 * renders from what this returns.
 */
type UseSettingsSaveDeps = {
    isOpen: boolean;
    nav: SettingsNav;
    titleRules: ReturnType<typeof useTitleRules>;
    /** The keys the form holds (the `ui-` inputs); a refused UI key is marked and focused there. */
    uiValues: UiValues;
    language: string;
    setLanguage: ReturnType<typeof useTranslation>['setLanguage'];
    schema: ReturnType<typeof useSettingsSchema>['schema'];
    schemaLoading: ReturnType<typeof useSettingsSchema>['loading'];
    commit: FormState['commit'];
    revert: FormState['revert'];
    getPersistedTheme: FormState['getPersistedTheme'];
    isDirty: FormState['isDirty'];
    timezoneDirty: boolean;
    appGroups: SettingsSection[];
    defaultsBands: SettingsBand[];
    defaultsTabs: SettingsTab[];
    onClose: () => void;
    rearmSchedule: ReturnType<typeof useAutovote>['rearmSchedule'];
};

// The element a refused key's input carries: a UI key's `ui-` id (the custom zones are edited through the
// timezone select), else the schema input's `setting-` id.
const focusIdOf = (key: string, uiValues: UiValues): string => {
    if (!(key in uiValues)) return `setting-${key}`;
    return key === 'customTimezones' ? 'ui-timezone' : `ui-${key}`;
};

// The section a refused key's input sits in: a UI key in Application, a schema key in the
// tab of its tier band (an app-tier key in Application too).
const sectionOfKey = (
    key: string,
    uiValues: UiValues,
    appGroups: SettingsSection[],
    defaultsBands: SettingsBand[],
    defaultsTabs: SettingsTab[],
): SettingsTabId | null => {
    if (key in uiValues) return 'application';
    if (appGroups.some((group) => group.entries.some(([entryKey]) => entryKey === key))) return 'application';
    const index = defaultsBands.findIndex((band) =>
        band.groups.some((group) => group.entries.some(([entryKey]) => entryKey === key)),
    );
    return index === -1 ? null : defaultsTabs[index].id;
};

/**
 * The save outcome: whether Save reported refused writes, the keys it refused, and the element
 * ids a failed Save moves focus to (the first that exists), applied after the render that marks
 * the inputs invalid.
 */
const useSaveFeedback = () => {
    // True when commit() reported schema writes rejected by validation —
    // shown as an alert and the modal stays open (mirrors titleRules.error).
    const [saveError, setSaveError] = useState(false);
    // The keys commit() reported, so each one's input — and its tab — can say it was refused.
    const [rejectedKeys, setRejectedKeys] = useState<string[]>([]);
    const [focusIds, setFocusIds] = useState<string[] | null>(null);

    useEffect(() => {
        if (!focusIds) return;
        setFocusIds(null);
        // The first target that exists takes focus; none may exist (the refused key's input was
        // gone by the time focus was looked for).
        focusIds
            .map((id) => document.getElementById(id))
            .find((target) => target !== null)
            ?.focus();
    }, [focusIds]);

    return { saveError, setSaveError, rejectedKeys, setRejectedKeys, setFocusIds };
};

/**
 * The Save button's work: writes the schema form, then the title rules, then a changed
 * language. A refusal at any step keeps the modal open, marks what was refused and moves focus
 * to the first refused key's section; only a fully landed Save closes and re-arms the cadence.
 */
const useRunSave = (deps: UseSettingsSaveDeps & ReturnType<typeof useSaveFeedback>) => {
    const {
        commit,
        setSaveError,
        setRejectedKeys,
        setFocusIds,
        nav,
        uiValues,
        language,
        setLanguage,
        titleRules,
        appGroups,
        defaultsBands,
        defaultsTabs,
        onClose,
        rearmSchedule,
    } = deps;
    const runSave = async () => {
        try {
            // commit() returns the schema keys whose write was rejected by
            // validation (e.g. a duplicate-count auto-fill schedule). Surface
            // that and keep the modal open — same rationale as the title-rules
            // check below — so the edit isn't silently lost behind a closed
            // modal that looked like a successful save.
            const rejected = await commit();
            setRejectedKeys(rejected);
            if (rejected.length > 0) {
                setSaveError(true);
                // The first refused key that has a section: the filter is cleared and its tab selected for the focus.
                const section = rejected
                    .map((key) => sectionOfKey(key, uiValues, appGroups, defaultsBands, defaultsTabs))
                    .find((id) => id !== null);
                if (section) nav.reveal(section);
                setFocusIds(rejected.map((key) => focusIdOf(key, uiValues)));
                return;
            }
            setSaveError(false);
            // Title rules are rejected as a whole (e.g. a tag over the length
            // cap); the hook surfaces that and the modal stays open.
            if (!(await titleRules.persist())) {
                nav.reveal('titleRules');
                // The rules have no single input: focus the tab button, which is visible and draws its own ring.
                setFocusIds([settingsTabId('titleRules')]);
                return;
            }
            // A language that fails to save keeps the modal open with the
            // save-error alert instead of closing on a change that didn't land.
            if (uiValues.language !== language && !(await setLanguage(uiValues.language))) {
                setSaveError(true);
                nav.reveal('application');
                setFocusIds([settingsTabId('application')]);
                return;
            }
            // Close first: the re-arm reads settings and fetches the active
            // challenges over the network, and the saved modal must not sit
            // open for that round-trip.
            onClose();
            // Re-arm the cadence timer so a changed threshold / scheduled-fill
            // setting takes effect now, not after the current wait elapses.
            await rearmSchedule();
        } catch (err) {
            await ipc.logRendererError(`Error saving settings: ${errorMessage(err) || err}`);
        }
    };
    return runSave;
};

/**
 * The two tab drafts the modal's Save does not write, reported by their
 * sections: the scenario builder's and the Profiles tab's. Both reset when the
 * modal opens — one question per opening, no draft carried over from the last
 * one.
 */
const useTabDraftFlags = (isOpen: boolean) => {
    const [scenarioDirty, setScenarioDirty] = useState(false);
    const [profileDirty, setProfileDirty] = useState(false);
    useEffect(() => {
        if (isOpen) {
            setScenarioDirty(false);
            setProfileDirty(false);
        }
    }, [isOpen]);
    return { scenarioDirty, setScenarioDirty, profileDirty, setProfileDirty };
};

export const useSettingsSave = (deps: UseSettingsSaveDeps) => {
    const {
        isOpen,
        nav,
        titleRules,
        uiValues,
        schema,
        schemaLoading,
        revert,
        getPersistedTheme,
        isDirty,
        timezoneDirty,
        appGroups,
        defaultsBands,
        defaultsTabs,
        onClose,
    } = deps;
    const { saveError, setSaveError, rejectedKeys, setRejectedKeys, setFocusIds } = useSaveFeedback();
    const resetNav = nav.reset;
    const { scenarioDirty, setScenarioDirty, profileDirty, setProfileDirty } = useTabDraftFlags(isOpen);
    // The question on screen: dismissing with unsaved edits, or saving with work Save would drop.
    const [asking, setAsking] = useState<'discard' | 'drop' | null>(null);

    // One question per opening: the modal stays mounted while closed.
    useEffect(() => {
        if (isOpen) {
            setSaveError(false);
            setRejectedKeys([]);
            resetNav();
        } else {
            setAsking(null);
        }
    }, [isOpen, resetNav, setSaveError, setRejectedKeys]);

    const handleCancel = useCallback(() => {
        // Put the persisted theme back on screen if the user previewed another one in this open session.
        const persistedTheme = getPersistedTheme();
        if (persistedTheme && persistedTheme !== uiValues.theme) {
            document.documentElement.setAttribute('data-theme', persistedTheme);
        }
        revert();
        onClose();
    }, [getPersistedTheme, uiValues.theme, revert, onClose]);

    // Read when the user acts, not at render: a Save that failed partway moved the persisted baselines after the
    // last render. Nothing is guarded while the form is still loading or has nothing to differ from.
    const hasUnsavedEdits = () =>
        !(schemaLoading && !schema) &&
        (isDirty() || titleRules.isDirty() || timezoneDirty || scenarioDirty || profileDirty);

    // Esc, the backdrop, the close button and Cancel: edits that are not saved are not thrown away unasked.
    const dismiss = () => (hasUnsavedEdits() ? setAsking('discard') : handleCancel());

    // What Save does not write: it is lost when the modal closes.
    const droppedWork = [
        timezoneDirty && 'app.settingsDropTimezone',
        scenarioDirty && 'app.settingsDropScenario',
        profileDirty && 'app.settingsDropProfile',
    ].filter((key): key is string => typeof key === 'string');

    // The tabs holding a refused key: like the inputs' invalid state, the marks come from
    // rejectedKeys and clear on the next Save or on reopen, not as the user edits.
    const refusedTabs = new Set<SettingsTabId>();
    for (const key of rejectedKeys) {
        const section = sectionOfKey(key, uiValues, appGroups, defaultsBands, defaultsTabs);
        if (section !== null) refusedTabs.add(section);
    }

    const runSave = useRunSave({ ...deps, saveError, setSaveError, rejectedKeys, setRejectedKeys, setFocusIds });
    const handleSave = () => (droppedWork.length > 0 ? setAsking('drop') : runSave());

    return {
        saveError,
        rejectedKeys,
        refusedTabs,
        scenarioDirty,
        setScenarioDirty,
        profileDirty,
        setProfileDirty,
        asking,
        setAsking,
        droppedWork,
        dismiss,
        handleSave,
        handleCancel,
        runSave,
    };
};
