import { sanitizeWelcomeMessage } from '../../src/js/react/utils/sanitizeWelcomeMessage';

describe('sanitizeWelcomeMessage', () => {
    test('returns empty string for null, undefined, empty', () => {
        expect(sanitizeWelcomeMessage(null)).toBe('');
        expect(sanitizeWelcomeMessage(undefined)).toBe('');
        expect(sanitizeWelcomeMessage('')).toBe('');
    });

    test('passes plain text through unchanged', () => {
        expect(sanitizeWelcomeMessage('Vote for the best photo!')).toBe('Vote for the best photo!');
    });

    test('strips medium-editor toolbar buttons and inputs but keeps the URLs', () => {
        const input = [
            '<button class="medium-editor-action medium-editor-action-bold" data-action="bold" title="bold">B</button>',
            '<button class="medium-editor-action medium-editor-action-italic" data-action="italic">I</button>',
            '<button class="medium-editor-action medium-editor-action-anchor" data-action="createLink">#</button>',
            '<input type="text" class="medium-editor-toolbar-input" placeholder="Paste or type a link">',
            'https://gurushots.com/alishak089/photos',
            '<button class="medium-editor-action" data-action="bold">B</button>',
            '<input type="text" class="medium-editor-toolbar-input">',
            'https://gurushots.com/birgit_how_else/photos',
        ].join('');

        const out = sanitizeWelcomeMessage(input);

        expect(out).not.toMatch(/<button/);
        expect(out).not.toMatch(/<input/);
        expect(out).not.toMatch(/medium-editor/);
        expect(out).toContain('href="https://gurushots.com/alishak089/photos"');
        expect(out).toContain('href="https://gurushots.com/birgit_how_else/photos"');
        expect(out).toContain('target="_blank"');
        expect(out).toContain('rel="noopener noreferrer"');
    });

    test('preserves allowlisted formatting tags', () => {
        const out = sanitizeWelcomeMessage('<b>hello</b> <i>world</i>');
        expect(out).toBe('<b>hello</b> <i>world</i>');
    });

    test('drops attributes on allowlisted tags', () => {
        const out = sanitizeWelcomeMessage('<b class="x" style="color:red" onclick="bad()">hi</b>');
        expect(out).toBe('<b>hi</b>');
    });

    test('drops javascript: anchor href', () => {
        const out = sanitizeWelcomeMessage('<a href="javascript:alert(1)">x</a>');
        expect(out).not.toMatch(/javascript:/);
        expect(out).toBe('<a>x</a>');
    });

    test('normalises safe anchor and removes inline handlers', () => {
        const out = sanitizeWelcomeMessage('<a href="https://example.com" onclick="x()">y</a>');
        expect(out).toBe('<a href="https://example.com" target="_blank" rel="noopener noreferrer">y</a>');
    });

    test('removes script tags and their content', () => {
        const out = sanitizeWelcomeMessage('<script>alert(1)</script>safe');
        expect(out).toBe('safe');
    });

    test('auto-linkifies bare URLs in text', () => {
        const out = sanitizeWelcomeMessage('see https://example.com for more');
        expect(out).toContain(
            '<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>',
        );
    });

    test('does not double-wrap URLs already inside anchors', () => {
        const out = sanitizeWelcomeMessage('<a href="https://x.com">link</a>');
        expect(out).toBe('<a href="https://x.com" target="_blank" rel="noopener noreferrer">link</a>');
    });

    test('trims trailing punctuation from auto-linkified URLs', () => {
        const out = sanitizeWelcomeMessage('see https://x.com/foo.');
        expect(out).toContain('href="https://x.com/foo"');
        expect(out).not.toContain('href="https://x.com/foo."');
        expect(out).toMatch(/<\/a>\.$/);
    });

    test('unwraps unknown but non-dangerous tags, keeping their text', () => {
        const out = sanitizeWelcomeMessage('<font color="red">hello</font>');
        expect(out).toBe('hello');
    });

    test('coerces non-string inputs to string', () => {
        expect(sanitizeWelcomeMessage(123)).toBe('123');
    });
});
