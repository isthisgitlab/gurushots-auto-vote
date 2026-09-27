import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettings } from '@/api/useSettings';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { useTitleRules } from '@/hooks/useTitleRules';
import { useCustomTimezoneInput } from '@/hooks/useCustomTimezoneInput';
import { useAutovote } from '@/contexts/AutovoteContext';
import { tierSchemaEntries, SETTINGS_GRID_CLASS, SETTING_CELL_CLASS } from '@/utils/groupSettings';
import { Modal } from '@/components/ui/Modal';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { ModalActionRow } from '@/components/ui/ModalActionRow';
import { SettingsTierHeading } from '@/components/ui/SettingsTierHeading';
import { SettingHelp } from '@/components/ui/SettingHelp';
import { SettingInput, SettingLabel } from './SettingInput';
import { SettingHintList, globalSettingHints } from './SettingHints';
import { ApplicationSettingsSection } from './ApplicationSettingsSection';
import { TitleTagRulesEditor } from './TitleTagRulesEditor';
import { ScenariosSection } from './ScenariosSection';
import * as ipc from '@/api/ipc';

import type { SettingsBand, SettingsSection } from '@/utils/groupSettings';
import type { HintsFor, SettingChangeHandler, SettingResetHandler } from '../../../types/settingsEditor';

/**
 * The form state every schema-driven setting input reads and writes.
 */
type SchemaFormProps = {
    formValues: Record<string, unknown>;
    handleFormChange: SettingChangeHandler;
    handleResetGlobal: SettingResetHandler;
    hintsFor: HintsFor;
};

// The tier of app-wide settings (rewards, missions, notifications, display).
// They render with the Application Settings, not as challenge defaults.
const APP_TIER = 'app';

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
}: { group: SettingsSection; level?: 'h5' | 'h6' } & SchemaFormProps) {
    const { t } = useTranslation();
    const Heading = level;
    return (
        <div className="mb-4">
            <Heading className="font-medium text-sm opacity-70 mb-2 mt-3">{t(group.label)}</Heading>
            <div className={SETTINGS_GRID_CLASS}>
                {group.entries.map(([key, config]) => (
                    <div key={key} className={SETTING_CELL_CLASS}>
                        <SettingLabel inputId={`setting-${key}`} type={config.type}>
                            <span className="font-medium">{t(config.label)}</span>
                            {config.perChallenge && (
                                <span className="badge badge-ghost badge-sm ml-2">{t('app.globalDefault')}</span>
                            )}
                        </SettingLabel>
                        <p className="text-xs text-base-content/60 mb-2">{t(config.description)}</p>
                        <SettingHelp helpKey={config.helpKey} />
                        <SettingInput
                            settingKey={key}
                            config={config}
                            value={formValues[key] ?? config.default}
                            onChange={handleFormChange}
                            onReset={handleResetGlobal}
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
    return (
        <div>
            <h4 className="font-semibold text-base mb-3 border-b border-base-300 pb-2">{t('app.challengeDefaults')}</h4>
            {bands.map((band) => (
                <div key={band.id ?? '_'} className="mb-6">
                    <SettingsTierHeading id={band.id} label={band.label} level="h5" />
                    {band.groups.map((group) => (
                        <SchemaSettingsGroup key={group.id} group={group} {...form} />
                    ))}
                </div>
            ))}
        </div>
    );
}

/**
 * Challenge (title-tag) rules: matched on what survives a challenge's id rotation.
 */
function TitleRulesSection({ titleRules }: { titleRules: ReturnType<typeof useTitleRules> }) {
    const { t } = useTranslation();
    return (
        <div>
            <h4 className="font-semibold text-base mb-1 border-b border-base-300 pb-2">{t('app.titleTagRules')}</h4>
            <p className="text-xs text-base-content/60 mb-3">{t('app.titleTagRulesDesc')}</p>
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
        </div>
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
        originalUiValues,
        handleFormChange,
        handleUiChange,
        handleResetGlobal,
        handleResetUi,
        handleResetAll,
        commit,
        revert,
    } = useSettingsForm({
        isOpen,
        schema,
        defaults,
        settings,
        refetchSettings,
        refetchSchema,
        updateSetting,
    });

    const timezoneInput = useCustomTimezoneInput({ isOpen, uiValues, handleUiChange });
    const titleRules = useTitleRules(isOpen);
    const persistTitleRules = titleRules.persist;
    // True when commit() reported schema writes rejected by validation —
    // shown as an alert and the modal stays open (mirrors titleRules.error).
    const [saveError, setSaveError] = useState(false);

    useEffect(() => {
        if (isOpen) setSaveError(false);
    }, [isOpen]);

    const handleCancel = useCallback(() => {
        // Revert theme DOM if the user changed it during this open session.
        if (originalUiValues && originalUiValues.theme !== uiValues.theme) {
            document.documentElement.setAttribute('data-theme', originalUiValues.theme);
        }
        revert();
        onClose();
    }, [originalUiValues, uiValues.theme, revert, onClose]);

    const handleSave = useCallback(async () => {
        try {
            // commit() returns the schema keys whose write was rejected by
            // validation (e.g. a duplicate-count auto-fill schedule). Surface
            // that and keep the modal open — same rationale as the title-rules
            // check below — so the edit isn't silently lost behind a closed
            // modal that looked like a successful save.
            const rejectedKeys = await commit();
            if (Array.isArray(rejectedKeys) && rejectedKeys.length > 0) {
                setSaveError(true);
                return;
            }
            setSaveError(false);
            // Title rules are rejected as a whole (e.g. a tag over the length
            // cap); the hook surfaces that and the modal stays open.
            if (!(await persistTitleRules())) return;
            // A language that fails to save keeps the modal open with the
            // save-error alert instead of closing on a change that didn't land.
            if (uiValues.language !== language && !(await setLanguage(uiValues.language))) {
                setSaveError(true);
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
            await ipc.logRendererError(
                `Error saving settings: ${(err as { message?: unknown } | null | undefined)?.message || err}`,
            );
        }
    }, [commit, persistTitleRules, uiValues.language, language, setLanguage, rearmSchedule, onClose]);

    if (!isOpen) return null;

    const hintsFor = globalSettingHints({ formValues, schema, timezone: uiValues.timezone, t });
    const schemaForm = { formValues, handleFormChange, handleResetGlobal, hintsFor };
    const bands = tierSchemaEntries(schema, groups, tiers);
    const appGroups = bands.filter((band) => band.id === APP_TIER).flatMap((band) => band.groups);
    const actionRowProps = {
        onSave: handleSave,
        saving,
        onSecondary: handleResetAll,
        secondaryLabel: t('app.resetAll'),
        onCancel: handleCancel,
    };

    return (
        <Modal isOpen={isOpen} onClose={handleCancel} title={t('app.globalSettings')} size="2xl">
            {/* Spinner only for the first load: every settings write broadcasts a
                change that refetches the schema, and swapping the form out for the
                spinner on each of those background refreshes made Save flicker. */}
            {schemaLoading && !schema ? (
                <InlineLoader text={t('common.loading')} />
            ) : (
                <div className="space-y-6">
                    {saveError && (
                        <div className="alert alert-error py-2 text-sm" role="alert">
                            <span>{t('app.settingsSaveError')}</span>
                        </div>
                    )}
                    <ModalActionRow {...actionRowProps} />
                    <ApplicationSettingsSection
                        uiValues={uiValues}
                        handleUiChange={handleUiChange}
                        handleResetUi={handleResetUi}
                        timezoneInput={timezoneInput}
                    >
                        {appGroups.map((group) => (
                            <SchemaSettingsGroup key={group.id} group={group} level="h5" {...schemaForm} />
                        ))}
                    </ApplicationSettingsSection>
                    <ChallengeDefaultsSection bands={bands.filter((band) => band.id !== APP_TIER)} {...schemaForm} />
                    <TitleRulesSection titleRules={titleRules} />
                    <ScenariosSection isOpen={isOpen} />
                    <ModalActionRow bordered {...actionRowProps} />
                </div>
            )}
        </Modal>
    );
}
