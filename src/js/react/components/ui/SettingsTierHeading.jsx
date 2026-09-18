import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Heading for one tier band in the settings modals (see SETTINGS_TIERS in
 * settings/schema.js). Shared by SettingsModal and ChallengeSettingsModal so
 * the two render identical band chrome from one place.
 *
 * Renders nothing when `label` is null — that is the fallback band
 * tierSchemaEntries emits for groups whose tier is unknown, or for every group
 * when the main process sent no `tiers` at all. Both cases must still show
 * their settings, just without a heading, so the null check lives here rather
 * than being repeated at each call site.
 *
 * `level` picks the heading element so each modal keeps a valid outline. Both
 * modals title themselves with an h3 (see ui/Modal.jsx), so a band is never an
 * h3: the global modal nests bands under its own h4 section heading ("Challenge
 * Defaults") and passes h5, while the per-challenge modal has no section layer
 * and passes h4. Each modal's group headings sit one level below whatever it
 * passes here.
 *
 * @param {{ id: string|null, label: string|null, level?: 'h4'|'h5' }} props
 */
export function SettingsTierHeading({ id, label, level = 'h5' }) {
    const { t } = useTranslation();
    if (!label) return null;

    const Heading = level;
    return (
        <div className="mt-4 mb-2">
            <Heading className="font-semibold text-sm uppercase tracking-wide opacity-50">{t(label)}</Heading>
            {/* Only the overrides band carries a sub-line: it is the one band whose
                members are all off by default, which is the fact that justifies it
                sitting below the features a user actually edits. */}
            {id === 'overrides' && <p className="text-xs text-base-content/50">{t('app.tierOverridesDesc')}</p>}
        </div>
    );
}
