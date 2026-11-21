const packageManifest = require('../package.json') as typeof import('../package.json');
const nodeProject = packageManifest.jest.projects.find((project) => project.displayName === 'node');

module.exports = {
    packageManager: 'pnpm',
    testRunner: 'jest',
    plugins: ['@stryker-mutator/jest-runner'],
    mutate: ['src/ts/core/scheduling/thresholdWindow/thresholds.ts'],
    coverageAnalysis: 'perTest',
    concurrency: 1,
    // Limit sandbox copies to the pilot's source and tests.
    ignorePatterns: ['/**', '!/package.json', '!/src/**', '!/tests/**'],
    // Jest transpiles with SWC and does not use tsc.
    disableTypeChecks: false,
    tempDirName: '.cache/stryker',
    reporters: ['clear-text', 'html'],
    htmlReporter: { fileName: 'coverage/mutation.html' },
    jest: {
        configFile: 'package.json',
        config: {
            projects: [{ ...nodeProject, testMatch: ['<rootDir>/tests/scheduling/thresholdWindow.test.ts'] }],
        },
        enableFindRelatedTests: false,
    },
};
