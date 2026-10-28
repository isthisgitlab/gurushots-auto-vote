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
    // One exit discipline: a signal stops the server and exits after its close chain (the stay-logged-in clear)
    // has settled. The ref is null until startWebServer resolves — a signal before that exits at once, since
    // there is nothing to stop yet. Registered with once: a second signal during the close chain's settle wait
    // takes Node's default path and exits immediately, giving up the pending clear (the next launch's startup
    // clear covers it, as with any kill during a settings write).
    let stop: (() => Promise<void>) | null = null;
    const onSignal = () => {
        if (stop === null) {
            process.exit(0);
            return;
        }
        void stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
        const started = await startWebServer({ port, distDir: appPath('dist') });
        stop = started.stop;
        // The URL carries this run's access token in its fragment: stdout only, never the logger.
        console.log(`GuruShots Auto Vote web UI: ${started.url}`);
        // A signal stops through the handler above; a stop of the server's own (after a local-data wipe) exits
        // here, once the server's close chain has settled.
        started.server.once('close', () => {
            void started.whenClosed().finally(() => process.exit(0));
        });
    } catch (error) {
        // A failed start leaves a Ctrl-C on the shell's default behavior, so it reports this run's failure exit
        // code instead of exiting cleanly through a handler that has nothing left to stop.
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
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
