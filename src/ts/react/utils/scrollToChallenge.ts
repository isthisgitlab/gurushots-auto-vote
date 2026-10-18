import type { Challenge } from '../../types/gurushots';
import { scrollBehavior } from './scrollBehavior';
/**
 * Scroll to (smoothly, unless the user prefers reduced motion) and focus the ChallengeCard with the given id. Cards carry
 * id="challenge-<id>" (see ChallengeCard) plus scroll-mt-4 for a small offset.
 * Shared by the boost-window banner and the challenge jump list so both stay in
 * sync. No-ops safely when the card isn't mounted.
 * The card also gets data-landed until it loses focus: the card shows its outline only for :focus-visible, which
 * a pointer jump (a click or tap on a chip) does not trigger, and data-landed keeps the landing cue for it.
 */
export function scrollToChallenge(id: Challenge['id']) {
    const card = document.getElementById(`challenge-${id}`);
    card?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    card?.focus({ preventScroll: true });
    if (card) {
        card.dataset.landed = '';
        card.addEventListener('blur', () => delete card.dataset.landed, { once: true });
    }
}
