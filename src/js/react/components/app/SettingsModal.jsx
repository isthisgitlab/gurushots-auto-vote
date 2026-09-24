import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettings } from '@/api/useSettings';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { useTitleRules } from '@/hooks/useTitleRules';
import { useAutovote } from '@/contexts/AutovoteContext';
import { tierSchemaEntries, SETTINGS_GRID_CLASS, SETTING_CELL_CLASS } from '@/utils/groupSettings';
import { Modal } from '@/components/ui/Modal';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { ModalActionRow } from '@/components/ui/ModalActionRow';
import { SettingsTierHeading } from '@/components/ui/SettingsTierHeading';
import { SettingHelp } from '@/components/ui/SettingHelp';
import { SettingInput, SettingLabel } from './SettingInput';
import { SettingHintList, globalSettingHints } from './SettingHints';
import { ApplicationSettingsSection, useCustomTimezoneInput } from './ApplicationSettingsSection';
import { TitleTagRulesEditor } from './TitleTagRulesEditor';

// Challenge types seen on the live API (verified 2026-09-19). Suggestions for
// the rule type field only — it stays free text, so a type this build has never
// seen can still be typed in.
const RULE_TYPE_SUGGESTIONS = ['default', 'exhibition', 'flash', 'speed'];

/** The schema-driven global defaults, grouped into tier bands and static sub-sections. */
function ChallengeDefaultsSection({
    schema,
    groups,
    tiers,
    formValues,
    handleFormChange,
    handleResetGlobal,
    hintsFor,
}) {
    const { t } = useTranslation();
    return (
        <div>
            <h4 className="font-semibold text-base mb-3 border-b border-base-300 pb-2">{t('app.challengeDefaults')}</h4>
            {tierSchemaEntries(schema, groups, tiers).map((band) => (
                <div key={band.id ?? '_'} className="mb-6">
                    <SettingsTierHeading id={band.id} label={band.label} level="h5" />
                    {band.groups.map(({ id, label, entries }) => (
                        <div key={id} className="mb-4">
                            <h6 className="font-medium text-sm opacity-70 mb-2 mt-3">{t(label)}</h6>
                            <div className={SETTINGS_GRID_CLASS}>
                                {entries.map(([key, config]) => (
                                    <div key={key} className={SETTING_CELL_CLASS}>
                                        <SettingLabel inputId={`setting-${key}`} type={config.type}>
                                            <span className="label-text font-medium">{t(config.label)}</span>
                                            <span className="badge badge-ghost badge-xs ml-2">
                                                {t('app.globalDefault')}
                                            </span>
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
                    ))}
                </div>
            ))}
        </div>
    );
}

/** Challenge (title-tag) rules: matched on what survives a challenge's id rotation. */
function TitleRulesSection({ titleRules }) {
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
            <TitleTagRulesEditor
                value={titleRules.rules}
                profiles={titleRules.profiles}
                types={RULE_TYPE_SUGGESTIONS}
                onChange={titleRules.change}
            />
        </div>
    );
}

/**
 * Global settings modal
 */
export function SettingsModal({ isOpen, onClose }) {
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
            if (uiValues.language !== language) {
                setLanguage(uiValues.language);
            }
            // Close first: the re-arm reads settings and fetches the active
            // challenges over the network, and the saved modal must not sit
            // open for that round-trip.
            onClose();
            // Re-arm the cadence timer so a changed threshold / scheduled-fill
            // setting takes effect now, not after the current wait elapses.
            await rearmSchedule();
        } catch (err) {
            await window.api.logError(`Error saving settings: ${err.message || err}`);
        }
    }, [commit, persistTitleRules, uiValues.language, language, setLanguage, rearmSchedule, onClose]);

    if (!isOpen) return null;

    const hintsFor = globalSettingHints({ formValues, schema, timezone: uiValues.timezone, t });
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
                    />
                    <ChallengeDefaultsSection
                        schema={schema}
                        groups={groups}
                        tiers={tiers}
                        formValues={formValues}
                        handleFormChange={handleFormChange}
                        handleResetGlobal={handleResetGlobal}
                        hintsFor={hintsFor}
                    />
                    <TitleRulesSection titleRules={titleRules} />
                    <ModalActionRow bordered {...actionRowProps} />
                </div>
            )}
        </Modal>
    );
}
