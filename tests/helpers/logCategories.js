/**
 * The categories whose category logger received `method(...args)`.
 *
 * Relies on the global logger mock in tests/setup.js, where every
 * withCategory() call returns fresh jest.fn() methods, so each call's result
 * can be matched back to the category it was created for. Pins which category
 * a line was actually routed through (a category passed as an extra argument
 * to a category logger method is silently dropped).
 */
const logCategories = (method, ...args) => {
    const logger = require('../../src/js/logger');
    return logger.withCategory.mock.calls
        .filter((_call, i) =>
            logger.withCategory.mock.results[i].value[method].mock.calls.some(
                (call) => JSON.stringify(call) === JSON.stringify(args),
            ),
        )
        .map(([category]) => category);
};

module.exports = { logCategories };
