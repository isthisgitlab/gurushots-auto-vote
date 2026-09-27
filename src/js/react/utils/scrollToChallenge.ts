import type { Challenge } from '../../types/gurushots';
/**
 * Smooth-scroll and focus the ChallengeCard with the given id. Cards carry
 * id="challenge-<id>" (see ChallengeCard) plus scroll-mt-4 for a small offset.
 * Shared by the boost-window banner and the challenge jump list so both stay in
 * sync. No-ops safely when the card isn't mounted.
 */
export function scrollToChallenge(id: Challenge['id']) {
    const card = document.getElementById(`challenge-${id}`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card?.focus({ preventScroll: true });
}
