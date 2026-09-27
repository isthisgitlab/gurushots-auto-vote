/**
 * The categories whose category logger received `method(...args)`.
 *
 * Relies on the global logger mock in tests/setup.ts, where every
 * withCategory() call returns fresh jest.fn() methods, so each call's result
 * can be matched back to the category it was created for. Pins which category
 * a line was actually routed through (a category passed as an extra argument
 * to a category logger method is silently dropped).
 */

import type * as loggerModule from '../../src/js/logger';
import type { CategoryLogger } from '../../src/js/logger';

const logCategories = (method: keyof CategoryLogger, ...args: unknown[]): string[] => {
    const logger = jest.mocked(require('../../src/js/logger') as typeof loggerModule);
    return logger.withCategory.mock.calls
        .filter((_call, i) => {
            const categoryLogger = logger.withCategory.mock.results[i].value as CategoryLogger;
            return jest
                .mocked(categoryLogger[method])
                .mock.calls.some((call: unknown[]) => JSON.stringify(call) === JSON.stringify(args));
        })
        .map(([category]) => category);
};

export { logCategories };
