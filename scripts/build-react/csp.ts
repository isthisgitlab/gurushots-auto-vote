// The Content-Security-Policies the generated documents carry.

import { NOSTR_RELAY_URLS } from '../../src/ts/core/remote/relays';

// Every remote image the renderer draws comes from the photo CDN (format/photoUrl.ts);
// no API-supplied avatar or cover URL is ever put in an <img>.
const PHOTO_HOST = 'https://photos.gurushots.com';
const GITHUB_API_HOST = 'https://api.github.com';

type CspDirectives = Record<string, string[]>;

const serializeCsp = (directives: CspDirectives) =>
    Object.entries(directives)
        .map(([name, sources]) => [name, ...sources].join(' '))
        .join('; ');

// The policy every document starts from. script-src 'self' (no 'unsafe-inline', no
// 'unsafe-eval') is the load-bearing line; style-src keeps 'unsafe-inline' for DaisyUI and
// inline element styles.
const baseCsp = (overrides: CspDirectives = {}): string =>
    serializeCsp({
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', PHOTO_HOST],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'none'"],
        ...overrides,
    });

// The two Android documents run the local vision model: onnxruntime-web compiles WebAssembly
// ('wasm-unsafe-eval' allows that without 'unsafe-eval'), the classifier fetches candidate
// photos from the photo CDN, and the update check reads the GitHub releases API.
const androidCsp = baseCsp({
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'connect-src': ["'self'", GITHUB_API_HOST, PHOTO_HOST],
});

// The remote page documents (the phone page and the loader): the pairing runs WebRTC signalling
// straight from the page, so connect-src carries exactly the pinned Nostr relays — the same list
// core/remote/relays.ts joins the room with. Everything else stays as strict as the desktop pages.
const remoteCsp = baseCsp({
    'connect-src': ["'self'", ...NOSTR_RELAY_URLS],
});

export { PHOTO_HOST, baseCsp, androidCsp, remoteCsp };
