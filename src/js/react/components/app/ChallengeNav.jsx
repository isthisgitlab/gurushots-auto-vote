import { useTranslation } from '@/contexts/TranslationContext';
import { scrollToChallenge } from '@/utils/scrollToChallenge';

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
        <div className="rounded-lg border border-base-300 bg-base-100 p-2 mb-4">
            <div className="text-sm font-medium mb-2">
                <span aria-hidden="true">📋</span> {t('app.jumpToChallenge')} ({list.length})
            </div>
            <div className="flex flex-wrap gap-2">
                {list.map((c) => (
                    <button
                        key={c.id}
                        type="button"
                        className="btn btn-xs"
                        title={c.title}
                        onClick={() => scrollToChallenge(c.id)}
                    >
                        <span className="truncate max-w-[10rem]">{c.title}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}
