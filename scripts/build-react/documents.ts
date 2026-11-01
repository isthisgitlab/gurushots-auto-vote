// The renderer HTML documents dist/ is staged with: the shared document head
// (viewport, CSP, styles, deferred bundle) and the Capacitor, web, remote,
// remote-loader and headless documents built from it.

import { androidCsp, baseCsp, remoteCsp } from './csp';

type RendererDocument = {
    htmlAttrs: string;
    viewport: string;
    csp: string;
    bundle: string;
    themeColor?: string;
};

// A renderer page: the document head (viewport, CSP, styles, deferred bundle) and the safe-area-padded #root body.
const rendererHtml = ({ htmlAttrs, viewport, csp, bundle, themeColor }: RendererDocument): string =>
    `<!doctype html>
<html ${htmlAttrs}>
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="${viewport}" />${themeColor ? `\n        <meta name="theme-color" content="${themeColor}" />` : ''}
        <meta http-equiv="Content-Security-Policy" content="${csp}" />
        <title>GuruShots Auto Vote</title>
        <link href="styles.css" rel="stylesheet" />
        <script defer src="${bundle}"></script>
    </head>
    <body class="min-h-screen bg-base-200 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
        <div id="root"></div>
    </body>
</html>
`;

// Capacitor entry point. Capacitor copies dist/ wholesale into the
// Android WebView's web assets and loads index.html at app start.
// Electron loads its own src/html/*.html directly via loadFile() and
// ignores this index.html, so emitting it does not affect desktop.
// The bundle loaded here is capacitor-bundle.js, NOT app-bundle.js,
// so the bridge can install before React mounts.
const capacitorIndexHtml = rendererHtml({
    htmlAttrs: 'lang="en"',
    viewport: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
    themeColor: '#960018',
    csp: androidCsp,
    bundle: 'capacitor-bundle.js',
});

// Web shell document, served at / by src/ts/shells/web/server.ts. Same CSP as the
// Electron pages: script-src 'self' keeps injected inline script from running
// against the window.api surface.
const webHtml = rendererHtml({
    htmlAttrs: 'data-theme="light" lang="en"',
    viewport: 'width=device-width, initial-scale=1.0',
    csp: baseCsp(),
    bundle: 'web-bundle.js',
});

// Remote phone page document (dist/remote.html; the Pages build and the Android webDir
// carry it under remote/<version>/ as index.html). viewport-fit=cover like the Android
// page: it runs in phone browsers with display cutouts.
const remoteHtml = rendererHtml({
    htmlAttrs: 'data-theme="light" lang="en"',
    viewport: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
    themeColor: '#960018',
    csp: remoteCsp,
    bundle: 'remote-bundle.js',
});

// The /remote/ loader document (dist/remote-loader.html; the site build puts it at
// remote/index.html).
const remoteLoaderHtml = rendererHtml({
    htmlAttrs: 'data-theme="light" lang="en"',
    viewport: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
    themeColor: '#960018',
    csp: remoteCsp,
    bundle: 'remoteLoader-bundle.js',
});

// Headless background document. Loaded by AutoVoteService in a bare
// WebView (no Capacitor). headless-flag.js sets the service marker before
// the bundle executes, whose first import is the shell's platform module —
// it routes the settings and HTTP layers through the native bridges — then
// the bundle installs window.GS.runOneCycle() for the service to call.
const HEADLESS_FLAG_FILE = 'headless-flag.js';
const HEADLESS_FLAG_SOURCE = 'window.__GS_HEADLESS__ = true;\n';
const headlessHtml = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="${androidCsp}" />
        <title>GuruShots Auto Vote — background</title>
        <script src="${HEADLESS_FLAG_FILE}"></script>
        <script defer src="headless-bundle.js"></script>
    </head>
    <body></body>
</html>
`;

export {
    HEADLESS_FLAG_FILE,
    HEADLESS_FLAG_SOURCE,
    capacitorIndexHtml,
    headlessHtml,
    webHtml,
    remoteHtml,
    remoteLoaderHtml,
};
