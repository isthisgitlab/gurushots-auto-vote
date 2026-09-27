/**
 * Absolute paths to the app's own files (HTML pages, the preload bundle,
 * assets, the dev model cache), resolved from the app root — the directory
 * holding package.json.
 *
 * Build such a path here, never from a module's own `__dirname`: the Electron
 * main process runs from an esbuild bundle, where every bundled module shares
 * the bundle file's `__dirname`. That bundle is emitted at out/main/app.js,
 * the same depth below the app root as this file (src/js/appPaths.js), so
 * `__dirname/../..` is the root either way.
 *
 * `node:path` is required on call: the WebView bundles pull in callers of this
 * module but never take a code path that needs a filesystem path.
 */

/**
 * @param segments - path below the app root
 */
const appPath = (...segments: string[]): string => require('node:path').join(__dirname, '..', '..', ...segments);

export { appPath };
