import { COMMAND_ROWS } from './commandRows';

import type { CommandHandler } from './commandKit';

/**
 * The dispatch table: the rows' names and aliases → `(argv) => exitCode`, where argv is everything
 * after the command name. A handler resolving `undefined` leaves the process running (continuous mode).
 */
const COMMANDS: Record<string, CommandHandler> = Object.fromEntries(
    COMMAND_ROWS.flatMap((row) => [
        [row.name, row.handler] as const,
        ...(row.aliases ?? []).map((alias) => [alias, row.handler] as const),
    ]),
);

// The commands that hold no session marker, so they never make a local-data wipe wait: help and licenses, which only
// print, and `reset-data`, which checks for running sessions itself.
const MARKERLESS_COMMANDS = new Set(
    COMMAND_ROWS.flatMap((row) => (row.markerless ? [row.name, ...(row.aliases ?? [])] : [])),
);

/**
 * Whether a command holds the CLI session marker while it runs: every command that loads the settings does, since a
 * load can write them back (a migration, a scrub) and a command can spend, so a wipe (or `reset-data` in another
 * terminal) refuses while it runs.
 */
const holdsSessionMarker = (name: string): boolean => !MARKERLESS_COMMANDS.has(name);

export { COMMANDS, holdsSessionMarker };
