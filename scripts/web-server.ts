#!/usr/bin/env node

// Serves the web UI (src/ts/web/server.ts) on http://localhost:<port>/ from
// the built renderer in dist/. `pnpm web` builds the CSS and bundles first;
// pass --port=<n> (default 4400, 0 = any free port). The printed URL carries a
// random per-run token (`#t=...`) the pages need for every /api/ request.
import { startWebServer } from '../src/ts/web/server';
import { appPath } from '../src/ts/appPaths';
import { errorMessage } from '../src/ts/errorMessage';
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
    try {
        const { server, url } = await startWebServer({ port, distDir: appPath('dist') });
        // The URL carries this run's access token in its fragment: stdout only, never the logger.
        console.log(`GuruShots Auto Vote web UI: ${url}`);
        // The server stops itself after a local-data wipe; nothing is left to keep the process for.
        server.once('close', () => process.exit(0));
    } catch (error) {
        const inUse = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
        console.error(
            inUse
                ? `Port ${port} is already in use. Pick another with --port=<n> (0 = any free port).`
                : `Could not start the web UI: ${errorMessage(error) ?? String(error)}`,
        );
        process.exitCode = 1;
    }
};

runIfMain(require.main, module, main);

export { main, parsePort };
