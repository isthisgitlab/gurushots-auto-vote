import * as logger from '../logger';
import { requireProfileArgs, requireChallenge } from './guards';
import { parseChallengeFlag } from './commands/voting';

/**
 * A command handler: argv after the command name → exit code, or undefined to
 * leave the process running (continuous mode).
 */
type CommandHandler = (argv: string[]) => Promise<number | undefined>;

// Pull --challenge=<id> (or --challenge <id>) out of an arg list and return
// the remaining positional args, so per-challenge settings commands accept
// the flag in any position (mirrors `run --challenge=<id>`).
const extractChallenge = (argv: string[]): { challengeId: string | null; rest: string[] } => {
    const challengeId = parseChallengeFlag(argv);
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--challenge') {
            i++; // skip the flag and its separate value
            continue;
        }
        if (argv[i].startsWith('--challenge=')) continue;
        rest.push(argv[i]);
    }
    return { challengeId, rest };
};

/**
 * Log a usage error (one error line, then any usage/help lines) and yield exit code 1.
 */
const usageError = (message: string, ...usage: string[]): number => {
    logger.withCategory('ui').error(message);
    for (const line of usage) logger.withCategory('ui').info(line);
    return 1;
};

/**
 * A command that only runs `fn` and then exits 0.
 */
const exitsZero =
    (fn: () => unknown): CommandHandler =>
    async () => {
        await fn();
        return 0;
    };

/**
 * Exit code for a command reporting `false` on failure.
 */
const exitCodeOf = (ok: boolean | undefined) => (ok === false ? 1 : 0);

/**
 * A per-challenge action: pull --challenge out of argv, require it (printing
 * `usage` otherwise), then `run(challengeId, rest)` → exit code.
 */
const challengeCommand =
    (usage: string, run: (challengeId: string, rest: string[]) => number | Promise<number>): CommandHandler =>
    async (argv) => {
        const { challengeId, rest } = extractChallenge(argv);
        requireChallenge({ challengeId }, usage);
        // requireChallenge exits the process when the id is missing.
        return run(challengeId as string, rest);
    };

/**
 * A profile command: resolve the profile name via requireProfileArgs, then `run(name, challengeId)`.
 */
const profileCommand =
    (
        name: string,
        run: (name: string, challengeId: string) => void,
        ...options: [opts?: Parameters<typeof requireProfileArgs>[2]]
    ): CommandHandler =>
    async (argv) => {
        const parsed = extractChallenge(argv);
        const profile = requireProfileArgs(name, parsed, ...options);
        // requireProfileArgs exits when a needsChallenge command lacks the id;
        // the commands that don't need one ignore it.
        run(profile, parsed.challengeId as string);
        return 0;
    };

/**
 * A per-challenge action taking only a `{ [option]: flagPresent }` bag, then exiting 0.
 */
const flagAction =
    (
        fn: (challengeId: string, opts: Record<string, boolean>) => Promise<unknown>,
        option: string,
        flag: string,
    ): ((challengeId: string, rest: string[]) => Promise<number>) =>
    async (challengeId, rest) => {
        await fn(challengeId, { [option]: rest.includes(flag) });
        return 0;
    };

/**
 * A scenario command taking positional arguments (quoted names, file paths)
 * and flags: requires `count` positionals, then `run(positionals, flags)`.
 */
const scenarioCommand =
    (
        usage: string,
        count: number,
        run: (positionals: string[], flags: Set<string>) => number | Promise<number>,
        maxPositionals: number = count,
    ): CommandHandler =>
    async (argv) => {
        const positionals = argv.filter((arg) => !arg.startsWith('--'));
        const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
        if (positionals.length < count || positionals.length > maxPositionals)
            return usageError('Wrong arguments', usage);
        return run(positionals, flags);
    };

export {
    extractChallenge,
    usageError,
    exitsZero,
    exitCodeOf,
    challengeCommand,
    profileCommand,
    flagAction,
    scenarioCommand,
};
export type { CommandHandler };
