#!/usr/bin/env node

// Serves the web UI (src/js/web/server.ts) on http://localhost:<port>/ from
// the built renderer in dist/. `pnpm web` builds the CSS and bundles first;
// pass --port=<n> (default 4400, 0 = any free port).
import { startWebServer } from '../src/js/web/server';
import { appPath } from '../src/js/appPaths';
import { runIfMain } from './lib/run-if-main';

const DEFAULT_PORT = 4400;

/**
 * @param argv - command-line arguments after the script path
 * @returns the port, or null when --port is not a valid port number
 */
const parsePort = (argv: string[]): number | null => {
    const flag = argv.find((arg) => arg.startsWith('--port='));
    if (!flag) return DEFAULT_PORT;
    const port = Number(flag.slice('--port='.length));
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
};

const main = async (argv = process.argv.slice(2)) => {
    const port = parsePort(argv);
    if (port === null) {
        console.error('Usage: pnpm web [--port=<0-65535>]');
        process.exitCode = 1;
        return;
    }
    const { url } = await startWebServer({ port, distDir: appPath('dist') });
    console.log(`GuruShots Auto Vote web UI: ${url}`);
};

runIfMain(require.main, module, main);

export { main, parsePort };
