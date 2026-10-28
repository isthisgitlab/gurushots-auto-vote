import { useTranslation } from '@/contexts/TranslationContext';

/**
 * The intro lines under a tier band's tab in the settings modals (see
 * SETTINGS_TIERS in settings/schema.ts). Shared by SettingsModal and
 * ChallengeSettingsModal so the two render identical band chrome from one
 * place. The tab and the panel's sr-only h4 name the band, so this renders
 * only the explanatory lines below them.
 *
 * Renders nothing when there is no line to show, so callers can pass the
 * component unconditionally. The fallback band tierSchemaEntries emits for
 * groups whose tier is unknown (or for every group when the main process sent
 * no `tiers` at all) shows the defaults note in the global modal — that band
 * is its Other tab (`otherTier`) — while the per-challenge modal passes
 * neither line and renders nothing for it. A named band with no line to show
 * renders nothing in either modal.
 *
 * The overrides band's sub-line is keyed off the tier id `overrides`; it is
 * the one band whose members are all off by default, which is the fact that
 * justifies it sitting below the features a user actually edits. The
 * `defaultsNote` line is the global modal's per-band reminder that what it
 * shows are defaults each challenge can override, shown on every tier tab;
 * the per-challenge modal never passes it.
 */
export function SettingsTierIntro({ id, defaultsNote = false }: { id: string | null; defaultsNote?: boolean }) {
    const { t } = useTranslation();
    const showOverrides = id === 'overrides';
    if (!showOverrides && !defaultsNote) return null;

    return (
        <div className="mb-2 space-y-1">
            {/* Only the overrides band carries its sub-line. `/70` matches the group
                headings — at text-xs this is normal-size text for WCAG 1.4.3, so it
                needs the full 4.5:1, not the large-text allowance. */}
            {showOverrides && <p className="text-xs text-base-content/70">{t('app.tierOverridesDesc')}</p>}
            {defaultsNote && <p className="text-xs text-base-content/70">{t('app.tierDefaultsNote')}</p>}
        </div>
    );
}
