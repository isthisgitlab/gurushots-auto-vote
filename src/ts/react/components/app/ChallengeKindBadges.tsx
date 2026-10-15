import { useTranslation } from '@/contexts/TranslationContext';
import { StatusBadge } from '../ui/StatusBadge';
import { challengeKind, challengePhotoCount } from '../../../format/challengeListing';

import type { Challenge } from '../../../types/gurushots';

/**
 * The challenge's type (its badge when it has none) and how many photos it takes, as the challenge card and the
 * Discover rows show them. `showPhotoCount` is off in the compact tile, where the entries cell already reads
 * N/max and the badge would only repeat the max.
 */
export function ChallengeKindBadges({
    challenge,
    showPhotoCount = true,
}: {
    challenge: Pick<Challenge, 'type' | 'badge' | 'max_photo_submits'>;
    showPhotoCount?: boolean;
}) {
    const { t } = useTranslation();
    const kind = challengeKind(challenge);
    const photos = showPhotoCount ? challengePhotoCount(challenge) : null;
    return (
        <>
            {kind?.isType && <StatusBadge variant="warning">🏁 {kind.label.toUpperCase()}</StatusBadge>}
            {kind && !kind.isType && <StatusBadge variant="info">🏁 {kind.label}</StatusBadge>}
            {photos !== null && (
                <StatusBadge variant="warning">
                    🖼 {photos} {t('app.photos')}
                </StatusBadge>
            )}
        </>
    );
}

/** The challenge's tags as small badges (the caller decides which tags are worth showing). */
export function ChallengeTagBadges({ tags }: { tags: string[] }) {
    return (
        <>
            {tags.map((tag, index) => (
                <span key={index} className="badge badge-ghost badge-sm">
                    {tag}
                </span>
            ))}
        </>
    );
}
