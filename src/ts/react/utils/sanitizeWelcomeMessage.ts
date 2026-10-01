// Sanitises challenge `welcome_message` strings before they are rendered.
// The GuruShots API occasionally returns medium-editor WYSIWYG toolbar markup
// leaked into the description (rows of `<button data-action="bold">B</button>`
// + a `<input class="medium-editor-toolbar-input">`). Rendering that raw paints
// inert toolbar UI inside the card. We strip it here and keep only meaningful
// formatting and links, then auto-linkify bare URLs.

const ALLOWED_TAGS = new Set([
    'b',
    'strong',
    'i',
    'em',
    'u',
    'a',
    'p',
    'br',
    'h2',
    'h3',
    'h4',
    'ul',
    'ol',
    'li',
    'span',
    'div',
]);

// Removed together with everything they contain. Two groups:
//   1. WYSIWYG-toolbar / interactive junk we never want to render
//      (button/input/select/textarea/form) plus the classic script-bearing
//      elements (script/style/iframe/object/embed/link/meta/noscript).
//   2. Foreign-content / re-parsing elements that are the raw material for
//      mutation-XSS (mXSS): the HTML parser switches namespaces inside
//      <svg>/<math> (MathML/SVG integration points let <mglyph>,
//      <annotation-xml>, <mtext> smuggle markup that re-parses as HTML when
//      innerHTML is re-serialized), and <template>/<noembed>/<xmp>/<plaintext>
//      have bespoke "raw text" / inert-DOM parsing modes whose serialize→
//      re-parse round-trip differs from what our walker saw. Dropping the
//      whole subtree — rather than unwrapping and keeping children — is what
//      closes that class. `dangerouslySetInnerHTML` on the result means any
//      differential here would be a live sink, so we strip aggressively; the
//      CSP `script-src 'self'` in the HTML shell is the second layer.
const STRIP_WITH_CONTENTS = new Set([
    'button',
    'input',
    'select',
    'textarea',
    'form',
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'svg',
    'math',
    'template',
    'noembed',
    'xmp',
    'plaintext',
    'mglyph',
    'annotation-xml',
    'title',
    'base',
    'frame',
    'frameset',
    'link',
    'meta',
    'noscript',
]);

const URL_RE = /\bhttps?:\/\/[^\s<]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)]+$/;
const SAFE_HREF_RE = /^(?:https?:\/\/|mailto:)/i;

function isMediumEditorJunk(el: Element) {
    if (el.hasAttribute && el.hasAttribute('data-action')) return true;
    const cls = el.getAttribute && el.getAttribute('class');
    return Boolean(cls && /(^|\s)medium-editor/.test(cls));
}

function stripAttributes(el: Element) {
    const attrs = Array.from(el.attributes);
    for (const { name } of attrs) el.removeAttribute(name);
}

function normaliseAnchor(el: Element) {
    const href = el.getAttribute('href') || '';
    stripAttributes(el);
    if (SAFE_HREF_RE.test(href)) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
    }
}

function unwrap(el: Element) {
    const parent = el.parentNode as ParentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
}

function walk(node: Node) {
    const children = Array.from(node.childNodes);
    for (const childNode of children) {
        if (childNode.nodeType !== 1 /* ELEMENT_NODE */) continue;
        const child = childNode as Element;
        const tag = child.tagName.toLowerCase();

        if (STRIP_WITH_CONTENTS.has(tag) || isMediumEditorJunk(child)) {
            child.remove();
            continue;
        }

        if (ALLOWED_TAGS.has(tag)) {
            if (tag === 'a') {
                normaliseAnchor(child);
            } else {
                stripAttributes(child);
            }
            walk(child);
            continue;
        }

        walk(child);
        unwrap(child);
    }
}

function escapeText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isInsideAnchor(textNode: Node, root: Node): boolean {
    let p: (ParentNode & { tagName?: string }) | null = textNode.parentNode;
    while (p && p !== root) {
        if (p.tagName && p.tagName.toLowerCase() === 'a') return true;
        p = p.parentNode;
    }
    return false;
}

function collectTextNodes(root: Node, doc: Document): Node[] {
    const walker = doc.createTreeWalker(root, /* NodeFilter.SHOW_TEXT */ 4);
    const out: Node[] = [];
    let n = walker.nextNode();
    while (n) {
        if (!isInsideAnchor(n, root)) out.push(n);
        n = walker.nextNode();
    }
    return out;
}

function linkifyTextNodes(root: Node, doc: Document) {
    for (const textNode of collectTextNodes(root, doc)) {
        const text = textNode.nodeValue as string;
        const matches = Array.from(text.matchAll(URL_RE));
        if (matches.length === 0) continue;

        const frag = doc.createDocumentFragment();
        let last = 0;
        for (const m of matches) {
            const raw = m[0];
            const trimmed = raw.replace(TRAILING_PUNCT_RE, '');
            const start = m.index;
            const end = start + trimmed.length;

            if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));

            const a = doc.createElement('a');
            a.setAttribute('href', trimmed);
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
            a.textContent = trimmed;
            frag.appendChild(a);

            last = end;
        }
        if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
        (textNode.parentNode as ParentNode).replaceChild(frag, textNode);
    }
}

/**
 * @param input - Raw `welcome_message`; null/undefined render as ''.
 * @returns Sanitised HTML, safe for dangerouslySetInnerHTML.
 */
export function sanitizeWelcomeMessage(input: string | null | undefined): string {
    if (input == null) return '';
    const str = String(input);
    if (str.length === 0) return '';

    try {
        if (str.indexOf('<') === -1 && str.indexOf('&') === -1) {
            const doc = new DOMParser().parseFromString('<div></div>', 'text/html');
            const wrap = doc.body.firstChild as HTMLElement;
            wrap.appendChild(doc.createTextNode(str));
            linkifyTextNodes(wrap, doc);
            return wrap.innerHTML;
        }

        const doc = new DOMParser().parseFromString('<div>' + str + '</div>', 'text/html');
        const wrap = doc.body.firstChild as HTMLElement;
        walk(wrap);
        linkifyTextNodes(wrap, doc);
        return wrap.innerHTML;
    } catch {
        // Strip to a fixpoint so no pass can leave a reassembled tag behind;
        // escapeText then neutralises any stray `<` / `>` that remain.
        let text = str;
        let prev;
        do {
            prev = text;
            text = text.replace(/<[^>]+>/g, '');
        } while (text !== prev);
        return escapeText(text);
    }
}
