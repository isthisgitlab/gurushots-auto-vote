/**
 * The Tailwind classes that colour the GuruShots ranking levels, from the level colours defined with the theme in
 * styles.css (`--color-level-*`), so there is no custom class. `LEVEL_BADGE_CLASS` sets a DaisyUI badge's own colour
 * variables; `LEVEL_PROGRESS_CLASS` sets the `color` a DaisyUI `progress` paints its fill with (`currentColor`).
 */
export const LEVEL_BADGE_CLASS = {
    popular: '[--badge-color:var(--color-level-popular)] [--badge-fg:white]',
    skilled: '[--badge-color:var(--color-level-skilled)] [--badge-fg:white]',
    premier: '[--badge-color:var(--color-level-premier)] [--badge-fg:white]',
    elite: '[--badge-color:var(--color-level-elite)] [--badge-fg:white]',
    allstar: '[--badge-color:var(--color-level-allstar)] [--badge-fg:white]',
} as const;

export const LEVEL_PROGRESS_CLASS = {
    popular: '[color:var(--color-level-popular)]',
    skilled: '[color:var(--color-level-skilled)]',
    premier: '[color:var(--color-level-premier)]',
    elite: '[color:var(--color-level-elite)]',
    allstar: '[color:var(--color-level-allstar)]',
} as const;
