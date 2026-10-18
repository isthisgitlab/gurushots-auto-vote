import { releaseNotesText } from '@/utils/releaseNotesText';

describe('releaseNotesText', () => {
    test('turns list items into bullets and paragraph ends into line breaks', () => {
        expect(releaseNotesText('<p>Fixes</p><ul><li>One</li><li>Two</li></ul>')).toBe('Fixes\n• One\n• Two');
    });

    test('collapses the blank lines GitHub leaves between tags to one', () => {
        const html = '<h2>Changes</h2>\n<ul>\n<li>One</li>\n<li>Two</li>\n</ul>\n\n\n<p>Thanks</p>\n';
        expect(releaseNotesText(html)).toBe('Changes\n\n• One\n\n• Two\n\nThanks');
    });

    test('reads <br>, <br/>, <br /> and attributes on <li> in any letter case', () => {
        expect(releaseNotesText('a<br>b<BR/>c<br />d')).toBe('a\nb\nc\nd');
        expect(releaseNotesText('<UL><LI class="x">One</LI></UL>')).toBe('• One');
    });

    test('keeps entities as the characters they stand for, and plain text as it is', () => {
        expect(releaseNotesText('Fish &amp; chips &lt;3')).toBe('Fish & chips <3');
        expect(releaseNotesText('  - a\n- b  ')).toBe('- a\n- b');
        expect(releaseNotesText('')).toBe('');
    });

    test('drops markup it has no layout for, scripts included, keeping only text', () => {
        expect(releaseNotesText('<p onclick="x()">Hi <b>there</b></p><img src="https://example.test/a.png">')).toBe(
            'Hi there',
        );
        expect(releaseNotesText('<style>p{}</style>Done')).not.toContain('<');
    });

    test('parses through an inert DOMParser document and adds nothing to the page', () => {
        const parse = jest.spyOn(DOMParser.prototype, 'parseFromString');
        const before = document.body.childNodes.length;
        releaseNotesText('<img src="https://example.test/a.png" onerror="alert(1)"><script>alert(1)</script>x');
        expect(parse).toHaveBeenCalledTimes(1);
        expect(parse).toHaveBeenCalledWith(expect.any(String), 'text/html');
        expect(document.body.childNodes.length).toBe(before);
        parse.mockRestore();
    });
});
