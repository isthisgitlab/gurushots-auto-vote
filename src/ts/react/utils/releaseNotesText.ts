// Layout tags as fixed, case-insensitive patterns — never a RegExp built from the notes themselves.
const BULLET_OPEN = /<li\b[^>]*>/gi;
const LINE_BREAKS = /<br\s*\/?>|<\/p>|<\/li>/gi;
const BLANK_RUNS = /\n{3,}/g;

/**
 * Release notes as plain text. electron-updater's GitHub feed sends them as HTML, which would otherwise show its
 * raw tags: the layout tags become line breaks and bullets, the rest is read through an inert DOMParser document
 * (no script runs, no resource loads) and only its text is kept. The result is meant to be rendered as React text,
 * never as markup.
 *
 * @param notes - the notes as delivered: HTML, Markdown or plain text
 */
export const releaseNotesText = (notes: string): string => {
    const laidOut = notes.replace(BULLET_OPEN, '• ').replace(LINE_BREAKS, '\n');
    // An element's textContent is never null.
    const text = new DOMParser().parseFromString(laidOut, 'text/html').body.textContent as string;
    return text.replace(BLANK_RUNS, '\n\n').trim();
};
