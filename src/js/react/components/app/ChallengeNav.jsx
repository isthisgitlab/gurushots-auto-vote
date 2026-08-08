import { useTranslation } from '@/contexts/TranslationContext';
import { ChipListPanel, ChallengeChip } from './ChallengeChips';

/**
 * "Jump to challenge" index placed above the challenge list. Lists every active
 * challenge by title in the same order the cards render; each entry is a button
 * that smooth-scrolls to the matching ChallengeCard (id="challenge-<id>"), so a
 * user who knows the name can click instead of scrolling. Renders nothing when
 * there are no challenges. Mirrors BoostWindowBanner, but for the full list.
 */
export function ChallengeNav({ challenges }) {
    const { t } = useTranslation();

    const list = challenges || [];
    if (list.length === 0) return null;

    return (
        <ChipListPanel icon="📋" label={t('app.jumpToChallenge')} count={list.length}>
            {list.map((c) => (
                <ChallengeChip key={c.id} challengeId={c.id}>
                    {c.title}
                </ChallengeChip>
            ))}
        </ChipListPanel>
    );
}
