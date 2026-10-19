/**
 * htmlToText: the plain text of the server's short HTML messages — line breaks as a dash, tags gone, a fixed set of
 * named entities decoded after the tags are removed (so an encoded tag stays text), numeric entities left alone,
 * control and invisible format characters dropped.
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

    test('a line break with attributes is a break too, not glued text', () => {
        expect(htmlToText('one<br class="x">two')).toBe('one \u2014 two');
        expect(htmlToText('one<BR clear=\'all\' data-x="a > b"/>two')).toBe('one \u2014 two');
        expect(htmlToText('<br class="x">text<br id=y>')).toBe('text');
        expect(htmlToText('one<brand>two')).toBe('onetwo');
    });

    test('the end of a paragraph, division or list item keeps its text apart from the next block', () => {
        expect(htmlToText('<p>First</p><p>Second</p>')).toBe('First Second');
        expect(htmlToText('<div>One</div><div>Two</div>')).toBe('One Two');
        expect(htmlToText('<ul><li>a</li><LI>b</LI ></ul>')).toBe('a b');
        expect(htmlToText('<p>kept</p>')).toBe('kept');
    });

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
        ['&rsquo;', '\u2019'],
        ['&lsquo;', '\u2018'],
        ['&rdquo;', '\u201D'],
        ['&ldquo;', '\u201C'],
        ['&hellip;', '\u2026'],
        ['a&mdash;b', 'a\u2014b'],
        ['&ndash;', '\u2013'],
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

    test('a dash the server wrote at either end of the message stays, unlike a break', () => {
        expect(htmlToText('&mdash; reason')).toBe('\u2014 reason');
        expect(htmlToText('reason &mdash;')).toBe('reason \u2014');
        expect(htmlToText('<br>&mdash; reason &mdash;<br>')).toBe('\u2014 reason \u2014');
    });

    test('a private-use character in the input is not mistaken for a break', () => {
        expect(htmlToText('a\uE000b')).toBe('ab');
    });

    test('a `>` inside a quoted attribute value does not end the tag', () => {
        expect(htmlToText('<a title="a > b" href=\'x>y\'>link</a> after')).toBe('link after');
    });

    test('an HTML comment is removed, with what it holds', () => {
        expect(htmlToText('before<!-- <br> hidden -->after')).toBe('beforeafter');
        expect(htmlToText('<!-- never closed')).toBe('<!-- never closed');
    });

    test('what one removal joins into a comment or a tag is removed too', () => {
        expect(htmlToText('a<!<!---->-- x -->b')).toBe('ab');
        expect(htmlToText('a<scr<b>ipt>alert(1)</scr</i>ipt>b')).toBe('aalert(1)b');
        expect(htmlToText('x<b<i>r>y')).toBe('x — y');
        expect(htmlToText('a</<b>p>b')).toBe('a b');
        expect(htmlToText('a<<b>!-- x -->b')).toBe('ab');
    });

    test('an unknown entity is left as written', () => {
        expect(htmlToText('&bogus; &amp;')).toBe('&bogus; &');
    });

    test('control and invisible format characters are dropped, the joiners stay', () => {
        expect(htmlToText('a\u202Eb\u001B[31mc\u200Bd\u0007e')).toBe('abcde');
        expect(htmlToText('x\u200Dy\u200Cz')).toBe('x\u200Dy\u200Cz');
    });

    test('a very long input is converted in one pass', () => {
        const long = `${'<b>x</b> &amp; '.repeat(20_000)}<br>`;
        expect(htmlToText(long)).toBe(`${'x & '.repeat(20_000).trim()}`);
        expect(htmlToText(`<a ${'"'.repeat(50_001)}`)).toBe(`<a ${'"'.repeat(50_001)}`);
        expect(htmlToText(`<br ${'"'.repeat(50_001)}`)).toBe(`<br ${'"'.repeat(50_001)}`);
    });
});
