/**
 * The shared Capacitor presence check (bridge/capacitorPresence): the global
 * is here and its platform probe is a function — the probe is never called,
 * so a Capacitor web target counts as present, as the runtime.isCapacitor()
 * check this replaced did. Each Capacitor shell module reads this one check.
 */

import type { CapacitorGlobals } from '../../src/ts/types/capacitor';

const g = globalThis as CapacitorGlobals;

describe('isCapacitorNative', () => {
    let saved: CapacitorGlobals['Capacitor'];

    beforeEach(() => {
        saved = g.Capacitor;
    });

    afterEach(() => {
        g.Capacitor = saved;
    });

    test('answers true when the global carries a platform probe, without calling the probe', () => {
        const probe = jest.fn(() => false);
        g.Capacitor = { isNativePlatform: probe };
        const { isCapacitorNative } =
            require('../../src/ts/bridge/capacitorPresence') as typeof import('../../src/ts/bridge/capacitorPresence');
        expect(isCapacitorNative()).toBe(true);
        expect(probe).not.toHaveBeenCalled();
    });

    test('answers false when the global is absent', () => {
        delete g.Capacitor;
        const { isCapacitorNative } =
            require('../../src/ts/bridge/capacitorPresence') as typeof import('../../src/ts/bridge/capacitorPresence');
        expect(isCapacitorNative()).toBe(false);
    });

    test('answers false when the global carries no platform probe', () => {
        g.Capacitor = {};
        const { isCapacitorNative } =
            require('../../src/ts/bridge/capacitorPresence') as typeof import('../../src/ts/bridge/capacitorPresence');
        expect(isCapacitorNative()).toBe(false);
    });
});
