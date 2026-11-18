/**
 * The registered autovote control the installation scenario's actions reach (src/ts/core/autovote/control.ts).
 */

import { currentAutovoteControl, registerAutovoteControl } from '../../src/ts/core/autovote/control';
import type { AutovoteControl } from '../../src/ts/core/autovote/control';

const control = (): AutovoteControl => ({
    capture: () => ({ epoch: 1, generation: 0 }),
    admits: async () => true,
    request: async () => ({ ok: true, mode: 'voting', changed: true }),
});

afterEach(() => {
    // Leave nothing registered for the next test.
    registerAutovoteControl(control())();
});

test('nothing is registered until a host registers one, and the unregister function removes it', () => {
    expect(currentAutovoteControl()).toBeNull();
    const mine = control();
    const unregister = registerAutovoteControl(mine);
    expect(currentAutovoteControl()).toBe(mine);
    unregister();
    expect(currentAutovoteControl()).toBeNull();
});

test('an unregister that is not the current registration leaves the current one in place', () => {
    const first = control();
    const second = control();
    const unregisterFirst = registerAutovoteControl(first);
    registerAutovoteControl(second);
    unregisterFirst();
    expect(currentAutovoteControl()).toBe(second);
});
