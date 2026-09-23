const { runIfMain } = require('../../scripts/lib/run-if-main.js');

describe('runIfMain', () => {
    test('runs only when the module is the entry point', () => {
        const run = jest.fn();
        const mod = {};

        expect(runIfMain({}, mod, run)).toBe(false);
        expect(run).not.toHaveBeenCalled();

        runIfMain(mod, mod, run);
        expect(run).toHaveBeenCalledTimes(1);
    });
});
