import type { MemberTurbo } from '../types/gurushots';

/**
 * Whether a turbo reports a game the bot can play and trust: 'classic' or 'snap'. Only the web read reports a mode;
 * a turbo without one is the mobile copy, whose WON can be false for a Snap game, so it is neither played nor
 * counted as won. Pure, so the engine and the renderer share it.
 */
const isKnownTurboMode = (turbo: MemberTurbo | null | undefined): boolean =>
    turbo?.mode === 'classic' || turbo?.mode === 'snap';

export { isKnownTurboMode };
