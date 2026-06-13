/**
 * Smooth-scroll the ChallengeCard with the given id into view. Cards carry
 * id="challenge-<id>" (see ChallengeCard) plus scroll-mt-4 for a small offset.
 * Shared by the boost-window banner and the challenge jump list so both stay in
 * sync. No-ops safely when the card isn't mounted.
 */
export function scrollToChallenge(id) {
    document.getElementById(`challenge-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
