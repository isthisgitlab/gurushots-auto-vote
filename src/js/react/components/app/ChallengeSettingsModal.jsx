import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useIpcQuery } from '@/api/useIpcQuery';
import { useAutovote } from '@/contexts/AutovoteContext';
import { useChallengeOverrides } from '@/hooks/useChallengeOverrides';
import { tierSchemaEntries } from '@/utils/groupSettings';
import { Modal } from '@/components/ui/Modal';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { ModalActionRow } from '@/components/ui/ModalActionRow';
import { SettingsTierHeading } from '@/components/ui/SettingsTierHeading';
import { ChallengeProfilesBar } from './ChallengeProfilesBar';
import { ChallengeSettingsGroup } from './ChallengeSettingsGroup';
import { challengeSettingHints } from './SettingHints';

// The window hints only read the app settings; an unreadable read falls back
// to the defaults rather than blocking the modal.
const fetchAppSettings = async () => {
    try {
        return (await window.api.getSettings()) || {};
    } catch {
        return {};
    }
};

/** App settings re-read on every open; a read still in flight at close is dropped. */
function useAppSettings(isOpen) {
    return useIpcQuery(fetchAppSettings, { enabled: isOpen, latestOnly: true }).data;
}

/**
 * Explains what an override is, then summarises the effective settings: how
 * many keys diverge from the global defaults right now (the per-row "Global
 * default: …" hint shows the comparison value; this is the at-a-glance count
 * so a user doesn't have to scan every group) and which title-rule profile
 * applies.
 */
function OverridesSummary({ overrideCount, titleProfile }) {
    const { t } = useTranslation();
    return (
        <>
            <div className="alert alert-info text-sm">
                <StrokeIcon d={ICON_PATHS.info} className="w-5 h-5" />
                <span>{t('app.challengeOverrideInfo')}</span>
            </div>
            <p className="text-xs" role="status">
                {t(overrideCount ? 'app.overridesActiveSummary' : 'app.overridesNoneSummary').replace(
                    '{0}',
                    overrideCount,
                )}
                {titleProfile && !titleProfile.suppressed && (
                    <>
                        {' · '}
                        {t('app.usingProfile')}: {titleProfile.name}
                    </>
                )}
            </p>
        </>
    );
}

/**
 * Per-challenge settings modal
 */
export function ChallengeSettingsModal({ isOpen, onClose, challengeId, challengeTitle, challenge = null }) {
    const { t } = useTranslation();
    const { rearmSchedule } = useAutovote();
    const {
        schema,
        defaults,
        groups,
        tiers,
        profileLimits,
        refetch: refetchSchema,
        loading: schemaLoading,
    } = useSettingsSchema();
    const appSettings = useAppSettings(isOpen);
    const form = useChallengeOverrides({
        isOpen,
        challengeId,
        challengeTitle,
        schema,
        defaults,
        refetchSchema,
        rearmSchedule,
        onClose,
    });

    if (!isOpen) return null;

    const hintsFor = challengeSettingHints({
        effectiveOf: form.effectiveOf,
        appSettings,
        challenge,
        profileReplacesWarning: form.profileReplacesWarning,
        t,
    });

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`${t('app.challengeSettings')}: ${challengeTitle}`} size="2xl">
            {/* Schema spinner only for the first load — a background refetch
                (every settings write broadcasts one) must not blank the form. */}
            {(schemaLoading && !schema) || form.loading ? (
                <InlineLoader text={t('common.loading')} />
            ) : form.loadFailed ? (
                <div className="alert alert-error text-sm" role="alert">
                    <span>{t('app.challengeOverridesLoadError')}</span>
                </div>
            ) : (
                <div className="space-y-4">
                    {form.saveError && (
                        <div className="alert alert-error py-2 text-sm" role="alert">
                            <span>{t('app.settingsSaveError')}</span>
                        </div>
                    )}
                    <OverridesSummary
                        overrideCount={Object.keys(form.overrides).length}
                        titleProfile={form.titleProfile}
                    />

                    {/* Named profiles: apply loads a saved tactic into the form
                        state below; the Save button persists it. */}
                    <ChallengeProfilesBar
                        overrides={form.overrides}
                        profileLimits={profileLimits}
                        onProfilesChanged={form.onProfilesChanged}
                        onApply={form.applyProfile}
                    />

                    {tierSchemaEntries(schema, groups, tiers, { perChallengeOnly: true }).map((band) => (
                        <div key={band.id ?? '_'}>
                            <SettingsTierHeading id={band.id} label={band.label} level="h4" />
                            {band.groups.map((group) => (
                                <ChallengeSettingsGroup
                                    key={group.id}
                                    id={group.id}
                                    label={group.label}
                                    entries={group.entries}
                                    challenge={challenge}
                                    defaults={defaults}
                                    form={form}
                                    hintsFor={hintsFor}
                                />
                            ))}
                        </div>
                    ))}

                    <ModalActionRow
                        bordered
                        onSave={form.save}
                        saving={form.saving}
                        onSecondary={form.clearAll}
                        secondaryLabel={t('app.clearAll')}
                        secondaryIcon="trash"
                        onCancel={onClose}
                    />
                </div>
            )}
        </Modal>
    );
}
