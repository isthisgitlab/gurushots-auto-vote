/**
 * Tests for src/ts/voting/cancellation.ts
 *
 * The point of the cancellation module is to be a single source of
 * truth that all callers (real-api, mock, IPC) share. These tests
 * prove that:
 *   1) the flag round-trips correctly,
 *   2) reset() returns it to false.
 */

import cancellation = require('../../src/ts/voting/cancellation');

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

    it('reset() forces false regardless of prior state', () => {
        cancellation.setCancelled(true);
        cancellation.reset();
        expect(cancellation.isCancelled()).toBe(false);
    });
});
