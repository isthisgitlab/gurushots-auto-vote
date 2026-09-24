import { useTranslation } from '@/contexts/TranslationContext';
import { useOverriddenChallengeIds } from '@/hooks/useOverriddenChallengeIds';
import { ChipListPanel, ChallengeChip, ChipTitle } from './ChallengeChips';
import { PulseDot } from '../ui/PulseDot';
import { isBoostWindowOpen } from '../../../voting/boostWindow';
import { isLowExposure } from '@/utils/challengeAlerts';

/**
 * "Jump to challenge" index placed above the challenge list. Lists every active
 * challenge by title in the same order the cards render; each entry is a button
 * that smooth-scrolls to the matching ChallengeCard (id="challenge-<id>"), so a
 * user who knows the name can click instead of scrolling. Renders nothing when
 * there are no challenges. Mirrors BoostWindowBanner, but for the full list.
 *
 * Challenges carrying a per-challenge override get an accent fill and a ⚙️
 * prefix — the same signal as the card's "⚙️ custom" badge, so the tuned ones
 * are findable without scrolling the list. Filled rather than `btn-outline`:
 * outline paints the label in the raw accent colour, which is 1.9:1 on the
 * light theme's white base-100 (AA wants 4.5:1), while the filled pair
 * accent-content-on-accent is 5.1:1 in both themes.
 *
 * Each chip also leads with a status dot — pulsing blue for an open boost
 * window, red for low exposure (utils/challengeAlerts) — so the whole
 * situation reads off this one panel. The meaning is repeated in sr-only text.
 */
export function ChallengeNav({ challenges }) {
    const { t } = useTranslation();

    const list = challenges || [];
    const overridden = useOverriddenChallengeIds(list);

    if (list.length === 0) return null;

    // No tick: the dots refresh with each challenge refetch, like StatusHeader.
    const nowSec = Math.floor(Date.now() / 1000);

    return (
        <ChipListPanel icon="📋" label={t('app.jumpToChallenge')} count={list.length}>
            {list.map((c) => {
                const custom = overridden.has(String(c?.id));
                const boostOpen = isBoostWindowOpen(c?.member?.boost, nowSec);
                const lowExposure = isLowExposure(c, nowSec);
                return (
                    <ChallengeChip key={c?.id} challengeId={c?.id} className={custom ? 'btn-accent' : ''}>
                        {boostOpen && <PulseDot variant="info" size="status-sm" />}
                        {lowExposure && <PulseDot variant="error" pulse={false} size="status-sm" />}
                        {custom && <span aria-hidden="true">⚙️ </span>}
                        <ChipTitle hint={custom ? t('app.customSettingsHint') : undefined}>{c?.title}</ChipTitle>
                        {boostOpen && <span className="sr-only"> ({t('app.boostOpenBadge')})</span>}
                        {lowExposure && <span className="sr-only"> ({t('app.lowExposure')})</span>}
                        {custom && <span className="sr-only"> ({t('app.customSettingsHint')})</span>}
                    </ChallengeChip>
                );
            })}
        </ChipListPanel>
    );
}
