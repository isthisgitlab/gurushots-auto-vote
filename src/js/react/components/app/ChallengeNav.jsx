import { useTranslation } from '@/contexts/TranslationContext';
import { useOverriddenChallengeIds } from '@/hooks/useOverriddenChallengeIds';
import { ChipListPanel, ChallengeChip } from './ChallengeChips';

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
 */
export function ChallengeNav({ challenges }) {
    const { t } = useTranslation();

    const list = challenges || [];
    const overridden = useOverriddenChallengeIds(list);

    if (list.length === 0) return null;

    return (
        <ChipListPanel icon="📋" label={t('app.jumpToChallenge')} count={list.length}>
            {list.map((c) => {
                const custom = overridden.has(String(c?.id));
                return (
                    <ChallengeChip
                        key={c?.id}
                        challengeId={c?.id}
                        className={custom ? 'btn-accent' : ''}
                        title={custom ? t('app.customSettingsHint') : undefined}
                    >
                        {custom && <span aria-hidden="true">⚙️ </span>}
                        {c?.title}
                        {custom && <span className="sr-only"> ({t('app.customSettingsHint')})</span>}
                    </ChallengeChip>
                );
            })}
        </ChipListPanel>
    );
}
