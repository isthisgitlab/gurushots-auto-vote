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
const swcJest = require('@swc/jest');

const IGNORE = '/* istanbul ignore next */ ';
const EXPORT_GETTERS = /^(?=_export\(exports, \{|Object\.defineProperty\(exports, "(?!__esModule")[^"]+", \{)/gm;

/** @param {string} code */
const ignoreExportGetters = (code) => code.replace(EXPORT_GETTERS, IGNORE);

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
            getCacheKey: (...args) => `${transformer.getCacheKey(...args)}:ignore-export-getters`,
        };
    },
};
