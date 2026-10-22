import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettings } from '@/api/useSettings';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { useTitleRules } from '@/hooks/useTitleRules';
import { useCustomTimezoneInput } from '@/hooks/useCustomTimezoneInput';
import { useAutovote } from '@/contexts/AutovoteContext';
import {
    SettingsNavProvider,
    SETTINGS_SECTION_TITLES,
    settingsSections,
    settingsTabId,
    useSettingsNav,
    useSettingsNavState,
} from '@/contexts/SettingsNavContext';
import {
    tierSchemaEntries,
    bandTabs,
    entryMatchesFilter,
    groupMatchesFilter,
    SETTINGS_GRID_CLASS,
    SETTING_CELL_CLASS,
} from '@/utils/groupSettings';
import { matchesSettingFilter } from '@/utils/matchesSettingFilter';
import { Modal } from '@/components/ui/Modal';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { UnsavedChangesModal } from '@/components/ui/UnsavedChangesModal';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { ModalActionRow } from '@/components/ui/ModalActionRow';
import { STICKY_FOOTER_SCROLL_PADDING } from '@/components/ui/StickyModalFooter';
import { SettingsTierIntro } from '@/components/ui/SettingsTierIntro';
import { SettingHelp } from '@/components/ui/SettingHelp';
import { SettingInput, SettingLabel } from './SettingInput';
import { SettingHintList, globalSettingHints } from './SettingHints';
import { ApplicationSettingsSection, applicationCellTexts } from './ApplicationSettingsSection';
import { SettingsNavBar, SettingsNoMatch, SETTINGS_NAV_SCROLL_PADDING } from './SettingsNavBar';
import { SettingsSectionPanel } from './SettingsSectionPanel';
import { TitleTagRulesEditor } from './TitleTagRulesEditor';
import { ScenariosSection } from './ScenariosSection';
import { AboutDataSection } from './AboutDataSection';
import * as ipc from '@/api/ipc';

import type { SettingsSection, SettingsTabId } from '@/utils/groupSettings';
import type { TabDescriptor } from '@/components/ui/Tabs';
import type { HintsFor, SettingChangeHandler, SettingResetHandler } from '../../../types/settingsEditor';
import { errorMessage } from '../../../errorMessage';

/**
 * The form state every schema-driven setting input reads and writes.
 */
type SchemaFormProps = {
    formValues: Record<string, unknown>;
    handleFormChange: SettingChangeHandler;
    handleResetGlobal: SettingResetHandler;
    hintsFor: HintsFor;
    /** The settings the last Save refused: their inputs are marked invalid. */
    rejectedKeys: readonly string[];
};

// The tier of app-wide settings (rewards, missions, notifications, display).
// They render with the Application tab, not as a tier tab of their own.
const APP_TIER = 'app';

// The modal box's classes. The fixed height is a deliberate 5em gutter below the base
// .modal-box max-height: 100vh, so switching to a short tab cannot shrink and re-centre the
// box and move the tab row under the pointer; flex-col plus the footer's mt-auto keep Save /
// Reset all / Cancel at the bottom on a short tab. The height and flex apply once the tabbed
// form shows — the first-load spinner keeps the plain auto-height box.
const SETTINGS_MODAL_BOX_CLASS = `${STICKY_FOOTER_SCROLL_PADDING} ${SETTINGS_NAV_SCROLL_PADDING}`;
const SETTINGS_MODAL_FORM_BOX_CLASS = `${SETTINGS_MODAL_BOX_CLASS} h-[calc(100vh-5em)] flex flex-col`;

// Challenge types seen on the live API (verified 2026-09-19). Suggestions for
// the rule type field only — it stays free text, so a type this build has never
// seen can still be typed in.
const RULE_TYPE_SUGGESTIONS = ['default', 'exhibition', 'flash', 'speed'];

/**
 * One schema-driven settings group: its heading and a grid of inputs. The
 * "Global default" badge marks only settings a challenge can override. The
 * heading is an h5: the modal titles itself with an h3 and every panel opens
 * with an sr-only h4 (Tabs.tsx), so a group directly under a panel is an h5.
 */
function SchemaSettingsGroup({
    group,
    formValues,
    handleFormChange,
    handleResetGlobal,
    hintsFor,
    rejectedKeys,
}: { group: SettingsSection } & SchemaFormProps) {
    const { t } = useTranslation();
    const { query } = useSettingsNav();
    return (
        <div className={`mb-4 ${groupMatchesFilter(t, group, query) ? '' : 'hidden'}`}>
            <h5 className="font-medium text-sm opacity-70 mb-2 mt-3">{t(group.label)}</h5>
            <div className={SETTINGS_GRID_CLASS}>
                {group.entries.map(([key, config]) => (
                    <div
                        key={key}
                        className={`${SETTING_CELL_CLASS} ${entryMatchesFilter(t, config, query) ? '' : 'hidden'}`}
                    >
                        <SettingLabel inputId={`setting-${key}`} type={config.type}>
                            <span className="font-medium">{t(config.label)}</span>
                            {config.perChallenge && (
                                <span className="badge badge-ghost badge-sm ml-2">{t('app.globalDefault')}</span>
                            )}
                        </SettingLabel>
                        <p className="text-xs text-base-content/70 mb-2">{t(config.description)}</p>
                        <SettingHelp helpKey={config.helpKey} />
                        <SettingInput
                            settingKey={key}
                            config={config}
                            value={formValues[key] ?? config.default}
                            onChange={handleFormChange}
                            onReset={handleResetGlobal}
                            rejected={rejectedKeys.includes(key)}
                        />
                        <SettingHintList hints={hintsFor(key)} />
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Challenge (title-tag) rules: matched on what survives a challenge's id rotation.
 */
function TitleRulesSection({ titleRules }: { titleRules: ReturnType<typeof useTitleRules> }) {
    const { t } = useTranslation();
    return (
        <SettingsSectionPanel id="titleRules" title={t(SETTINGS_SECTION_TITLES.titleRules)}>
            <p className="text-xs text-base-content/70 mb-3">{t('app.titleTagRulesDesc')}</p>
            {titleRules.error && (
                <div className="alert alert-error mb-3 py-2 text-sm" role="alert">
                    <span>{t('app.titleTagRulesSaveError')}</span>
                </div>
            )}
            {/* No editing until the rules have loaded: an edit made meanwhile
                would be overwritten by the load or skipped by the save. */}
            {titleRules.loading ? (
                <InlineLoader text={t('common.loading')} />
            ) : titleRules.loadFailed ? (
                <div className="alert alert-error py-2 text-sm" role="alert">
                    <span>{t('app.titleTagRulesLoadError')}</span>
                </div>
            ) : (
                <TitleTagRulesEditor
                    value={titleRules.rules}
                    profiles={titleRules.profiles}
                    types={RULE_TYPE_SUGGESTIONS}
                    onChange={titleRules.change}
                />
            )}
        </SettingsSectionPanel>
    );
}

/**
 * Global settings modal
 */
export function SettingsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { t, language, setLanguage } = useTranslation();
    const { rearmSchedule } = useAutovote();
    const { settings, updateSetting, refetch: refetchSettings } = useSettings();
    const { schema, defaults, groups, tiers, refetch: refetchSchema, loading: schemaLoading } = useSettingsSchema();

    const {
        formValues,
        uiValues,
        saving,
        handleFormChange,
        handleUiChange,
        handleResetGlobal,
        handleResetUi,
        handleResetAll,
        commit,
        revert,
        isDirty: formIsDirty,
        getPersistedTheme,
    } = useSettingsForm({
        isOpen,
        schema,
        defaults,
        settings,
        refetchSettings,
        refetchSchema,
        updateSetting,
    });

    const bands = tierSchemaEntries(schema, groups, tiers);
    const appGroups = bands.filter((band) => band.id === APP_TIER).flatMap((band) => band.groups);
    const defaultsBands = bands.filter((band) => band.id !== APP_TIER);
    const defaultsTabs = bandTabs(defaultsBands);
    const sections = settingsSections(defaultsBands);

    // Which tabs have a setting (or, for the tabs without any, a heading) matching the filter.
    const nav = useSettingsNavState(
        sections.map(({ id }) => id),
        (query, id) => {
            if (id === 'application') {
                return (
                    matchesSettingFilter(applicationCellTexts(t), query) ||
                    appGroups.some((group) => groupMatchesFilter(t, group, query))
                );
            }
            if (id === 'titleRules') return matchesSettingFilter([t(SETTINGS_SECTION_TITLES.titleRules)], query);
            if (id === 'scenarios') return matchesSettingFilter([t(SETTINGS_SECTION_TITLES.scenarios)], query);
            if (id === 'about') return matchesSettingFilter([t(SETTINGS_SECTION_TITLES.about)], query);
            const index = defaultsTabs.findIndex((tab) => tab.id === id);
            return index !== -1 && defaultsBands[index].groups.some((group) => groupMatchesFilter(t, group, query));
        },
    );
    const resetNav = nav.reset;

    const timezoneInput = useCustomTimezoneInput({ isOpen, uiValues, handleUiChange });
    const titleRules = useTitleRules(isOpen);
    const persistTitleRules = titleRules.persist;
    // True when commit() reported schema writes rejected by validation —
    // shown as an alert and the modal stays open (mirrors titleRules.error).
    const [saveError, setSaveError] = useState(false);
    // The keys commit() reported, so each one's input — and its tab — can say it was refused.
    const [rejectedKeys, setRejectedKeys] = useState<string[]>([]);
    // Element ids a failed Save moves focus to (the first that exists), set as data and applied after the render
    // that marks the inputs invalid.
    const [focusIds, setFocusIds] = useState<string[] | null>(null);
    // The scenario builder's unsaved draft, reported by the section: the modal's Save does not save it.
    const [scenarioDirty, setScenarioDirty] = useState(false);
    // The question on screen: dismissing with unsaved edits, or saving with work Save would drop.
    const [asking, setAsking] = useState<'discard' | 'drop' | null>(null);

    // One question per opening, and no draft carried over from the last one: the modal stays mounted while closed.
    useEffect(() => {
        if (isOpen) {
            setSaveError(false);
            setRejectedKeys([]);
            setScenarioDirty(false);
            resetNav();
        } else {
            setAsking(null);
        }
    }, [isOpen, resetNav]);

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
        !(schemaLoading && !schema) && (formIsDirty() || titleRules.isDirty() || timezoneInput.dirty || scenarioDirty);

    // Esc, the backdrop, the close button and Cancel: edits that are not saved are not thrown away unasked.
    const dismiss = () => (hasUnsavedEdits() ? setAsking('discard') : handleCancel());

    // What Save does not write: it is lost when the modal closes.
    const droppedWork = [
        timezoneInput.dirty && 'app.settingsDropTimezone',
        scenarioDirty && 'app.settingsDropScenario',
    ].filter((key): key is string => typeof key === 'string');

    // The element a refused key's input carries: a UI key's `ui-` id (the custom zones are edited through the
    // timezone select), else the schema input's `setting-` id.
    const focusIdOf = useCallback(
        (key: string) => {
            if (!(key in uiValues)) return `setting-${key}`;
            return key === 'customTimezones' ? 'ui-timezone' : `ui-${key}`;
        },
        [uiValues],
    );

    // The section a refused key's input sits in: a UI key in Application, a schema key in the
    // tab of its tier band (an app-tier key in Application too).
    const sectionOfKey = (key: string): SettingsTabId | null => {
        if (key in uiValues) return 'application';
        if (appGroups.some((group) => group.entries.some(([entryKey]) => entryKey === key))) return 'application';
        const index = defaultsBands.findIndex((band) =>
            band.groups.some((group) => group.entries.some(([entryKey]) => entryKey === key)),
        );
        return index === -1 ? null : defaultsTabs[index].id;
    };

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
                const section = rejected.map(sectionOfKey).find((id) => id !== null);
                if (section) nav.reveal(section);
                setFocusIds(rejected.map(focusIdOf));
                return;
            }
            setSaveError(false);
            // Title rules are rejected as a whole (e.g. a tag over the length
            // cap); the hook surfaces that and the modal stays open.
            if (!(await persistTitleRules())) {
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

    const handleSave = () => (droppedWork.length > 0 ? setAsking('drop') : runSave());

    if (!isOpen) return null;

    const hintsFor = globalSettingHints({ formValues, schema, timezone: uiValues.timezone, t });
    const schemaForm = { formValues, handleFormChange, handleResetGlobal, hintsFor, rejectedKeys };

    // The tabs holding a refused key: like the inputs' invalid state, the marks come from
    // rejectedKeys and clear on the next Save or on reopen, not as the user edits.
    const refusedTabs = new Set<SettingsTabId>();
    for (const key of rejectedKeys) {
        const section = sectionOfKey(key);
        if (section !== null) refusedTabs.add(section);
    }
    const navTabs: Array<TabDescriptor<SettingsTabId>> = sections.map(({ id, label }) => ({
        id,
        label: t(label),
        hidden: !nav.isShown(id),
        invalid: refusedTabs.has(id),
    }));
    const anyShown = sections.some((section) => nav.isShown(section.id));

    return (
        <>
            <Modal
                isOpen={isOpen}
                onClose={dismiss}
                title={t('app.globalSettings')}
                size="2xl"
                className={schemaLoading && !schema ? SETTINGS_MODAL_BOX_CLASS : SETTINGS_MODAL_FORM_BOX_CLASS}
            >
                {/* Spinner only for the first load: every settings write broadcasts a
                change that refetches the schema, and swapping the form out for the
                spinner on each of those background refreshes made Save flicker. */}
                {schemaLoading && !schema ? (
                    <InlineLoader text={t('common.loading')} />
                ) : (
                    <SettingsNavProvider value={nav}>
                        <SettingsNavBar tabs={navTabs} />
                        {!anyShown && <SettingsNoMatch />}
                        <ApplicationSettingsSection
                            uiValues={uiValues}
                            handleUiChange={handleUiChange}
                            handleResetUi={handleResetUi}
                            rejectedKeys={rejectedKeys}
                            timezoneInput={timezoneInput}
                        >
                            {appGroups.map((group) => (
                                <SchemaSettingsGroup key={group.id} group={group} {...schemaForm} />
                            ))}
                        </ApplicationSettingsSection>
                        {defaultsBands.map((band, index) => {
                            const tab = defaultsTabs[index];
                            return (
                                <SettingsSectionPanel key={tab.id} id={tab.id} title={t(tab.label)}>
                                    <SettingsTierIntro id={band.id} defaultsNote />
                                    {band.groups.map((group) => (
                                        <SchemaSettingsGroup key={group.id} group={group} {...schemaForm} />
                                    ))}
                                </SettingsSectionPanel>
                            );
                        })}
                        <TitleRulesSection titleRules={titleRules} />
                        <ScenariosSection isOpen={isOpen} onDirtyChange={setScenarioDirty} />
                        <AboutDataSection />
                        <ModalActionRow
                            className="mt-auto"
                            onSave={handleSave}
                            saving={saving}
                            onSecondary={handleResetAll}
                            secondaryLabel={t('app.resetAll')}
                            onCancel={dismiss}
                            saveError={saveError}
                        />
                    </SettingsNavProvider>
                )}
            </Modal>
            <UnsavedChangesModal
                isOpen={asking === 'discard'}
                onKeepEditing={() => setAsking(null)}
                onDiscard={() => {
                    setAsking(null);
                    handleCancel();
                }}
            />
            <ConfirmModal
                isOpen={asking === 'drop'}
                title={t('app.settingsDropTitle')}
                working={false}
                problem={null}
                onClose={() => setAsking(null)}
                onConfirm={() => {
                    setAsking(null);
                    void runSave();
                }}
                confirmLabel="app.settingsSaveWithout"
                cancelLabel="app.settingsKeepEditing"
                workingLabel="app.settingsSaveWithout"
            >
                <p>{t('app.settingsDropText')}</p>
                <ul className="list-disc ml-5">
                    {droppedWork.map((key) => (
                        <li key={key}>{t(key)}</li>
                    ))}
                </ul>
            </ConfirmModal>
        </>
    );
}
