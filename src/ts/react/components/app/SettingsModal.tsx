import { useTranslation } from '@/contexts/TranslationContext';
import { useSettings } from '@/api/useSettings';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useImportReport } from '@/api/useImportReport';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { useSettingsSave } from '@/hooks/useSettingsSave';
import { useTitleRules } from '@/hooks/useTitleRules';
import { useCustomTimezoneInput } from '@/hooks/useCustomTimezoneInput';
import { useAutovote } from '@/contexts/AutovoteContext';
import {
    SettingsNavProvider,
    SETTINGS_SECTION_TITLES,
    settingsSections,
    useSettingsNav,
    useSettingsNavState,
} from '@/contexts/SettingsNavContext';
import {
    tierSchemaEntries,
    bandTabs,
    entryMatchesFilter,
    groupMatchesFilter,
    groupFilterTexts,
    groupLabelMatchesFilter,
    SETTINGS_GRID_CLASS,
    SETTING_CELL_CLASS,
} from '@/utils/groupSettings';
import { matchesFilterTexts, matchesSettingFilter } from '@/utils/matchesSettingFilter';
import { Modal, TALL_MODAL_BOX_HEIGHT } from '@/components/ui/Modal';
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
import { ProfilesSection } from './ProfilesSection';
import { AboutDataSection, aboutDataTexts } from './AboutDataSection';

import type { ImportReport } from '@/api/useImportReport';
import type { SettingsBand, SettingsSection, SettingsTab, SettingsTabId } from '@/utils/groupSettings';
import type { SettingFilterTexts } from '@/utils/matchesSettingFilter';
import type { TabDescriptor } from '@/components/ui/Tabs';
import type { HintsFor, SettingChangeHandler, SettingResetHandler } from '../../../types/settingsEditor';

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

// The modal box's classes. The fixed height's 5em gutter is measured inside the system bars
// (safe-area insets, see TALL_MODAL_BOX_HEIGHT), so switching to a short tab cannot shrink and
// re-centre the box and move the tab row under the pointer; flex-col plus the footer's mt-auto keep Save /
// Reset all / Cancel at the bottom on a short tab. The height and flex apply once the tabbed
// form shows — the first-load spinner keeps the plain auto-height box.
const SETTINGS_MODAL_BOX_CLASS = `${STICKY_FOOTER_SCROLL_PADDING} ${SETTINGS_NAV_SCROLL_PADDING}`;
const SETTINGS_MODAL_FORM_BOX_CLASS = `${SETTINGS_MODAL_BOX_CLASS} ${TALL_MODAL_BOX_HEIGHT} flex flex-col`;

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
    showAll,
    formValues,
    handleFormChange,
    handleResetGlobal,
    hintsFor,
    rejectedKeys,
}: { group: SettingsSection; showAll?: boolean } & SchemaFormProps) {
    const { t } = useTranslation();
    const { query, namesOnly } = useSettingsNav();
    // The group's own heading matched (or the tab title did): the heading and every entry show.
    const labelShown = showAll || groupLabelMatchesFilter(t, group, query);
    return (
        <div className={`mb-4 ${showAll || groupMatchesFilter(t, group, query, namesOnly) ? '' : 'hidden'}`}>
            <h5 className="font-medium text-sm opacity-70 mb-2 mt-3">{t(group.label)}</h5>
            <div className={SETTINGS_GRID_CLASS}>
                {group.entries.map(([key, config]) => (
                    <div
                        key={key}
                        className={`${SETTING_CELL_CLASS} ${
                            labelShown || entryMatchesFilter(t, config, query, namesOnly) ? '' : 'hidden'
                        }`}
                    >
                        <SettingLabel inputId={`setting-${key}`} type={config.type} config={config}>
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
 * The two questions a close-with-unsaved-work can ask: discarding the edits, and saving without
 * the work Save does not write (each listed in the confirm's body).
 */
function UnsavedWorkDialogs({
    asking,
    setAsking,
    droppedWork,
    onDiscard,
    onSaveWithout,
}: {
    asking: 'discard' | 'drop' | null;
    setAsking: (asking: 'discard' | 'drop' | null) => void;
    droppedWork: string[];
    onDiscard: () => void;
    onSaveWithout: () => void;
}) {
    const { t } = useTranslation();
    return (
        <>
            <UnsavedChangesModal
                isOpen={asking === 'discard'}
                onKeepEditing={() => setAsking(null)}
                onDiscard={() => {
                    setAsking(null);
                    onDiscard();
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
                    onSaveWithout();
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

/**
 * The modal's filter wiring: every text one tab shows, which tabs survive the query, and
 * which tab titles matched — `appShowAll` for the Application tab, `tierShowAll`
 * index-aligned with `defaultsTabs` for the tier tabs. A title match shows the whole tab.
 */
function useSettingsModalFilter({
    t,
    sections,
    appGroups,
    defaultsBands,
    defaultsTabs,
    importReport,
}: {
    t: (key: string) => string;
    sections: readonly SettingsTab[];
    appGroups: readonly SettingsSection[];
    defaultsBands: readonly SettingsBand[];
    defaultsTabs: readonly SettingsTab[];
    importReport: ImportReport | null;
}) {
    // Every text the filter searches in one tab: the tab's own title, and the names and
    // descriptions of everything it renders.
    const sectionTexts = (id: SettingsTabId): SettingFilterTexts[] => {
        if (id === 'application') {
            return [
                { names: [t(SETTINGS_SECTION_TITLES.application)], descriptions: [] },
                ...applicationCellTexts(t),
                ...appGroups.flatMap((group) => groupFilterTexts(t, group)),
                aboutDataTexts(t, importReport !== null),
            ];
        }
        if (id === 'titleRules') return [{ names: [t(SETTINGS_SECTION_TITLES.titleRules)], descriptions: [] }];
        if (id === 'profiles') return [{ names: [t(SETTINGS_SECTION_TITLES.profiles)], descriptions: [] }];
        if (id === 'scenarios') return [{ names: [t(SETTINGS_SECTION_TITLES.scenarios)], descriptions: [] }];
        const index = defaultsTabs.findIndex((tab) => tab.id === id);
        return index !== -1
            ? [
                  { names: [t(defaultsTabs[index].label)], descriptions: [] },
                  ...defaultsBands[index].groups.flatMap((group) => groupFilterTexts(t, group)),
              ]
            : [];
    };

    // Which tabs survive the filter. A match on any name anywhere in the modal turns the
    // description search off in every tab (namesOnly).
    const nav = useSettingsNavState(
        sections.map(({ id }) => id),
        (query, id, namesOnly) => sectionTexts(id).some((texts) => matchesFilterTexts(texts, query, namesOnly)),
        (query) =>
            sections.some(({ id }) => sectionTexts(id).some((texts) => matchesSettingFilter(texts.names, query))),
    );

    // A tab title that matched shows the whole tab, however the rest of the filter reads.
    const appShowAll = matchesSettingFilter([t(SETTINGS_SECTION_TITLES.application)], nav.query);
    const tierShowAll = defaultsTabs.map((tab) => matchesSettingFilter([t(tab.label)], nav.query));

    return { nav, appShowAll, tierShowAll };
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

    // The About block's import heading counts as a name only while a report is shown. The modal is
    // always mounted, so the read and its settings-changed subscription run only while it is open;
    // reopening fetches fresh data.
    const { data: importReport } = useImportReport({ enabled: isOpen });

    const filter = useSettingsModalFilter({ t, sections, appGroups, defaultsBands, defaultsTabs, importReport });

    const timezoneInput = useCustomTimezoneInput({ isOpen, uiValues, handleUiChange });
    const titleRules = useTitleRules(isOpen);
    const save = useSettingsSave({
        isOpen,
        nav: filter.nav,
        titleRules,
        uiValues,
        language,
        setLanguage,
        schema,
        schemaLoading,
        commit,
        revert,
        getPersistedTheme,
        isDirty: formIsDirty,
        timezoneDirty: timezoneInput.dirty,
        appGroups,
        defaultsBands,
        defaultsTabs,
        onClose,
        rearmSchedule,
    });

    if (!isOpen) return null;

    const hintsFor = globalSettingHints({ formValues, schema, timezone: uiValues.timezone, t });
    const schemaForm = {
        formValues,
        handleFormChange,
        handleResetGlobal,
        hintsFor,
        rejectedKeys: save.rejectedKeys,
    };

    const navTabs: Array<TabDescriptor<SettingsTabId>> = sections.map(({ id, label }) => ({
        id,
        label: t(label),
        hidden: !filter.nav.isShown(id),
        invalid: save.refusedTabs.has(id),
    }));
    const anyShown = sections.some((section) => filter.nav.isShown(section.id));

    return (
        <>
            <Modal
                isOpen={isOpen}
                onClose={save.dismiss}
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
                    <SettingsNavProvider value={filter.nav}>
                        <SettingsNavBar tabs={navTabs} />
                        {!anyShown && <SettingsNoMatch />}
                        <ApplicationSettingsSection
                            uiValues={uiValues}
                            handleUiChange={handleUiChange}
                            handleResetUi={handleResetUi}
                            rejectedKeys={save.rejectedKeys}
                            timezoneInput={timezoneInput}
                            showAll={filter.appShowAll}
                        >
                            {appGroups.map((group) => (
                                <SchemaSettingsGroup
                                    key={group.id}
                                    group={group}
                                    showAll={filter.appShowAll}
                                    {...schemaForm}
                                />
                            ))}
                            <AboutDataSection report={importReport} showAll={filter.appShowAll} />
                        </ApplicationSettingsSection>
                        {defaultsBands.map((band, index) => {
                            const tab = defaultsTabs[index];
                            return (
                                <SettingsSectionPanel key={tab.id} id={tab.id} title={t(tab.label)}>
                                    <SettingsTierIntro id={band.id} defaultsNote />
                                    {band.groups.map((group) => (
                                        <SchemaSettingsGroup
                                            key={group.id}
                                            group={group}
                                            showAll={filter.tierShowAll[index]}
                                            {...schemaForm}
                                        />
                                    ))}
                                </SettingsSectionPanel>
                            );
                        })}
                        <TitleRulesSection titleRules={titleRules} />
                        <ProfilesSection isOpen={isOpen} onDirtyChange={save.setProfileDirty} />
                        <ScenariosSection isOpen={isOpen} onDirtyChange={save.setScenarioDirty} />
                        <ModalActionRow
                            className="mt-auto"
                            onSave={save.handleSave}
                            saving={saving}
                            onSecondary={handleResetAll}
                            secondaryLabel={t('app.resetAll')}
                            onCancel={save.dismiss}
                            saveError={save.saveError}
                        />
                    </SettingsNavProvider>
                )}
            </Modal>
            <UnsavedWorkDialogs
                asking={save.asking}
                setAsking={save.setAsking}
                droppedWork={save.droppedWork}
                onDiscard={save.handleCancel}
                onSaveWithout={() => void save.runSave()}
            />
        </>
    );
}
