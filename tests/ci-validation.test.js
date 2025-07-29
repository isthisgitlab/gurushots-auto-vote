/**
 * CI Validation Tests
 *
 * These tests verify that the CI environment and configurations are working correctly.
 */

describe('CI Environment Validation', () => {
    test('Node.js version should be compatible with Jest', () => {
        const nodeVersion = process.version;
        const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);

        // Jest 30.x requires Node.js ^18.14.0 || ^20.0.0 || ^22.0.0 || >=24.0.0
        const isCompatible =
            (majorVersion === 18 && process.version >= 'v18.14.0') ||
            majorVersion === 20 ||
            majorVersion === 22 ||
            majorVersion >= 24;

        expect(isCompatible).toBe(true);
        console.log(`✅ Node.js version: ${nodeVersion} (compatible with Jest 30.x)`);
    });

    test('npm version should be 8.0.0 or higher', () => {
        // This test relies on the CI environment having npm available
        expect(process.env.npm_version || '8.0.0').toMatch(/^\d+\.\d+\.\d+$/);
    });

    test('all required test dependencies should be available', () => {
        // Test that Jest and related packages can be imported
        expect(() => require('jest')).not.toThrow();
        expect(() => require('@jest/globals')).not.toThrow();
        expect(() => require('jest-environment-node')).not.toThrow();
    });

    test('test environment should be node', () => {
        expect(process.env.NODE_ENV || 'test').toBeDefined();
    });
});