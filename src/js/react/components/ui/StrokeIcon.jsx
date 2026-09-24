/**
 * Outline-icon path data (Heroicons v1 outline, 24x24) for the glyphs drawn
 * with StrokeIcon. One `d` per glyph so a shape is never copy-pasted.
 */
export const ICON_PATHS = {
    // Check in a circle — Vote / Vote All, and the update-ready notice.
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
    // Cog (outline + hub) — per-challenge settings and the app Settings button.
    cog: [
        'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
        'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    ],
    // X — Stop auto-vote and the modal close button.
    close: 'M6 18L18 6M6 6l12 12',
    // Smiling face — Start auto-vote.
    smile: 'M14.828 14.828a4 4 0 01-5.656 0M9 10h1m4 0h1m-6 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    // Page with text lines — Logs.
    document:
        'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    // Arrow leaving a door — Logout.
    logout: 'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1',
    // X in a circle — update error and the login error alert.
    xCircle: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',
    // Upward chevron — scroll to top.
    chevronUp: 'M5 15l7-7 7 7',
    // Info "i" in a circle — explanatory alert.
    info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    // Plus — add a row.
    plus: 'M12 4v16m8-8H4',
    // Letter pair "A" / script glyph — language switcher.
    translate:
        'M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129',
};

/**
 * Stroked outline SVG icon (`currentColor`, round caps/joins, width 2) — the
 * shape every inline button glyph shares. `d` is one path string or an array
 * of them for a multi-path glyph; `className` carries the Tailwind size and
 * spacing. Decorative: the button around it carries the accessible name.
 *
 * @param {{ d: string | string[], className: string }} props
 */
export function StrokeIcon({ d, className }) {
    const paths = Array.isArray(d) ? d : [d];
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            {paths.map((path) => (
                <path key={path} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={path} />
            ))}
        </svg>
    );
}
