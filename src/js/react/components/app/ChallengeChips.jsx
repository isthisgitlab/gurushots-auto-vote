import { scrollToChallenge } from '@/utils/scrollToChallenge';

/**
 * Bordered panel above the challenge list holding a heading (emoji +
 * label + count) and a wrapping row of chips. Shared by ChallengeNav
 * and BoostWindowBanner, whose wrappers were structurally identical.
 */
export function ChipListPanel({ icon, label, count, children }) {
    return (
        <div className="rounded-lg border border-base-300 bg-base-100 p-2 mb-4">
            <div className="text-sm font-medium mb-2">
                <span aria-hidden="true">{icon}</span> {label} ({count})
            </div>
            <div className="flex flex-wrap gap-2">{children}</div>
        </div>
    );
}

/**
 * One anchor chip: a small button that smooth-scrolls to the matching
 * ChallengeCard (id="challenge-<id>"). Content is caller-supplied so a
 * chip can carry extra detail (e.g. the boost countdown).
 */
export function ChallengeChip({ challengeId, children }) {
    return (
        <button
            type="button"
            className="btn btn-xs h-auto whitespace-normal text-left"
            onClick={() => scrollToChallenge(challengeId)}
        >
            {children}
        </button>
    );
}
