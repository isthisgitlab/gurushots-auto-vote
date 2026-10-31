import type { Challenge, MemberTurbo } from '../types/gurushots';

/**
 * Whether a turbo reports a game the bot can play and trust: 'classic' or 'snap'. Only the web read reports a mode;
 * a turbo without one is the mobile copy, whose WON can be false for a Snap game, so it is neither played nor
 * counted as won. Pure, so the engine and the renderer share it.
 */
const isKnownTurboMode = (turbo: MemberTurbo | null | undefined): boolean =>
    turbo?.mode === 'classic' || turbo?.mode === 'snap';

/**
 * A challenge-level turbo state as the status code the view words — the shared half of the renderer's
 * `getTurboStatus` (react/utils/formatters.ts), which adds the colour class and the translated text, so every
 * caller words a state the same way. The renderer's `getTurboStatus` is the only consumer; the CLI's
 * challenges listing words the turbo state itself (cli/commands/challenges.ts) and uses `canPlayTurbo` /
 * `isKnownTurboMode`, not this.
 *
 * An 'other' code means the API reported a non-empty state this app has no wording for; the raw state travels
 * separately (the renderer shows it verbatim).
 */
type TurboStatusCode = 'unavailable' | 'free' | 'timer' | 'inProgress' | 'won' | 'used' | 'locked' | 'other';

const turboStatusCode = (turbo: MemberTurbo | null | undefined): TurboStatusCode => {
    if (!turbo || !turbo.state) return 'unavailable';
    switch (turbo.state) {
        case 'FREE':
            return 'free';
        case 'TIMER':
            return 'timer';
        case 'IN_PROGRESS':
            return 'inProgress';
        case 'WON':
            return 'won';
        case 'USED':
            return 'used';
        case 'UNAVAILABLE':
            return 'unavailable';
        case 'LOCKED':
            return 'locked';
        default:
            // state is non-empty here (guarded above), so the renderer can show it verbatim.
            return 'other';
    }
};

/**
 * Whether the challenge's turbo mini-game can be played right now: the challenge is still open, the mode is a
 * known one (see isKnownTurboMode), and the state offers a game — FREE, the one already in progress, or a TIMER
 * whose cooldown has elapsed at `now`. Deliberately setting-free: the auto-turbo rule's own gate (the
 * `autoTurbo` setting and the Snap-unavailable mark added) is shouldPlayAutoTurbo in
 * services/decisions/boostTurbo.ts; this is the "could a play happen now" half that the card's button and the
 * CLI's challenges listing share.
 *
 * Pure, and optional-chained, so a challenge whose standing cannot be read simply reads as not playable.
 *
 * @param now - Unix seconds
 */
const canPlayTurbo = (challenge: Challenge | null | undefined, now: number): boolean => {
    const turbo = challenge?.member?.turbo;
    const state = turbo?.state;
    const cooldownPassed = state === 'TIMER' && typeof turbo?.time_to_open === 'number' && turbo.time_to_open <= now;
    return (
        Number(challenge?.close_time) > now &&
        isKnownTurboMode(turbo) &&
        (state === 'FREE' || state === 'IN_PROGRESS' || cooldownPassed)
    );
};

export { canPlayTurbo, isKnownTurboMode, turboStatusCode };
export type { TurboStatusCode };
