/**
 * The runtime half of the load-time-chain guard (the metafile walk in
 * tests/ci-validation.test.ts is the static half). The metafile walk reads
 * esbuild's import-statement edges, so a module-scope require of the logger
 * passes it, and it greps for logger modules only — not for anything else
 * that reads platform() at load. This test runs the load itself: with the
 * port slot cleared and the logger entry mocked with a recording factory,
 * each shell platform module must install without throwing (nothing in its
 * load chain read platform() first) and without loading the logger. The
 * failures name the entry.
 */

import { clearInstalledPlatform } from '../helpers/platform';

const SHELL_PLATFORM_ENTRIES = [
    'src/ts/index/platform.ts',
    'src/ts/cli/platform.ts',
    'src/ts/web/platform.ts',
    'src/ts/bridge/capacitorPlatform.ts',
    'src/ts/headless/platform.ts',
    'scripts/lib/platform.ts',
] as const;

/** The tests/'-relative specifier of one entry, as this file requires it. */
const requirePathOf = (entry: string): string => `../../${entry.replace(/\.ts$/, '')}`;

describe('the shell platform modules load with the port clear and the logger mocked', () => {
    test('each installs, throws to nobody, and never loads the logger', () => {
        const failures: string[] = [];
        for (const entry of SHELL_PLATFORM_ENTRIES) {
            let loggerLoaded = false;
            let threw: string | null = null;
            jest.isolateModules(() => {
                clearInstalledPlatform();
                jest.doMock('../../src/ts/logger', () => {
                    loggerLoaded = true;
                    const cat = {
                        debug: () => undefined,
                        info: () => undefined,
                        warning: () => undefined,
                        error: () => undefined,
                        success: () => undefined,
                    };
                    return {
                        __esModule: true,
                        withCategory: () => cat,
                        challengeTag: (c: { id?: unknown } | null | undefined) => `[${String(c?.id)}]`,
                    };
                });
                try {
                    // The scripts entry sits outside the jest roots, which
                    // the sandboxed require cannot leave: requireActual
                    // resolves it (ci-validation does the same for
                    // build-react) and its dependencies still resolve
                    // through this isolate's mocks.
                    if (entry.startsWith('scripts/')) jest.requireActual(requirePathOf(entry));
                    else require(requirePathOf(entry));
                } catch (error) {
                    threw = error instanceof Error ? error.message : String(error);
                }
            });
            if (threw !== null) failures.push(`${entry} threw at load: ${threw}`);
            if (loggerLoaded) failures.push(`${entry} loaded the logger at module scope`);
        }
        expect(failures).toEqual([]);
    });
});
