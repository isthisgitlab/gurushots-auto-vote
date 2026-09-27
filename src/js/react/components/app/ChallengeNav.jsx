/** @import { Challenge } from '../../../types/gurushots' */
import { useTranslation } from '@/contexts/TranslationContext';
import { useCustomizedChallengeIds } from '@/hooks/useCustomizedChallengeIds';
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
 * Manual overrides get an accent fill and ⚙️; automatic profiles get an info
 * fill and 🔄. A challenge with both shows both icons on the info fill. The
 * icons and tooltip identify sources without relying on colour alone.
 *
 * Each chip also leads with a status dot — pulsing blue for an open boost
 * window, red for low exposure (utils/challengeAlerts) — so the whole
 * situation reads off this one panel. The meaning is repeated in sr-only text.
 *
 * @param {{ challenges: Challenge[] | null | undefined }} props
 */
export function ChallengeNav({ challenges }) {
    const { t } = useTranslation();

    const list = challenges || [];
    const customized = useCustomizedChallengeIds(list);

    if (list.length === 0) return null;

    // No tick: the dots refresh with each challenge refetch, like StatusHeader.
    const nowSec = Math.floor(Date.now() / 1000);

    return (
        <ChipListPanel icon="📋" label={t('app.jumpToChallenge')} count={list.length}>
            {list.map((c) => {
                const kind = customized.get(String(c?.id));
                const manual = kind === 'manual' || kind === 'both';
                const automatic = kind === 'profile' || kind === 'both';
                const hint = [manual && t('app.customSettingsHint'), automatic && t('app.titleRuleProfile')]
                    .filter(Boolean)
                    .join(' · ');
                const boostOpen = isBoostWindowOpen(c?.member?.boost, nowSec);
                const lowExposure = isLowExposure(c, nowSec);
                return (
                    <ChallengeChip
                        key={c?.id}
                        challengeId={c?.id}
                        className={automatic ? 'btn-info' : manual ? 'btn-accent' : ''}
                    >
                        {boostOpen && <PulseDot variant="info" size="status-sm" />}
                        {lowExposure && <PulseDot variant="error" pulse={false} size="status-sm" />}
                        {manual && <span aria-hidden="true">⚙️ </span>}
                        {automatic && <span aria-hidden="true">🔄 </span>}
                        <ChipTitle hint={hint}>{c?.title}</ChipTitle>
                        {boostOpen && <span className="sr-only"> ({t('app.boostOpenBadge')})</span>}
                        {lowExposure && <span className="sr-only"> ({t('app.lowExposure')})</span>}
                        {hint && <span className="sr-only"> ({hint})</span>}
                    </ChallengeChip>
                );
            })}
        </ChipListPanel>
    );
}
