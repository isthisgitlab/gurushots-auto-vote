/**
 * The legacy dev-dir notice fires at the settings-path resolution
 * (userDataPaths.getSettingsPath), after the real logger has loaded — a
 * userData()-time call ran while the logger loaded and re-entered it
 * half-loaded, so the TypeError was swallowed and the notice lost. Each case
 * runs a fresh module graph: the one-shot flag lives in the node family's
 * paths module, and the real logger is loaded against the installed platform
 * before the settings path is resolved, exactly the order the notice
 * depends on.
 */

// The real logger is the point of this test: the setup file's logger mock
// would answer the notice with a silent jest.fn.
jest.unmock('../../src/ts/logger');

describe('the legacy dev-dir notice at the settings-path resolution', () => {
    const LEGACY_FILE = '/apps/gurushots-auto-vote-dev/settings.json';

    const resolveAfterLoggerLoaded = async (legacyExists: boolean): Promise<string[]> => {
        const lines: string[] = [];
        const logSpy = jest
            .spyOn(console, 'log')
            .mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(' ')));
        try {
            await jest.isolateModulesAsync(async () => {
                // The version flag is what the family's Electron check reads;
                // the electron module it gates on answers this registry's mock.
                (process.versions as { electron?: string }).electron = '43.0.0';
                jest.doMock('electron', () => ({
                    app: { isPackaged: false, getPath: () => '/apps/Electron' },
                }));
                const fs = jest.mocked(require('node:fs') as typeof import('node:fs'));
                fs.existsSync.mockImplementation((p: unknown) => legacyExists && p === LEGACY_FILE);
                // The setup's path mock answers stubs: the notice joins and
                // dirnames real legacy paths, so it gets the real ones here.
                const path = jest.mocked(require('node:path') as typeof import('node:path'));
                const actualPath = jest.requireActual<typeof import('node:path')>('node:path');
                path.join.mockImplementation(actualPath.join);
                path.dirname.mockImplementation(actualPath.dirname);
                // The real logger loads first, against the installed platform.
                require('../../src/ts/logger');
                const helpers = require('../helpers/platform') as typeof import('../helpers/platform');
                helpers.installTestPlatform();
                const { getSettingsPath } =
                    require('../../src/ts/settings/userDataPaths') as typeof import('../../src/ts/settings/userDataPaths');
                getSettingsPath();
            });
        } finally {
            logSpy.mockRestore();
            delete (process.versions as { electron?: string }).electron;
        }
        return lines;
    };

    test('the real logger carries the notice when a legacy settings.json exists elsewhere', async () => {
        const lines = await resolveAfterLoggerLoaded(true);
        expect(lines.some((line) => line.includes('Dev settings found at /apps/gurushots-auto-vote-dev'))).toBe(true);
    });

    test('it stays silent when no legacy settings.json exists', async () => {
        const lines = await resolveAfterLoggerLoaded(false);
        expect(lines.some((line) => line.includes('Dev settings found'))).toBe(false);
    });
});
