import { stripTerminalControl } from './logSafe';

/**
 * The plain text of a short HTML message the server sends (a photo's reason it cannot enter a challenge, say), as
 * the terminal and the renderer's text nodes show it. In order: an HTML comment is removed; `<br>` (with or without
 * attributes) becomes a dash between the lines, and a break at either end of the message separates nothing and is
 * dropped; a closing `</p>`, `</div>` or `</li>` becomes a space, so the blocks around it stay apart; every other tag the
 * pattern recognises is removed (a `>` inside a quoted attribute value does not end it); the named entities in
 * `ENTITIES` are decoded in one pass, so an encoded tag or entity stays literal text and any other entity, numeric
 * ones included, is left as written (a real `&mdash;` at either end stays); then control and invisible format
 * characters are dropped (`stripTerminalControl`, which keeps the two joiners) and whitespace is collapsed. Markup
 * the pattern does not recognise (an unterminated comment, a `<` not followed by a letter) stays as text, and the
 * result is not escaped: a caller that prints it must still treat it as text. The comment pass is not linear in the
 * length of the input, so a caller must bound it first (library.ts cuts the message to 800 characters).
 */

const ENTITIES = new Map<string, string>([
    ['&amp;', '&'],
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&quot;', '"'],
    ['&#39;', "'"],
    ['&nbsp;', ' '],
    ['&rsquo;', '’'],
    ['&lsquo;', '‘'],
    ['&rdquo;', '”'],
    ['&ldquo;', '“'],
    ['&hellip;', '…'],
    ['&mdash;', '—'],
    ['&ndash;', '–'],
]);

const COMMENTS = /<!--[\s\S]*?-->/g;
const LINE_BREAKS = /(?:<br\b(?:"[^"]*"|'[^']*'|[^<>"'])*>\s*)+/gi;
// The end of a block: its text must not run into the next one.
const BLOCK_ENDS = /<\/(?:p|div|li)\s*>/gi;
// A tag opens with a letter (or a slash and a letter): a `<` in running text is not one. A quoted attribute value
// may hold `<` and `>`.
const TAGS = /<\/?[a-z](?:"[^"]*"|'[^']*'|[^<>"'])*>/gi;
// Anything shaped like an entity: only those in ENTITIES change.
const ENTITY_SHAPE = /&#?\w+;/g;
// Stands for a `<br>` until the entities are decoded, so a dash the server wrote itself is told from a break.
const BREAK = '\uE000';
const BREAKS_AND_SPACE = new RegExp(`^[\\s${BREAK}]+|[\\s${BREAK}]+$`, 'g');

const htmlToText = (html: string): string =>
    stripTerminalControl(
        html
            .replaceAll(BREAK, '')
            .replace(COMMENTS, '')
            .replace(LINE_BREAKS, BREAK)
            .replace(BLOCK_ENDS, ' ')
            .replace(TAGS, '')
            // A break at either end separates nothing.
            .replace(BREAKS_AND_SPACE, '')
            .replace(ENTITY_SHAPE, (entity) => ENTITIES.get(entity) ?? entity)
            .replaceAll(BREAK, ' \u2014 '),
    )
        .replace(/\s+/g, ' ')
        .trim();

export { htmlToText };
