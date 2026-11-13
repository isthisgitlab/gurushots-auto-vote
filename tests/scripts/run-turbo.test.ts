import type { SpawnSyncReturns } from 'node:child_process';

jest.unmock('node:path');
jest.unmock('path');

const childProcess = {
    execFileSync: jest.fn<string, [string, string[], { encoding: BufferEncoding }]>(),
    spawnSync: jest.fn<SpawnSyncReturns<string>, [string, string[], { stdio: 'inherit' }]>(),
};
const fs = {
    mkdirSync: jest.fn<void, [string, { recursive: true }]>(),
    writeFileSync: jest.fn<void, [string, string]>(),
};

jest.mock('node:child_process', () => childProcess);
jest.mock('node:fs', () => fs);

import turbo = require('../../scripts/run-turbo');

const mockedChildProcess = childProcess;
const mockedFs = fs;
const spawnResult = (status: number | null, error?: Error): SpawnSyncReturns<string> => ({
    pid: 1,
    output: [null, '', ''],
    stdout: '',
    stderr: '',
    status,
    signal: null,
    ...(error ? { error } : {}),
});

describe('scripts/run-turbo.ts', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');

    const setPlatform = (value: NodeJS.Platform): void => {
        Object.defineProperty(process, 'platform', { configurable: true, value });
    };

    beforeEach(() => {
        mockedChildProcess.execFileSync.mockReturnValue('tool 1.0\n');
        mockedChildProcess.spawnSync.mockReturnValue(spawnResult(0));
    });

    afterEach(() => {
        if (platform) Object.defineProperty(process, 'platform', platform);
        jest.restoreAllMocks();
    });

    test('records exact runtime and native toolchain context', () => {
        setPlatform('darwin');
        turbo.writeBuildContext();

        expect(mockedFs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.turbo'), { recursive: true });
        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
            turbo.CONTEXT_PATH,
            expect.stringContaining(`"node": "${process.version}"`),
        );
        expect(mockedChildProcess.execFileSync).toHaveBeenCalledWith(
            'xcodebuild',
            ['-version'],
            expect.objectContaining({ encoding: 'utf8' }),
        );
    });

    test.each([
        ['linux', 'gcc', ['--version']],
        ['win32', 'cl', []],
    ] as const)('gets the native toolchain on %s', (platformName, command, args) => {
        setPlatform(platformName);
        expect(turbo.nativeToolchain()).toBe('tool 1.0');
        expect(mockedChildProcess.execFileSync).toHaveBeenCalledWith(command, args, expect.any(Object));
    });

    test('returns no toolchain for unsupported systems or a missing command', () => {
        setPlatform('aix');
        expect(turbo.nativeToolchain()).toBeNull();
        setPlatform('linux');
        mockedChildProcess.execFileSync.mockImplementation(() => {
            throw new Error('missing');
        });
        expect(turbo.nativeToolchain()).toBeNull();
    });

    test('uses the nullish fallback when the Windows compiler is unavailable', () => {
        setPlatform('win32');
        mockedChildProcess.execFileSync.mockImplementation(() => {
            throw new Error('missing');
        });

        expect(turbo.nativeToolchain()).toBeNull();
    });

    test('forwards Turbo arguments in order and reports child status', () => {
        expect(turbo.runTurbo(['run', 'bundle:renderer-full', '--dry=json'])).toBe(0);
        expect(mockedChildProcess.spawnSync).toHaveBeenCalledWith(
            process.execPath,
            [
                expect.stringMatching(/node_modules[\\/]turbo[\\/]bin[\\/]turbo$/),
                'run',
                'bundle:renderer-full',
                '--dry=json',
            ],
            expect.objectContaining({ stdio: 'inherit' }),
        );

        mockedChildProcess.spawnSync.mockReturnValue(spawnResult(null));
        expect(turbo.runTurbo([])).toBe(1);
    });

    test('throws child process errors', () => {
        const failure = new Error('spawn failed');
        mockedChildProcess.spawnSync.mockReturnValue(spawnResult(null, failure));
        expect(() => turbo.runTurbo([])).toThrow(failure);
    });

    test('sets the process exit code from Turbo', () => {
        const args = process.argv;
        try {
            process.argv = ['node', 'scripts/run-turbo.ts', 'run', 'validate:lint'];
            mockedChildProcess.spawnSync.mockReturnValue(spawnResult(7));
            turbo.main();
            expect(process.exitCode).toBe(7);
        } finally {
            process.argv = args;
            process.exitCode = undefined;
        }
    });
});
