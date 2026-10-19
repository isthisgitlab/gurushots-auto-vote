/**
 * The scroll behaviour for a programmatic scroll: smooth, unless the user asked their system for reduced motion.
 */
export const scrollBehavior = (): ScrollBehavior =>
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth';
