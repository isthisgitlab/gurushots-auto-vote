import { useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useIpcQuery } from '@/api/useIpcQuery';
import { useAutovote } from '@/contexts/AutovoteContext';
import { SettingsChallengeProvider } from '@/contexts/SettingsChallengeContext';
import { useChallengeOverrides } from '@/hooks/useChallengeOverrides';
import { tierSchemaEntries } from '@/utils/groupSettings';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesModal } from '@/components/ui/UnsavedChangesModal';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { ModalActionRow } from '@/components/ui/ModalActionRow';
import { STICKY_FOOTER_SCROLL_PADDING } from '@/components/ui/StickyModalFooter';
import { SettingsTierHeading } from '@/components/ui/SettingsTierHeading';
import { ChallengeProfilesBar } from './ChallengeProfilesBar';
import { ChallengeSettingsGroup } from './ChallengeSettingsGroup';
import { challengeSettingHints } from './SettingHints';
import * as ipc from '@/api/ipc';

import type { Challenge } from '../../../types/gurushots';

// The window hints only read the app settings; an unreadable read falls back
// to the defaults rather than blocking the modal.
const fetchAppSettings = async () => {
    try {
        return (await ipc.getSettings())?.app ?? {};
    } catch {
        return {};
    }
};

/**
 * App settings re-read on every open; a read still in flight at close is dropped.
 */
function useAppSettings(isOpen: boolean) {
    return useIpcQuery(fetchAppSettings, { enabled: isOpen, latestOnly: true }).data;
}

// With Manual Only on, a one-line label (see below) sticks to the top of the scroll area, so the box also keeps a
// focused control scrolled below it (WCAG 2.2 SC 2.4.11). On phones the label is at its tallest, about 3rem (the
// Latvian text wraps onto two lines at 320px), so 4rem; at `md:` it fits one line, about 2rem, so 3rem. Each
// includes room for the focus ring. The label is opaque and `aria-hidden`: the alert below it carries the same text.
const MANUAL_ONLY_SCROLL_PADDING = 'scroll-pt-16 md:scroll-pt-12';

/**
 * Explains what an override is, then summarises the effective settings: how
 * many keys diverge from the global defaults right now (the per-row "Global
 * default: …" hint shows the comparison value; this is the at-a-glance count
 * so a user doesn't have to scan every group) and which title-rule profile
 * applies.
 */
function OverridesSummary({
    overrideCount,
    titleRules,
}: {
    overrideCount: number;
    titleRules: ReturnType<typeof useChallengeOverrides>['titleRules'];
}) {
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
                    String(overrideCount),
                )}
                {titleRules?.profile && !titleRules.suppressed && (
                    <>
                        {' · '}
                        {t('app.usingProfile')}: {titleRules.profile.name}
                    </>
                )}
            </p>
        </>
    );
}

/**
 * Per-challenge settings modal
 */
export function ChallengeSettingsModal({
    isOpen,
    onClose,
    challengeId,
    challengeTitle,
    challenge = null,
}: {
    isOpen: boolean;
    onClose: () => void;
    challengeId: Challenge['id'] | null;
    challengeTitle: string;
    challenge?: Challenge | null;
}) {
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

    // The question belongs to one opening: a modal the parent keeps mounted must not open on it next time.
    const [asking, setAsking] = useState(false);
    useEffect(() => {
        if (!isOpen) setAsking(false);
    }, [isOpen]);

    if (!isOpen) return null;

    // Esc, the backdrop, the close button and Cancel: edits that are not saved are not thrown away unasked.
    // Nothing is guarded while the form is loading or its load failed (there is nothing to differ from).
    const dismiss = () => (!form.loading && !form.loadFailed && form.isDirty() ? setAsking(true) : onClose());

    const manualOnly = form.effectiveOf('manualPhotosOnly') === true;
    const hintsFor = challengeSettingHints({
        effectiveOf: form.effectiveOf,
        appSettings,
        challenge,
        profileReplacesWarning: form.profileReplacesWarning,
        t,
    });

    return (
        <>
            <Modal
                isOpen={isOpen}
                onClose={dismiss}
                title={`${t('app.challengeSettings')}: ${challengeTitle}`}
                size="2xl"
                className={`${STICKY_FOOTER_SCROLL_PADDING}${manualOnly ? ` ${MANUAL_ONLY_SCROLL_PADDING}` : ''}`}
            >
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
                        {manualOnly && (
                            <div
                                className="sticky -top-6 z-10 -mx-6 px-6 py-2 bg-base-100 border-b border-warning text-xs font-semibold text-base-content"
                                aria-hidden="true"
                            >
                                ✋ {t('app.manualOnlyLabel')}
                            </div>
                        )}
                        {/* Not a live region: it is on screen when the modal opens, and flipping the switch must not
                        interrupt the user. */}
                        {manualOnly && (
                            <div className="alert alert-warning text-sm">
                                <StrokeIcon d={ICON_PATHS.info} className="w-5 h-5" />
                                <span>{t('app.manualOnlyAlert')}</span>
                            </div>
                        )}
                        <OverridesSummary
                            overrideCount={Object.keys(form.overrides).length}
                            titleRules={form.titleRules}
                        />

                        {/* Named profiles: apply loads a saved tactic into the form
                        state below; the Save button persists it. */}
                        <ChallengeProfilesBar
                            overrides={form.overrides}
                            profileLimits={profileLimits}
                            onProfilesChanged={form.onProfilesChanged}
                            onApply={form.applyProfile}
                        />

                        {/* The chosen-photos chooser reads each photo's eligibility through this challenge. */}
                        <SettingsChallengeProvider value={challengeId}>
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
                        </SettingsChallengeProvider>

                        <ModalActionRow
                            onSave={form.save}
                            saving={form.saving}
                            onSecondary={form.clearAll}
                            secondaryLabel={t('app.clearAll')}
                            secondaryIcon="trash"
                            onCancel={dismiss}
                            saveError={form.saveError}
                        />
                    </div>
                )}
            </Modal>
            <UnsavedChangesModal
                isOpen={asking}
                onKeepEditing={() => setAsking(false)}
                onDiscard={() => {
                    setAsking(false);
                    onClose();
                }}
            />
        </>
    );
}
