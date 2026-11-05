/**
 * The web shell's static files: the dist/ tree a URL path maps onto, served
 * to any local page — a static file authorizes nothing, so it needs no token.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ServerResponse } from 'node:http';

import { fail } from './responses';

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
};

// The dist/ file a URL path serves: the root is the web document, and the
// favicon browsers ask for by convention (no token travels with it) is the
// app icon staged next to it by scripts/build-react.ts.
const staticFileFor = (pathname: string) => {
    if (pathname === '/') return 'web.html';
    if (pathname === '/favicon.ico') return 'favicon.png';
    return decodeURIComponent(pathname).replace(/^\/+/, '');
};

const serveStatic = (distDir: string, pathname: string, res: ServerResponse) => {
    const file = path.resolve(distDir, staticFileFor(pathname));
    if (!file.startsWith(distDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        fail(res, 404, 'Not found');
        return;
    }
    res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res);
};

export { serveStatic };
