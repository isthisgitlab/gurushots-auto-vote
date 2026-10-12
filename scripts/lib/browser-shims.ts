/**
 * What the renderer bundles need to run in a browser-context WebView: the Node built-ins to leave unresolved, and the
 * banner that stubs the Node globals shared modules touch at load.
 */

// All renderer bundles run in a browser-context (Electron WebView
// or Capacitor WebView). They reach shared modules (runtime.ts,
// settings.ts, ForegroundServiceController, etc.) that lazy-require
// Node built-ins and electron — code paths the renderer never
// reaches at runtime (it goes through window.api / Capacitor.Plugins),
// but esbuild still tries to resolve at bundle time. Marking them
// external + emitting an inert require shim keeps every bundle
// green; the unreachable lazy requires become benign no-ops.
const NODE_BUILTINS_BARE = [
    'fs',
    'path',
    'os',
    'crypto',
    'stream',
    'events',
    'child_process',
    'http',
    'https',
    'url',
    'zlib',
    'util',
    'buffer',
    'assert',
    'net',
    'tls',
    'dns',
    'querystring',
    'string_decoder',
    'tty',
    'readline',
    'sea',
    'module',
];
// Externalize both bare and node:-prefixed forms — shared modules use the
// node: prefix (preferred since Node 22) but esbuild matches externals on
// exact specifier, so both spellings must be enumerated.
export const NODE_BUILTINS = [...NODE_BUILTINS_BARE, ...NODE_BUILTINS_BARE.map((m) => `node:${m}`)];
// Two browser-shim banners. require() is faked because external
// imports leave runtime require() calls that the WebView cannot
// resolve. process is faked because logger.ts / runtime.ts read
// process.type / process.versions / process.platform at module
// load (before any isCapacitor() guard runs); without a stub the
// bundle ReferenceErrors before React mounts.
// Browser shims for Node globals that the bundled code touches at
// module load before any isCapacitor() guard can run. The require
// shim returns module-aware stubs (fs/path/os) with the small
// surface area logger.ts / runtime.ts / settings.ts actually call —
// each method either no-ops or returns a sensible neutral value
// (false for existsSync, joined string for path.join, etc.) so
// module init does not throw. All real fs work lives behind
// runtime.isCapacitor() guards or try/catch wrappers, so these
// stub methods are never reached by the actual app code on
// Capacitor — they just keep module init green.
export const SHIM_BANNER = [
    'var __nodeModuleShims = {',
    '  fs: {',
    '    existsSync: function(){ return false; },',
    '    readFileSync: function(){ return ""; },',
    '    writeFileSync: function(){},',
    '    appendFileSync: function(){},',
    '    mkdirSync: function(){},',
    '    readdirSync: function(){ return []; },',
    '    statSync: function(){ return { size: 0, mtime: new Date() }; },',
    '    unlinkSync: function(){},',
    '    watch: function(){ return { close: function(){} }; }',
    '  },',
    '  path: {',
    '    join: function(){ return Array.prototype.join.call(arguments, "/"); },',
    '    resolve: function(){ return Array.prototype.join.call(arguments, "/"); },',
    '    dirname: function(p){ return String(p).split("/").slice(0,-1).join("/") || "/"; },',
    '    basename: function(p){ return String(p).split("/").pop(); },',
    '    extname: function(p){ var b = String(p).split("/").pop(); var i = b.lastIndexOf("."); return i < 0 ? "" : b.slice(i); },',
    '    sep: "/"',
    '  },',
    '  os: {',
    '    homedir: function(){ return "/"; },',
    '    platform: function(){ return "android"; },',
    '    tmpdir: function(){ return "/tmp"; }',
    '  }',
    '};',
    'var require = (typeof require !== "undefined") ? require : function(name){ return __nodeModuleShims[name.replace(/^node:/, "")] || {}; };',
    'var process = (typeof process !== "undefined") ? process : { env: {}, versions: {}, platform: "browser", type: "browser", pkg: undefined, argv: [], cwd: function(){ return "/"; }, on: function(){}, stdout: { isTTY: false, write: function(){} }, stderr: { isTTY: false, write: function(){} } };',
    'var __dirname = (typeof __dirname !== "undefined") ? __dirname : "/";',
    'var __filename = (typeof __filename !== "undefined") ? __filename : "/index.html";',
].join('');
