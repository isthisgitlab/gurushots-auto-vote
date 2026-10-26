import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useIpcQuery } from '@/api/useIpcQuery';
import { useAutovote } from '@/contexts/AutovoteContext';
import { SettingsChallengeProvider } from '@/contexts/SettingsChallengeContext';
import { useChallengeOverrides } from '@/hooks/useChallengeOverrides';
import { useScrollPanelIntoView } from '@/hooks/useScrollPanelIntoView';
import { bandTabs, tierSchemaEntries } from '@/utils/groupSettings';
import { Modal, TALL_MODAL_BOX_HEIGHT } from '@/components/ui/Modal';
import { UnsavedChangesModal } from '@/components/ui/UnsavedChangesModal';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { ModalActionRow } from '@/components/ui/ModalActionRow';
import { STICKY_FOOTER_SCROLL_PADDING } from '@/components/ui/StickyModalFooter';
import { SettingsTierIntro } from '@/components/ui/SettingsTierIntro';
import { TabList, TabPanel } from '@/components/ui/Tabs';
import { ChallengeProfilesBar } from './ChallengeProfilesBar';
import { ChallengeSettingsGroup } from './ChallengeSettingsGroup';
import { challengeSettingHints } from './SettingHints';
import * as ipc from '@/api/ipc';

import type { Challenge } from '../../../types/gurushots';
import type { TabDescriptor } from '@/components/ui/Tabs';
import type { SettingsBand, SettingsTabId } from '@/utils/groupSettings';

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

// The tab row holds the sticky slot when Manual Only is off, so the box also keeps a focused control
// scrolled below it (WCAG 2.2 SC 2.4.11). The row is one non-wrapping line at every width — the tabs
// scroll sideways instead of wrapping — at about 2.5rem of tab plus the row's padding, so 3rem with
// room for the focus ring; unlike the banner it does not change height between phone and `md:`.
const TAB_ROW_SCROLL_PADDING = 'scroll-pt-12';

// A steady box height so switching tabs never resizes the modal, and a flex column so the body grows
// while the action row pins to the bottom. The 5em gutter of TALL_MODAL_BOX_HEIGHT, measured inside
// the system bars (safe-area insets), keeps the box clear of the viewport edges.
const MODAL_BOX_CLASS = `${TALL_MODAL_BOX_HEIGHT} flex flex-col`;

// This modal's tab / panel DOM ids. The `challenge-settings-` prefix keeps them away from the global
// settings modal's, which can be mounted at the same time (both modals portal to the body).
const challengeTabId = (id: string) => `challenge-settings-tab-${id}`;
const challengePanelId = (id: string) => `challenge-settings-panel-${id}`;

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
 * Per-challenge settings modal: the schema's per-challenge settings, banded
 * into one tab per tier (see SETTINGS_TIERS in settings/schema.ts).
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

    // The question and the selected tab belong to one opening: a modal the parent keeps mounted must not open on either next time.
    const [asking, setAsking] = useState(false);
    const [selected, setSelected] = useState<SettingsTabId | null>(null);
    // Counts the user's tab selections — the row scrolls the active tab into view only on those.
    // Never reset: a reset would read as a new selection and scroll the row on the next open.
    const [selectionSeq, setSelectionSeq] = useState(0);
    useEffect(() => {
        if (!isOpen) {
            setAsking(false);
            setSelected(null);
        }
    }, [isOpen]);

    // The body's scroll element is the modal box itself — the sticky chrome and the scroll paddings
    // below are measured against it — and Modal owns that element, so the body wrapper reaches it
    // through the DOM.
    const bodyRef = useRef<HTMLElement | null>(null);
    // The sticky chrome a freshly selected panel's top must clear: the Manual-Only banner while it
    // holds the sticky slot, else the tab-row wrapper. The hook reads the getter only when a scroll
    // runs, so a Manual-Only toggle never re-triggers anything.
    const bannerRef = useRef<HTMLDivElement | null>(null);
    const tabRowRef = useRef<HTMLDivElement | null>(null);
    const manualOnly = form.effectiveOf('manualPhotosOnly') === true;
    const stickyRef = useMemo<{ readonly current: HTMLElement | null }>(
        () => ({
            get current() {
                return manualOnly ? bannerRef.current : tabRowRef.current;
            },
        }),
        [manualOnly],
    );
    const requestPanelScroll = useScrollPanelIntoView(bodyRef, stickyRef);

    if (!isOpen) return null;

    // Esc, the backdrop, the close button and Cancel: edits that are not saved are not thrown away unasked.
    // Nothing is guarded while the form is loading or its load failed (there is nothing to differ from).
    const dismiss = () => (!form.loading && !form.loadFailed && form.isDirty() ? setAsking(true) : onClose());

    const hintsFor = challengeSettingHints({
        effectiveOf: form.effectiveOf,
        appSettings,
        challenge,
        profileReplacesWarning: form.profileReplacesWarning,
        t,
    });

    // One band per tier that has per-challenge settings (see SETTINGS_TIERS in settings/schema.ts).
    const bands = tierSchemaEntries(schema, groups, tiers, { perChallengeOnly: true });
    // Overrides counted per band: a key sits in the band holding its schema group, so the summary's
    // total can be traced tab by tab.
    const bandOverrideCount = (band: SettingsBand): number => {
        const groupsInBand = new Set(band.groups.map((group) => group.id));
        return Object.keys(form.overrides).filter((key) => {
            const group = schema?.[key]?.group;
            return group !== undefined && groupsInBand.has(group);
        }).length;
    };
    const tabs: Array<TabDescriptor<SettingsTabId>> = bandTabs(bands).map((tab, index) => ({
        id: tab.id,
        label: t(tab.label),
        badge: bandOverrideCount(bands[index]),
    }));
    // The user's pick while it is still a band; the first band otherwise (also after a schema
    // refetch drops the selected band).
    const activeTab = tabs.find((tab) => tab.id === selected) ?? tabs[0];

    // Clicking the already-active tab neither re-selects nor asks for the scroll again.
    const selectTab = (id: SettingsTabId) => {
        if (activeTab?.id === id) return;
        setSelected(id);
        setSelectionSeq((seq) => seq + 1);
        requestPanelScroll(challengePanelId(id));
    };

    // A band's groups, the same under a tab panel and under the single band's heading.
    const bandGroups = (band: SettingsBand) =>
        band.groups.map((group) => (
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
        ));

    // The tabbed form's branch: the schema spinner only covers the first load (a background
    // refetch must not blank the form), and the load-failed alert is its own branch.
    const schemaFirstLoad = schemaLoading && !schema;
    const formShown = !schemaFirstLoad && !form.loading && !form.loadFailed;

    return (
        <>
            <Modal
                isOpen={isOpen}
                onClose={dismiss}
                title={`${t('app.challengeSettings')}: ${challengeTitle}`}
                size="2xl"
                className={[
                    STICKY_FOOTER_SCROLL_PADDING,
                    // Manual Only keeps the banner in the sticky slot; otherwise the tab row holds it.
                    manualOnly ? MANUAL_ONLY_SCROLL_PADDING : TAB_ROW_SCROLL_PADDING,
                    // The steady box belongs to the tabbed form: the spinner and the load-failed
                    // alert keep the plain auto-height box.
                    ...(formShown ? [MODAL_BOX_CLASS] : []),
                ].join(' ')}
            >
                {/* Schema spinner only for the first load — a background refetch
                (every settings write broadcasts one) must not blank the form. */}
                {schemaFirstLoad || form.loading ? (
                    <InlineLoader text={t('common.loading')} />
                ) : form.loadFailed ? (
                    <div className="alert alert-error text-sm" role="alert">
                        <span>{t('app.challengeOverridesLoadError')}</span>
                    </div>
                ) : (
                    <div
                        className="grow flex flex-col"
                        ref={(node) => {
                            bodyRef.current = node?.closest<HTMLElement>('.modal-box') ?? null;
                        }}
                    >
                        <div className="space-y-4">
                            {manualOnly && (
                                <div
                                    ref={bannerRef}
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
                                {tabs.length >= 2 && activeTab && (
                                    <div
                                        ref={tabRowRef}
                                        className={`${
                                            manualOnly ? '' : 'sticky -top-6 z-10 '
                                        }-mx-6 px-6 py-2 bg-base-100 border-b border-base-300`}
                                    >
                                        <TabList
                                            label={t('app.settingsJumpLabel')}
                                            tabs={tabs}
                                            active={activeTab.id}
                                            onSelect={selectTab}
                                            selectionSeq={selectionSeq}
                                            tabId={challengeTabId}
                                            panelId={challengePanelId}
                                        />
                                    </div>
                                )}
                                {tabs.length >= 2 && activeTab
                                    ? bands.map((band, index) => (
                                          <TabPanel
                                              key={band.id ?? '_'}
                                              id={tabs[index].id}
                                              tabId={challengeTabId}
                                              panelId={challengePanelId}
                                              active={activeTab.id === tabs[index].id}
                                              title={t(tabs[index].label)}
                                          >
                                              <SettingsTierIntro id={band.id} />
                                              {bandGroups(band)}
                                          </TabPanel>
                                      ))
                                    : bands.map((band) => (
                                          <div key={band.id ?? '_'}>
                                              {band.label && (
                                                  <h4 className="mb-2 font-semibold text-sm uppercase tracking-wide text-base-content">
                                                      {t(band.label)}
                                                  </h4>
                                              )}
                                              <SettingsTierIntro id={band.id} />
                                              {bandGroups(band)}
                                          </div>
                                      ))}
                            </SettingsChallengeProvider>
                        </div>

                        <ModalActionRow
                            className="mt-auto"
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
