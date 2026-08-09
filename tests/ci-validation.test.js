/**
 * CI Validation Tests
 *
 * These tests verify that the CI environment and configurations are working correctly.
 */

describe('CI Environment Validation', () => {
    test('Node.js version satisfies the engines requirement (>=26)', () => {
        // Keep in sync with package.json "engines" and .nvmrc — this is the
        // project's own floor, not Jest's broader support matrix.
        const majorVersion = parseInt(process.version.slice(1).split('.')[0], 10);

        expect(majorVersion).toBeGreaterThanOrEqual(26);
    });

    test('all required test dependencies should be available', () => {
        // Test that Jest and related packages can be imported
        expect(() => require('jest')).not.toThrow();
        expect(() => require('@jest/globals')).not.toThrow();
        expect(() => require('jest-environment-node')).not.toThrow();
    });

    test('test environment is node with NODE_ENV=test', () => {
        // Jest sets NODE_ENV=test when nothing else did — assert the actual
        // value (the old `|| 'test'` fallback could never fail).
        expect(process.env.NODE_ENV).toBe('test');
        expect(typeof process.versions.node).toBe('string');
    });
});
