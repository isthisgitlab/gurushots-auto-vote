import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettings } from '@/api/useSettings';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { useTitleRules } from '@/hooks/useTitleRules';
import { useCustomTimezoneInput } from '@/hooks/useCustomTimezoneInput';
import { useAutovote } from '@/contexts/AutovoteContext';
import { SettingsNavProvider, useSettingsNav, useSettingsNavState } from '@/contexts/SettingsNavContext';
import {
    tierSchemaEntries,
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
import { SettingsTierHeading } from '@/components/ui/SettingsTierHeading';
import { SettingHelp } from '@/components/ui/SettingHelp';
import { SettingInput, SettingLabel } from './SettingInput';
import { SettingHintList, globalSettingHints } from './SettingHints';
import { ApplicationSettingsSection, APPLICATION_HEADING_ID, applicationCellTexts } from './ApplicationSettingsSection';
import { SettingsNavBar, SettingsNoMatch, SETTINGS_NAV_SCROLL_PADDING } from './SettingsNavBar';
import { SettingsSectionPanel } from './SettingsSectionPanel';
import { TitleTagRulesEditor } from './TitleTagRulesEditor';
import { ScenariosSection } from './ScenariosSection';
import { AboutDataSection } from './AboutDataSection';
import * as ipc from '@/api/ipc';

import type { SettingsBand, SettingsSection } from '@/utils/groupSettings';
import type { SettingsSectionId } from '@/contexts/SettingsNavContext';
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
// They render with the Application Settings, not as challenge defaults.
const APP_TIER = 'app';

// The title-rules heading: where focus goes when saving the rules fails.
const TITLE_RULES_HEADING_ID = 'settings-title-rules-heading';

// Challenge types seen on the live API (verified 2026-09-19). Suggestions for
// the rule type field only — it stays free text, so a type this build has never
// seen can still be typed in.
const RULE_TYPE_SUGGESTIONS = ['default', 'exhibition', 'flash', 'speed'];

/**
 * One schema-driven settings group: its heading and a grid of inputs. The
 * "Global default" badge marks only settings a challenge can override.
 * `level` keeps the heading one below its parent: h6 under a tier band (h5),
 * h5 directly under a section heading (h4).
 */
function SchemaSettingsGroup({
    group,
    level = 'h6',
    formValues,
    handleFormChange,
    handleResetGlobal,
    hintsFor,
    rejectedKeys,
}: { group: SettingsSection; level?: 'h5' | 'h6' } & SchemaFormProps) {
    const { t } = useTranslation();
    const { query } = useSettingsNav();
    const Heading = level;
    return (
        <div className={`mb-4 ${groupMatchesFilter(t, group, query) ? '' : 'hidden'}`}>
            <Heading className="font-medium text-sm opacity-70 mb-2 mt-3">{t(group.label)}</Heading>
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
 * The schema-driven challenge defaults, grouped into tier bands.
 */
function ChallengeDefaultsSection({ bands, ...form }: { bands: SettingsBand[] } & SchemaFormProps) {
    const { t } = useTranslation();
    const { query } = useSettingsNav();
    return (
        <SettingsSectionPanel id="challengeDefaults">
            {bands.map((band) => (
                <div
                    key={band.id ?? '_'}
                    className={`mb-6 ${band.groups.some((group) => groupMatchesFilter(t, group, query)) ? '' : 'hidden'}`}
                >
                    <SettingsTierHeading id={band.id} label={band.label} level="h5" />
                    {band.groups.map((group) => (
                        <SchemaSettingsGroup key={group.id} group={group} {...form} />
                    ))}
                </div>
            ))}
        </SettingsSectionPanel>
    );
}

/**
 * Challenge (title-tag) rules: matched on what survives a challenge's id rotation.
 */
function TitleRulesSection({ titleRules }: { titleRules: ReturnType<typeof useTitleRules> }) {
    const { t } = useTranslation();
    return (
        <SettingsSectionPanel id="titleRules" headingId={TITLE_RULES_HEADING_ID}>
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

    // Which sections have a setting (or, for the sections without any, a heading) matching the filter.
    const nav = useSettingsNavState((query) => ({
        application:
            matchesSettingFilter(applicationCellTexts(t), query) ||
            appGroups.some((group) => groupMatchesFilter(t, group, query)),
        challengeDefaults: defaultsBands.some((band) =>
            band.groups.some((group) => groupMatchesFilter(t, group, query)),
        ),
        titleRules: matchesSettingFilter([t('app.titleTagRules')], query),
        scenarios: matchesSettingFilter([t('app.scenarios')], query),
        about: matchesSettingFilter([t('about.title')], query),
    }));
    const resetNav = nav.reset;
    const settleNav = nav.settle;

    const timezoneInput = useCustomTimezoneInput({ isOpen, uiValues, handleUiChange });
    const titleRules = useTitleRules(isOpen);
    const persistTitleRules = titleRules.persist;
    // True when commit() reported schema writes rejected by validation —
    // shown as an alert and the modal stays open (mirrors titleRules.error).
    const [saveError, setSaveError] = useState(false);
    // The keys commit() reported, so each one's input can say it was refused.
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
        // The first target that exists takes focus; none may exist, and the open animation still has to come back.
        focusIds
            .map((id) => document.getElementById(id))
            .find((target) => target !== null)
            ?.focus();
        // The section opened for this focus may stop skipping its open animation now that layout is done.
        settleNav();
    }, [focusIds, settleNav]);

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

    // The section a refused key's input sits in: a UI key in Application, a schema key in the section of its group.
    const sectionOfKey = (key: string): SettingsSectionId | null => {
        if (key in uiValues) return 'application';
        const inApp = appGroups.some((group) => group.entries.some(([entryKey]) => entryKey === key));
        if (inApp) return 'application';
        const inDefaults = defaultsBands.some((band) =>
            band.groups.some((group) => group.entries.some(([entryKey]) => entryKey === key)),
        );
        return inDefaults ? 'challengeDefaults' : null;
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
                // The first refused key that has a section: the filter is cleared and the section opened for its focus.
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
                setFocusIds([TITLE_RULES_HEADING_ID]);
                return;
            }
            // A language that fails to save keeps the modal open with the
            // save-error alert instead of closing on a change that didn't land.
            if (uiValues.language !== language && !(await setLanguage(uiValues.language))) {
                setSaveError(true);
                nav.reveal('application');
                setFocusIds([APPLICATION_HEADING_ID]);
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
    return (
        <>
            <Modal
                isOpen={isOpen}
                onClose={dismiss}
                title={t('app.globalSettings')}
                size="2xl"
                className={`${STICKY_FOOTER_SCROLL_PADDING} ${SETTINGS_NAV_SCROLL_PADDING}`}
            >
                {/* Spinner only for the first load: every settings write broadcasts a
                change that refetches the schema, and swapping the form out for the
                spinner on each of those background refreshes made Save flicker. */}
                {schemaLoading && !schema ? (
                    <InlineLoader text={t('common.loading')} />
                ) : (
                    <SettingsNavProvider value={nav}>
                        <SettingsNavBar />
                        <div className="space-y-6">
                            {!Object.values(nav.shown).some(Boolean) && <SettingsNoMatch />}
                            <ApplicationSettingsSection
                                uiValues={uiValues}
                                handleUiChange={handleUiChange}
                                handleResetUi={handleResetUi}
                                rejectedKeys={rejectedKeys}
                                timezoneInput={timezoneInput}
                            >
                                {appGroups.map((group) => (
                                    <SchemaSettingsGroup key={group.id} group={group} level="h5" {...schemaForm} />
                                ))}
                            </ApplicationSettingsSection>
                            <ChallengeDefaultsSection bands={defaultsBands} {...schemaForm} />
                            <TitleRulesSection titleRules={titleRules} />
                            <ScenariosSection isOpen={isOpen} onDirtyChange={setScenarioDirty} />
                            <AboutDataSection />
                            <ModalActionRow
                                onSave={handleSave}
                                saving={saving}
                                onSecondary={handleResetAll}
                                secondaryLabel={t('app.resetAll')}
                                onCancel={dismiss}
                                saveError={saveError}
                            />
                        </div>
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
