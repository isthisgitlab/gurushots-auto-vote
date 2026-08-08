/**
 * Tests for src/js/voting/cancellation.js
 *
 * The point of the cancellation module is to be a single source of
 * truth that all callers (real-api, mock, IPC) share. These tests
 * prove that:
 *   1) the flag round-trips correctly,
 *   2) reset() returns it to false.
 * (All callers now use this module directly — the api/main and mock
 * setCancellationFlag delegates were removed as dead code.)
 */

const cancellation = require('../../src/js/voting/cancellation');

describe('voting/cancellation', () => {
    beforeEach(() => {
        cancellation.reset();
    });

    it('starts uncancelled', () => {
        expect(cancellation.isCancelled()).toBe(false);
    });

    it('round-trips a true value', () => {
        cancellation.setCancelled(true);
        expect(cancellation.isCancelled()).toBe(true);
        cancellation.setCancelled(false);
        expect(cancellation.isCancelled()).toBe(false);
    });

    it('coerces truthy/falsy to booleans', () => {
        cancellation.setCancelled(1);
        expect(cancellation.isCancelled()).toBe(true);
        cancellation.setCancelled('');
        expect(cancellation.isCancelled()).toBe(false);
        cancellation.setCancelled('cancel');
        expect(cancellation.isCancelled()).toBe(true);
    });

    it('reset() forces false regardless of prior state', () => {
        cancellation.setCancelled(true);
        cancellation.reset();
        expect(cancellation.isCancelled()).toBe(false);
    });
});
