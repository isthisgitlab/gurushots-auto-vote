/**
 * Jest transformer: @swc/jest, with swc's generated export getters kept out of
 * coverage.
 *
 * swc compiles `export { a, b }` to CommonJS as getter functions on `exports`,
 * and Jest instruments that compiled output rather than the source. So every
 * export would count as a statement that is "covered" only if something reads
 * it, although the source line holds no runtime code. The two shapes swc emits
 * at the top level — `_export(exports, { get a() {…} })` for several exports and
 * `Object.defineProperty(exports, "a", { get … })` for one — get an
 * `istanbul ignore next`, which leaves the `__esModule` marker and all real
 * code instrumented as before.
 */
// CommonJS TypeScript that Node strips natively: Jest loads a transformer by
// path before any transform runs, so this file cannot rely on one.
const crypto: typeof import('node:crypto') = require('node:crypto');
const fs: typeof import('node:fs') = require('node:fs');
const swcJest: typeof import('@swc/jest') = require('@swc/jest');

// Jest's Sync | Async transformer union; @swc/jest returns the synchronous one,
// with processAsync and getCacheKey implemented too.
type SwcTransformer = Extract<ReturnType<typeof swcJest.createTransformer>, { process: unknown }>;

const IGNORE = '/* istanbul ignore next */ ';
const EXPORT_GETTERS = /^(?=_export\(exports, \{|Object\.defineProperty\(exports, "(?!__esModule")[^"]+", \{)/gm;
// Only swc's compiled ES modules carry this marker, so a hand-written CommonJS
// module keeps every top-level statement instrumented.
const ESM_MARKER = 'Object.defineProperty(exports, "__esModule"';
// Jest keys its transform cache on getCacheKey alone; folding this file's own
// source in makes an edit here invalidate what it cached before.
const SELF_HASH = crypto.createHash('sha1').update(fs.readFileSync(__filename)).digest('hex');

const ignoreExportGetters = (code: string): string =>
    code.includes(ESM_MARKER) ? code.replace(EXPORT_GETTERS, IGNORE) : code;

const withIgnoredGetters = <R extends { code: string }>(result: R | string): R =>
    (typeof result === 'string'
        ? ignoreExportGetters(result)
        : { ...result, code: ignoreExportGetters(result.code) }) as R;

module.exports = {
    createTransformer(config: Parameters<typeof swcJest.createTransformer>[0]): SwcTransformer {
        const transformer = swcJest.createTransformer(config) as SwcTransformer;
        return {
            ...transformer,
            process: (...args: Parameters<SwcTransformer['process']>) =>
                withIgnoredGetters(transformer.process(...args)),
            processAsync: async (...args: Parameters<Required<SwcTransformer>['processAsync']>) =>
                withIgnoredGetters(await transformer.processAsync!(...args)),
            getCacheKey: (...args: Parameters<Required<SwcTransformer>['getCacheKey']>) =>
                `${transformer.getCacheKey!(...args)}:${SELF_HASH}`,
        };
    },
};
