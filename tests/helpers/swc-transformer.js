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
const crypto = require('node:crypto');
const fs = require('node:fs');
const swcJest = require('@swc/jest');

const IGNORE = '/* istanbul ignore next */ ';
const EXPORT_GETTERS = /^(?=_export\(exports, \{|Object\.defineProperty\(exports, "(?!__esModule")[^"]+", \{)/gm;
// Only swc's compiled ES modules carry this marker, so hand-written CommonJS
// (scripts/) keeps every top-level statement instrumented.
const ESM_MARKER = 'Object.defineProperty(exports, "__esModule"';
// Jest keys its transform cache on getCacheKey alone; folding this file's own
// source in makes an edit here invalidate what it cached before.
const SELF_HASH = crypto.createHash('sha1').update(fs.readFileSync(__filename)).digest('hex');

/** @param {string} code */
const ignoreExportGetters = (code) => (code.includes(ESM_MARKER) ? code.replace(EXPORT_GETTERS, IGNORE) : code);

/** @param {string | { code: string }} result */
const withIgnoredGetters = (result) =>
    typeof result === 'string' ? ignoreExportGetters(result) : { ...result, code: ignoreExportGetters(result.code) };

module.exports = {
    createTransformer(config) {
        const transformer = swcJest.createTransformer(config);
        return {
            ...transformer,
            process: (...args) => withIgnoredGetters(transformer.process(...args)),
            processAsync: async (...args) => withIgnoredGetters(await transformer.processAsync(...args)),
            getCacheKey: (...args) => `${transformer.getCacheKey(...args)}:${SELF_HASH}`,
        };
    },
};
