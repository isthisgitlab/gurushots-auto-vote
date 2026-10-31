/**
 * Oxlint JS plugin: reports an import that crosses a layer boundary.
 *
 * `no-cross-layer-import` — the app is a layer cake: `core` is shared by everything, `platform:<x>` isolates one
 * runtime (Node, the WebView), `react` is the renderer tree, and `shell:<x>` is one entry point (Electron, CLI, web,
 * Capacitor, the Android headless service). A layer reaches itself and the layers under it, never a sibling shell;
 * and the packages that belong to one runtime (`electron`, `@capacitor/*`, …) may only be imported where that
 * runtime runs. The table below is the one place a boundary is written — a layering phase moves a file by editing
 * it there — and counts these warnings as its exit gate.
 *
 * A type-only declaration is skipped only when the build erases it whole — `import type …`, `export type … from`,
 * `export type * from`: those carry no runtime edge. An inline `type` inside the braces is not erased: with
 * `verbatimModuleSyntax`, `import { type A } from 'm'` keeps the statement (`import {} from 'm'`), which still loads
 * `m` at runtime — so it is checked like any runtime edge. The rule reads
 * `context.filename`, so it knows the layer of the file it is linting without touching the file system.
 *
 * Loaded through `jsPlugins` in .oxlintrc.json; the rule API is ESLint's.
 */

// The slice of the ESTree AST this rule reads. `callee` and `arguments` are the fields of the calls it visits,
// which both parsers Oxlint and Prettier always hand over as present;
// `source` is present on an import and `null` on an export of a local declaration.
interface Node {
    type: string;
    name?: string;
    value?: unknown;
    importKind?: string;
    exportKind?: string;
    source?: Node | null;
    callee: Node;
    arguments: Node[];
}
interface RuleContext {
    // The absolute path of the file being linted (Oxlint sets it on the context of a JS-plugin rule).
    filename: string;
    report(descriptor: { node: Node; message: string }): void;
}

// The layer table: the first row whose target matches the file's path, read from `src/ts/` on, names the file's
// layer; no match means `core`. A target ending in `/` is a directory row — it matches the directory itself and
// everything under it, the trailing slash keeping `src/ts/cliX/` out of `src/ts/cli/` — and a `<x>` in its layer
// takes the path segment after the prefix (`src/ts/platforms/node/store.ts` is `platform:node`); a file directly
// inside the directory has no segment, so `<x>` becomes the empty one (`src/ts/platforms/index.ts` is
// `platform:`). A file row also matches without its `.ts`/`.tsx` extension, the way an extensionless import
// specifier resolves.
export const LAYER_TABLE: ReadonlyArray<{ target: string; layer: string }> = [
    { target: 'src/ts/core/', layer: 'core' },
    // `src/ts/platform/` (singular) is the core port and has no row, so it is `core`; `src/ts/platforms/<x>/`
    // (plural) holds one platform's implementation.
    { target: 'src/ts/platforms/', layer: 'platform:<x>' },
    { target: 'src/ts/shells/', layer: 'shell:<x>' },
    // The Electron shell: the main process, its windows and their preloads.
    { target: 'src/ts/index.ts', layer: 'shell:electron' },
    { target: 'src/ts/index/', layer: 'shell:electron' },
    { target: 'src/ts/ui/', layer: 'shell:electron' },
    { target: 'src/ts/preload.ts', layer: 'shell:electron' },
    { target: 'src/ts/preloadLogs.ts', layer: 'shell:electron' },
    { target: 'src/ts/preloadApi.ts', layer: 'shell:electron' },
    { target: 'src/ts/appFileUrl.ts', layer: 'shell:electron' },
    { target: 'src/ts/windows/lifecycle.ts', layer: 'shell:electron' },
    { target: 'src/ts/windows/backgroundActivity.ts', layer: 'shell:electron' },
    { target: 'src/ts/windows/settingsWatcher.ts', layer: 'shell:electron' },
    { target: 'src/ts/windows/quitGuard.ts', layer: 'shell:electron' },
    { target: 'src/ts/services/AutoUpdater.ts', layer: 'shell:electron' },
    { target: 'src/ts/ipc/misc.handlers.ts', layer: 'shell:electron' },
    { target: 'src/ts/ipc/update.handlers.ts', layer: 'shell:electron' },
    { target: 'src/ts/ipc/registerHandlers.ts', layer: 'shell:electron' },
    { target: 'src/ts/ipc/registerIpc.ts', layer: 'shell:electron' },
    // The CLI shell: the command-line entry point and its Node-only edges.
    { target: 'src/ts/cli/', layer: 'shell:cli' },
    { target: 'src/ts/scheduling/runScheduler.ts', layer: 'shell:cli' },
    { target: 'src/ts/services/notify/nodeNotify.ts', layer: 'shell:cli' },
    { target: 'src/ts/services/visionCliAssets.ts', layer: 'shell:cli' },
    // The web shell: the localhost server and its bridge.
    { target: 'src/ts/web/', layer: 'shell:web' },
    { target: 'src/ts/bridge/web.ts', layer: 'shell:web' },
    { target: 'src/ts/react/pages/Web.tsx', layer: 'shell:web' },
    // The Capacitor (Android) shell.
    { target: 'src/ts/bridge/capacitor.ts', layer: 'shell:capacitor' },
    { target: 'src/ts/bridge/capacitorPlatform.ts', layer: 'shell:capacitor' },
    { target: 'src/ts/localStores.ts', layer: 'shell:capacitor' },
    { target: 'src/ts/react/pages/Capacitor.tsx', layer: 'shell:capacitor' },
    { target: 'src/ts/services/AndroidUpdateInstaller.ts', layer: 'shell:capacitor' },
    { target: 'src/ts/services/ForegroundServiceController.ts', layer: 'shell:capacitor' },
    { target: 'src/ts/services/NativeAutovoteBridge.ts', layer: 'shell:capacitor' },
    { target: 'src/ts/bridge/capacitorBackgroundHost.ts', layer: 'shell:capacitor' },
    { target: 'src/ts/bridge/capacitorPresence.ts', layer: 'shell:capacitor' },
    // The Android headless background service.
    { target: 'src/ts/headless/', layer: 'shell:headless' },
    // Platforms: one runtime each, below every shell.
    { target: 'src/ts/appPaths.ts', layer: 'platform:node' },
    { target: 'src/ts/settings/cliSessionLock.ts', layer: 'platform:node' },
    // The renderer tree, below every shell, above core.
    { target: 'src/ts/react/', layer: 'react' },
];

// The part of a path from `src/ts/` on, `\` normalized to `/`: null when the path does not name an app file. The
// cut is the last `src/ts/` in the path, so a checkout sitting under a parent path that itself contains `src/ts/`
// still classifies by the repository's own `src/ts/`; a relative filename that starts with `src/ts/` cuts at 0.
const underSrcTs = (filename: string): string | null => {
    const path = filename.replaceAll('\\', '/');
    const at = path.lastIndexOf('src/ts/');
    return at === -1 ? null : path.slice(at);
};

// The layer of a path that `underSrcTs` has cut at `src/ts/`: the first matching table row, else `core`.
const layerOfCut = (path: string): string => {
    for (const { target, layer } of LAYER_TABLE) {
        if (target.endsWith('/')) {
            if (path !== target.slice(0, -1) && !path.startsWith(target)) continue;
            if (!layer.includes('<x>')) return layer;
            // A file directly inside the pattern directory ends in `.ts`/`.tsx` and has no segment after the
            // prefix, so `<x>` becomes the empty one (`src/ts/platforms/index.ts` is `platform:`); a remainder
            // without a `/` that lacks the extension is an extensionless directory name, taken as the segment
            // itself (`src/ts/platforms/node` is `platform:node`). The rule cannot read the file system, so an
            // extensionless import of a file that sits directly in the directory (`'../index'`) cannot be told
            // apart and reads as a directory. A file in the empty layer gets no named platform or shell of its
            // own, so the normal rules apply to the empty layer — an import between `platform:` and
            // `platform:node` is reported, because they are different platforms.
            const rest = path.slice(target.length);
            if (rest.includes('/')) return layer.replace('<x>', () => rest.split('/')[0]);
            return layer.replace('<x>', () => (rest.endsWith('.ts') || rest.endsWith('.tsx') ? '' : rest));
        }
        if (path === target || path === target.replace(/\.tsx?$/, '')) return layer;
    }
    return 'core';
};

// The layer of an import target: null when the path leaves `src/ts/`, where no row of the table governs it.
const layerOfTarget = (path: string): string | null => (path.startsWith('src/ts/') ? layerOfCut(path) : null);

// A relative specifier resolves against the importing file's directory with plain segment logic: the rule runs
// inside Oxlint, where it can neither read the file system nor import `node:path`.
const resolveRelative = (from: string, specifier: string): string => {
    const out: string[] = [];
    for (const segment of `${from.slice(0, from.lastIndexOf('/') + 1)}${specifier}`.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') out.pop();
        else out.push(segment);
    }
    return out.join('/');
};

// Packages that belong to one runtime: importing one from anywhere that runtime does not run is a boundary
// crossing in itself. Every other package specifier is shared ground.
const isForbiddenPackage = (specifier: string): boolean =>
    specifier === 'electron' ||
    specifier.startsWith('electron-') ||
    specifier.startsWith('@capacitor/') ||
    specifier.startsWith('@capawesome-team/');

// The boundary rules: a layer reaches itself and the layers under it. A forbidden package is its own target
// class: only where its runtime runs — a platform or a shell — may it be imported.
const mayImport = (from: string, to: string): boolean => {
    if (to === 'forbidden-package') return from.startsWith('platform:') || from.startsWith('shell:');
    if (from === to) return true;
    if (from === 'react') return to === 'core';
    if (from.startsWith('platform:')) return to === 'core';
    if (from.startsWith('shell:')) return to === 'core' || to === 'react' || to.startsWith('platform:');
    return false;
};

const noCrossLayerImport = {
    meta: {
        type: 'problem',
        docs: { description: 'Report an import that crosses a layer boundary' },
    },
    // The visitors keyed by the node type they read, or an empty set for a file outside `src/ts/`.
    create(context: RuleContext): Record<string, (node: Node) => void> {
        // A file outside `src/ts/` has no layer: nothing of its imports is a crossing.
        const from = underSrcTs(context.filename);
        if (from === null) return {};
        const fromLayer = layerOfCut(from);
        const check = (specifier: Node | null | undefined): void => {
            if (specifier == null || specifier.type !== 'Literal' || typeof specifier.value !== 'string') return;
            const text = specifier.value;
            // A relative specifier names a file of this app, and so does the renderer alias `@/`, which tsconfig
            // maps to `src/ts/react/*`; anything else is a package specifier.
            const to =
                text.startsWith('./') || text.startsWith('../')
                    ? layerOfTarget(resolveRelative(from, text))
                    : text.startsWith('@/')
                      ? layerOfTarget(`src/ts/react/${text.slice(2)}`)
                      : isForbiddenPackage(text)
                        ? 'forbidden-package'
                        : null;
            // Outside `src/ts/` (an asset in a parent directory), or an allowed package: no boundary to cross.
            if (to === null || mayImport(fromLayer, to)) return;
            context.report({ node: specifier, message: `layer-boundaries: ${fromLayer} → ${to} (${text})` });
        };
        return {
            ImportDeclaration(node: Node) {
                // `import type …` is erased by the build whole. An inline `type` in the braces is not: with
                // `verbatimModuleSyntax` the statement stays as `import {} from 'm'`, a runtime edge like any
                // other import.
                if (node.importKind === 'type') return;
                check(node.source);
            },
            ExportNamedDeclaration(node: Node) {
                // `export type … from` is erased by the build whole; an inline `type` in the braces is not.
                if (node.exportKind === 'type') return;
                check(node.source);
            },
            ExportAllDeclaration(node: Node) {
                // `export type * from` is erased by the build like any type-only export.
                if (node.exportKind === 'type') return;
                check(node.source);
            },
            ImportExpression(node: Node) {
                check(node.source);
            },
            CallExpression(node: Node) {
                // `require('…')`: exactly one argument, and that argument a string literal.
                if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
                if (node.arguments.length !== 1) return;
                check(node.arguments[0]);
            },
        };
    },
};

export default {
    meta: { name: 'layer-boundaries' },
    rules: { 'no-cross-layer-import': noCrossLayerImport },
};
