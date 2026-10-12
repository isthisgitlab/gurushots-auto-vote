/**
 * The DaisyUI badge colour classes of the GuruShots ranking levels. Each sets the badge's own colour variables from
 * the level colours defined with the theme in styles.css (`--color-level-*`), so there is no custom badge class.
 */
export const LEVEL_BADGE_CLASS = {
    popular: '[--badge-color:var(--color-level-popular)] [--badge-fg:white]',
    skilled: '[--badge-color:var(--color-level-skilled)] [--badge-fg:white]',
    premier: '[--badge-color:var(--color-level-premier)] [--badge-fg:white]',
    elite: '[--badge-color:var(--color-level-elite)] [--badge-fg:white]',
    allstar: '[--badge-color:var(--color-level-allstar)] [--badge-fg:white]',
} as const;
