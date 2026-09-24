/**
 * Outline-icon path data (Heroicons v1 outline, 24x24) for the glyphs drawn
 * with StrokeIcon. One `d` per glyph so a shape is never copy-pasted.
 */
export const ICON_PATHS = {
    // Check in a circle — Vote / Vote All.
    vote: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    // Lightning bolt — Run / Run cycle.
    run: 'M13 10V3L4 14h7v7l9-11h-7z',
    // Circular arrows — reset to default / refresh.
    reset: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    // Check mark — Save.
    save: 'M5 13l4 4L19 7',
    // Trash can — Clear All.
    trash: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
    // Three lines, the last one short — the compact list layout.
    listCompact: 'M4 6h16M4 12h16M4 18h7',
    // Four full lines — the detailed list layout.
    listDetailed: 'M4 6h16M4 10h16M4 14h16M4 18h16',
    // Cog (outline + hub) — per-challenge settings.
    cog: [
        'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
        'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    ],
};

/**
 * Stroked outline SVG icon (`currentColor`, round caps/joins, width 2) — the
 * shape every inline button glyph shares. `d` is one path string or an array
 * of them for a multi-path glyph; `className` carries the Tailwind size and
 * spacing.
 *
 * @param {{ d: string | string[], className: string }} props
 */
export function StrokeIcon({ d, className }) {
    const paths = Array.isArray(d) ? d : [d];
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {paths.map((path) => (
                <path key={path} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={path} />
            ))}
        </svg>
    );
}
