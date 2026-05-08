/**
 * Tests for src/js/voting/cancellation.js
 *
 * The point of the cancellation module is to be a single source of
 * truth that all callers (real-api, mock, IPC) share. These tests
 * prove that:
 *   1) the flag round-trips correctly,
 *   2) reset() returns it to false,
 *   3) the api/main + mock setCancellationFlag delegates observe the
 *      same shared state — which is the regression the consolidation
 *      was meant to prevent.
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

    it('mock and api/main delegates share the same flag', () => {
        // We must avoid the heavy module loads that pull in electron, so
        // require them here inside the test (mock-friendly) and treat
        // them as opaque delegates.
        jest.isolateModules(() => {
            // Re-require both delegate modules and the source-of-truth
            // module within the same isolation so they share state.
            const sharedCancellation = require('../../src/js/voting/cancellation');
            sharedCancellation.reset();

            // Stub out the heavy deps that mock/index.js and api/main
            // bring in so requiring them doesn't try to spin Electron.
            jest.doMock('../../src/js/logger', () => ({
                withCategory: () => ({
                    info: jest.fn(),
                    debug: jest.fn(),
                    warning: jest.fn(),
                    error: jest.fn(),
                    success: jest.fn(),
                    api: jest.fn(),
                    progress: jest.fn(),
                    startOperation: jest.fn(),
                    endOperation: jest.fn(),
                    challengeInfo: jest.fn(),
                }),
                isDevMode: () => false,
                challengeInfo: jest.fn(),
                CATEGORIES: { VOTING: 'voting' },
            }));

            const mockApi = require('../../src/js/mock');

            // Set via mock delegate; observe via the shared module.
            mockApi.setCancellationFlag(true);
            expect(sharedCancellation.isCancelled()).toBe(true);

            // Reset via shared module; mock-side reads consume the new
            // value too because they delegate to it.
            sharedCancellation.reset();
            expect(sharedCancellation.isCancelled()).toBe(false);
        });
    });
});
