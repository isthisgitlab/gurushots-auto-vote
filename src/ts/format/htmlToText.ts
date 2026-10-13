/**
 * The plain text of a short HTML message the server sends (a photo's reason it cannot enter a challenge, say), as
 * the terminal and the renderer's text nodes show it: `<br>` becomes a dash between the lines, every other tag is
 * removed, and only then a fixed set of named entities is decoded, so an encoded tag stays literal text. Numeric
 * entities are left as they are: decoding them would let the server write any character, a control character included.
 */

const ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
};

const LINE_BREAKS = /(?:<br\s*\/?>\s*)+/gi;
// A tag opens with a letter (or a slash and a letter): a `<` in running text is not one.
const TAGS = /<\/?[a-z][^<>]*>/gi;
const NAMED_ENTITIES = /&(?:amp|lt|gt|quot|#39|nbsp);/g;
const LINE_SEPARATOR = '—';

const htmlToText = (html: string): string =>
    html
        .replace(LINE_BREAKS, ` ${LINE_SEPARATOR} `)
        .replace(TAGS, '')
        .replace(NAMED_ENTITIES, (entity) => ENTITIES[entity])
        .replace(/\s+/g, ' ')
        .trim()
        // A break at either end separates nothing.
        .replace(new RegExp(`^${LINE_SEPARATOR}\\s*|\\s*${LINE_SEPARATOR}$`, 'g'), '');

export { htmlToText };
