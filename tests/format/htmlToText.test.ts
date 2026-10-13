/**
 * htmlToText: the plain text of the server's short HTML messages — line breaks as a dash, tags gone, a fixed set of
 * named entities decoded after the tags are removed (so an encoded tag stays text), numeric entities left alone.
 */

import { htmlToText } from '../../src/ts/format/htmlToText';

describe('htmlToText', () => {
    test('removes tags and keeps their text', () => {
        expect(htmlToText('This image <b>has won a challenge</b> <span class="x">today</span>')).toBe(
            'This image has won a challenge today',
        );
    });

    test.each(['<br>', '<br/>', '<br />', '<BR>', '<br/><br/>', '<br>\n<br>'])(
        'a line break (%j) becomes one dash between the lines',
        (br) => {
            expect(htmlToText(`one${br}two`)).toBe('one — two');
        },
    );

    test('the server’s own wording reads as one line', () => {
        expect(
            htmlToText("This image <b>has won a challenge</b><br/><span>it can't participate in another</span>"),
        ).toBe("This image has won a challenge — it can't participate in another");
    });

    test('a break at either end separates nothing', () => {
        expect(htmlToText('<br/>text<br>')).toBe('text');
        expect(htmlToText('<br/>')).toBe('');
    });

    test.each([
        ['&amp;', '&'],
        ['&lt;', '<'],
        ['&gt;', '>'],
        ['&quot;', '"'],
        ['&#39;', "'"],
        ['a&nbsp;b', 'a b'],
    ])('decodes the named entity %s', (entity, text) => {
        expect(htmlToText(entity)).toBe(text);
    });

    test('an encoded tag stays literal text: entities are decoded after the tags are removed, and once', () => {
        expect(htmlToText('&lt;b&gt;bold&lt;/b&gt;')).toBe('<b>bold</b>');
        expect(htmlToText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    });

    test('numeric entities and other named ones are left as they are', () => {
        expect(htmlToText('line&#10;feed &#x41; &copy; &#0;')).toBe('line&#10;feed &#x41; &copy; &#0;');
    });

    test('a `<` in running text is not a tag', () => {
        expect(htmlToText('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2');
        expect(htmlToText('a <3 b')).toBe('a <3 b');
        expect(htmlToText('open < <b>bold</b>')).toBe('open < bold');
    });

    test('collapses whitespace and trims', () => {
        expect(htmlToText('  a \n\t b   <i> c </i> ')).toBe('a b c');
    });

    test.each(['', '   ', '<b></b>', '<span> </span>'])('nothing is left of %j', (html) => {
        expect(htmlToText(html)).toBe('');
    });
});
