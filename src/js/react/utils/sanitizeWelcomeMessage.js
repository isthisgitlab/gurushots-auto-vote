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
    'link',
    'meta',
    'noscript',
]);

const URL_RE = /\bhttps?:\/\/[^\s<]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)]+$/;
const SAFE_HREF_RE = /^(?:https?:\/\/|mailto:)/i;

function isMediumEditorJunk(el) {
    if (el.hasAttribute && el.hasAttribute('data-action')) return true;
    const cls = el.getAttribute && el.getAttribute('class');
    return Boolean(cls && /(^|\s)medium-editor/.test(cls));
}

function stripAttributes(el) {
    const attrs = Array.from(el.attributes || []);
    for (const { name } of attrs) el.removeAttribute(name);
}

function normaliseAnchor(el) {
    const href = el.getAttribute('href') || '';
    stripAttributes(el);
    if (SAFE_HREF_RE.test(href)) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
    }
}

function unwrap(el) {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
}

function walk(node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
        if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;
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

function escapeText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isInsideAnchor(textNode, root) {
    let p = textNode.parentNode;
    while (p && p !== root) {
        if (p.tagName && p.tagName.toLowerCase() === 'a') return true;
        p = p.parentNode;
    }
    return false;
}

function collectTextNodes(root, doc) {
    const walker = doc.createTreeWalker(root, /* NodeFilter.SHOW_TEXT */ 4);
    const out = [];
    let n = walker.nextNode();
    while (n) {
        if (!isInsideAnchor(n, root)) out.push(n);
        n = walker.nextNode();
    }
    return out;
}

function linkifyTextNodes(root, doc) {
    for (const textNode of collectTextNodes(root, doc)) {
        const text = textNode.nodeValue;
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
        textNode.parentNode.replaceChild(frag, textNode);
    }
}

export function sanitizeWelcomeMessage(input) {
    if (input == null) return '';
    const str = String(input);
    if (str.length === 0) return '';

    try {
        if (str.indexOf('<') === -1 && str.indexOf('&') === -1) {
            const doc = new DOMParser().parseFromString('<div></div>', 'text/html');
            const wrap = doc.body.firstChild;
            wrap.appendChild(doc.createTextNode(str));
            linkifyTextNodes(wrap, doc);
            return wrap.innerHTML;
        }

        const doc = new DOMParser().parseFromString('<div>' + str + '</div>', 'text/html');
        const wrap = doc.body.firstChild;
        walk(wrap);
        linkifyTextNodes(wrap, doc);
        return wrap.innerHTML;
    } catch {
        return escapeText(str.replace(/<[^>]+>/g, ''));
    }
}
