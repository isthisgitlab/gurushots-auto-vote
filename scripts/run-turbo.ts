#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runIfMain } from './lib/run-if-main';

const ROOT = path.join(__dirname, '..');
const CONTEXT_PATH = path.join(ROOT, '.turbo', 'build-context.json');

const commandVersion = (command: string, args: string[]): string | null => {
    try {
        return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
};

const nativeToolchain = (): string | null => {
    if (process.platform === 'darwin') return commandVersion('xcodebuild', ['-version']);
    if (process.platform === 'linux') return commandVersion('gcc', ['--version'])?.split('\n')[0] ?? null;
    if (process.platform === 'win32') return commandVersion('cl', [])?.split('\n')[0] ?? null;
    return null;
};

const writeBuildContext = (): void => {
    fs.mkdirSync(path.dirname(CONTEXT_PATH), { recursive: true });
    fs.writeFileSync(
        CONTEXT_PATH,
        `${JSON.stringify(
            {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                nativeToolchain: nativeToolchain(),
            },
            null,
            2,
        )}\n`,
    );
};

const runTurbo = (args: string[]): number => {
    writeBuildContext();
    const turboBin = path.join(ROOT, 'node_modules', 'turbo', 'bin', 'turbo');
    const result = spawnSync(process.execPath, [turboBin, ...args], { cwd: ROOT, env: process.env, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
};

const main = (): void => {
    process.exitCode = runTurbo(process.argv.slice(2));
};

runIfMain(require.main, module, main);

export { CONTEXT_PATH, commandVersion, nativeToolchain, writeBuildContext, runTurbo, main };
