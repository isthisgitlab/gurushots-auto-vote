import { invalid } from '../helpers/invalid';
import type * as run_if_mainModule from '../../scripts/lib/run-if-main';
const { runIfMain } = require('../../scripts/lib/run-if-main') as typeof run_if_mainModule;

describe('runIfMain', () => {
    test('runs only when the module is the entry point', () => {
        const run = jest.fn();
        const mod = invalid<NodeJS.Module>({});

        expect(runIfMain(invalid({}), mod, run)).toBe(false);
        expect(run).not.toHaveBeenCalled();

        runIfMain(mod, mod, run);
        expect(run).toHaveBeenCalledTimes(1);
    });
});
