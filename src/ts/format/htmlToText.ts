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
 * result is not escaped: a caller that prints it must still treat it as text. The markup passes (comment, `<br>`, block
 * end, tag) repeat together until the text stops changing, so what one removal joins together (`<!<!---->-- x -->`,
 * `<scr<b>ipt>`, `x<b<i>r>y`) is read as the markup it has become on the next round. That is not linear in the
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
// may hold `<` and `>`. A `<br>` or a block end is left to the passes before this one, so that one this pass forms out
// of the text around a tag it removes (`x<b<i>r>y`) is still turned into a dash or a space on the next round.
const TAGS = /<(?!br\b|\/(?:p|div|li)\s*>)\/?[a-z](?:"[^"]*"|'[^']*'|[^<>"'])*>/gi;
// Anything shaped like an entity: only those in ENTITIES change.
const ENTITY_SHAPE = /&#?\w+;/g;
// Stands for a `<br>` until the entities are decoded, so a dash the server wrote itself is told from a break.
const BREAK = '\uE000';
const BREAKS_AND_SPACE = new RegExp(`^[\\s${BREAK}]+|[\\s${BREAK}]+$`, 'g');

// One removal can join the text around it into markup (`<!<!---->-- x -->`, `<scr<b>ipt>`, `x<b<i>r>y`). Each of the
// comment and tag removals runs until its own text stops changing: that inner fixpoint is what CodeQL recognises as a
// complete removal. The outer loop runs all the passes again until nothing changes, which covers markup that one pass
// forms for another (a `<br>` or a block end made by the tag pass, a comment made by it). Every round that changes the
// text makes it shorter (a comment, a tag, a `<br>` or a block end is at least three characters and leaves at most one),
// so both loops end.
const removeAll = (text: string, pattern: RegExp): string => {
    let previous: string;
    do {
        previous = text;
        text = text.replace(pattern, '');
    } while (text !== previous);
    return text;
};

const removeMarkup = (text: string): string => {
    let previous: string;
    do {
        previous = text;
        text = removeAll(text, COMMENTS).replace(LINE_BREAKS, BREAK).replace(BLOCK_ENDS, ' ');
        text = removeAll(text, TAGS);
    } while (text !== previous);
    return text;
};

const htmlToText = (html: string): string =>
    stripTerminalControl(
        removeMarkup(html.replaceAll(BREAK, ''))
            // A break at either end separates nothing.
            .replace(BREAKS_AND_SPACE, '')
            .replace(ENTITY_SHAPE, (entity) => ENTITIES.get(entity) ?? entity)
            .replaceAll(BREAK, ' \u2014 '),
    )
        .replace(/\s+/g, ' ')
        .trim();

export { htmlToText };
