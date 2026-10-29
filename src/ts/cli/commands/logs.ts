/**
 * CLI `logs` command. Prints the tail of one of the on-disk log files so CLI
 * users get the after-the-fact log access the Electron Logs page provides,
 * and `--follow` keeps printing what is appended — the live view the Logs
 * window gives. The logger owns the file paths; this command only reads and
 * tails them, and every follow line goes to the console only, so following a
 * log never writes into the file it reads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as logger from '../../logger';
import { stripTerminalControl } from '../../format/logSafe';
import { diagnostics } from '../../services/semantic/diagnostics';

// category flag → logger path getter. Defaults to the app log.
const LOG_FILE_GETTERS: Record<string, () => string | null> = {
    app: () => logger.getLogFile(),
    error: () => logger.getErrorLogFile(),
    api: () => logger.getApiLogFile(),
    settings: () => logger.getSettingsLogFile(),
};

const showLexiconReport = () => {
    const report = diagnostics.read();
    const top = (words: Record<string, number>) =>
        Object.entries(words)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 20)
            .map(([word, count]) => `${word}: ${count}`)
            .join(', ') || '(none)';
    for (const line of [
        `Lexicon diagnostics (since ${report.since}; last updated ${report.updatedAt || 'never'})`,
        `Challenge observations: ${report.challenges}`,
        `No theme vector: ${report.noThemeVector}`,
        `No label vectors: ${report.noLabelVectors}`,
        `No on-theme semantic score: ${report.noOnThemeScore}`,
        `Missing challenge words: ${top(report.themeWords)}`,
        `Missing photo-label words: ${top(report.labelWords)}`,
    ]) {
        logger.withCategory('ui').info(line);
    }
};

const showLogs = ({ category = 'app', lines = 100 }: { category?: string; lines?: number } = {}) => {
    if (category === 'lexicon') return showLexiconReport();
    const getPath = LOG_FILE_GETTERS[category] || LOG_FILE_GETTERS.app;
    const filePath = getPath();
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            logger.withCategory('ui').info(`No ${category} log file found yet.`);
            return;
        }
        const allLines = fs.readFileSync(filePath, 'utf8').split('\n');
        const tail = allLines.slice(-lines).join('\n');
        logger.withCategory('ui').info(`=== ${category} log (last ${lines} lines): ${filePath} ===`);
        // The log lines as the file holds them, one per line: printed whole on the console only,
        // not written back into the log file they came from.
        logger.printLine(
            tail
                .split('\n')
                .map((line) => stripTerminalControl(line))
                .join('\n'),
        );
    } catch (error) {
        logger.withCategory('ui').error(`Error reading ${category} log`, error);
    }
};

// The on-disk file prefix per category, following getLogFilePaths' names
// (logger/files.ts): app-YYYY-MM-DD.log, errors-…, api-…, settings-….
type LogFileCategory = 'app' | 'error' | 'api' | 'settings';

const LOG_FILE_PREFIXES: Record<LogFileCategory, string> = {
    app: 'app',
    error: 'errors',
    api: 'api',
    settings: 'settings',
};

/** The most recently modified `<prefix>-*.log` in a directory, with its mtime. */
export type LatestLogFile = { path: string; mtimeMs: number };

/**
 * The most recently modified `<prefix>-*.log` in `dir`, or null when there is
 * none. Deliberately not today's name: a writing process keeps the file it
 * opened at start-up (currentLogFiles is fixed once), so the newest mtime can
 * belong to an earlier day's file. Ties go to the lexicographically greater
 * path, so the choice is deterministic.
 */
const latestLogFile = (dir: string, prefix: string): LatestLogFile | null => {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return null; // no directory (yet) — nothing to follow
    }
    const pattern = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.log$`);
    let best: LatestLogFile | null = null;
    for (const name of names) {
        if (!pattern.test(name)) continue;
        const filePath = path.join(dir, name);
        let mtimeMs: number;
        try {
            mtimeMs = fs.statSync(filePath).mtimeMs;
        } catch {
            continue; // deleted between the listing and the stat
        }
        if (best === null || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && filePath > best.path)) {
            best = { path: filePath, mtimeMs };
        }
    }
    return best;
};

/** Where the follower is: the file it reads and the offset the next poll prints from. */
export type FollowState = { filePath: string | null; offset: number };

/** The follower's surroundings, injectable so tests drive the poll steps directly. */
export type FollowDeps = {
    dir: string;
    intervalMs: number;
    latest: (dir: string, prefix: string) => LatestLogFile | null;
    print: (text: string) => void;
    sleep: (ms: number) => Promise<void>;
};

// How often the follower polls for appended bytes and fresher files.
const FOLLOW_INTERVAL_MS = 1000;

// The one writer the follower prints through: console only (printLine never
// writes a log entry), each line stripped of terminal control — an info()
// here would append to the very file being followed.
const printFollow = (text: string) =>
    logger.printLine(
        text
            .split('\n')
            .map((line) => stripTerminalControl(line))
            .join('\n'),
    );

const defaultFollowDeps = (): FollowDeps => ({
    dir: logger.logsDir,
    intervalMs: FOLLOW_INTERVAL_MS,
    latest: latestLogFile,
    print: printFollow,
    sleep: (ms) =>
        new Promise((resolve) => {
            setTimeout(resolve, ms);
        }),
});

const mtimeMsOf = (filePath: string): number | null => {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return null; // deleted under us
    }
};

/**
 * One poll of the followed category: switch to a newer-modified file when one
 * appears (printing its path on its own line), reset the offset when the
 * followed file shrank or is gone — re-reading from the start of whichever
 * file it then follows — and print what was appended past the offset.
 * Mutates `state`.
 */
const followStep = (state: FollowState, prefix: string, deps: FollowDeps): void => {
    const newest = deps.latest(deps.dir, prefix);
    if (newest !== null && newest.path !== state.filePath) {
        // A strictly newer modification time only: staying with the followed
        // file when the newest listing merely ties it keeps a tie from
        // flapping the follower between two files.
        const currentMtimeMs = state.filePath === null ? null : mtimeMsOf(state.filePath);
        if (currentMtimeMs === null || newest.mtimeMs > currentMtimeMs) {
            deps.print(`--- now following ${newest.path}`);
            state.filePath = newest.path;
            state.offset = 0;
        }
    }
    if (state.filePath === null) return;
    let content: string;
    try {
        content = fs.readFileSync(state.filePath, 'utf8');
    } catch {
        // Deleted under us (cleanupOldLogs removes old files): the next poll
        // re-resolves and reads from the start.
        state.offset = 0;
        return;
    }
    if (content.length < state.offset) state.offset = 0; // truncated in place
    const appended = content.slice(state.offset);
    state.offset = content.length;
    if (appended.length > 0) deps.print(appended);
};

/**
 * Prints the last `lines` lines of `filePath` and returns the offset the polls
 * continue from (the whole content), or null when the file is gone between
 * the listing and this read.
 */
const initialTail = (filePath: string, lines: number, print: (text: string) => void): number | null => {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return null; // gone between the listing and this read; the poll re-resolves
    }
    print(content.split('\n').slice(-lines).join('\n'));
    return content.length;
};

/** The line the follower prints when SIGINT ends it. */
const STOPPED_MESSAGE = 'Stopped following the log.';

/**
 * Tail the category's most recently modified log file and keep printing what
 * is appended to it — across the files rotating (a newer-modified file takes
 * over; a shrink or a deletion re-reads from the start) — until SIGINT, then
 * exit 0. The poll loop is small on purpose: `deps` injects the directory,
 * the newest-file lookup, the printer and the sleep, so tests drive the steps
 * directly or with fake timers.
 */
const followLogs = async ({
    category = 'app',
    lines = 100,
    deps = defaultFollowDeps(),
}: {
    category?: LogFileCategory;
    lines?: number;
    deps?: FollowDeps;
} = {}): Promise<number> => {
    const prefix = LOG_FILE_PREFIXES[category];
    const state: FollowState = { filePath: null, offset: 0 };
    const first = deps.latest(deps.dir, prefix);
    if (first === null) {
        deps.print(`No ${category} log file to follow yet; waiting for one to appear.`);
    } else {
        deps.print(`--- following ${first.path} (Ctrl+C to stop)`);
        state.filePath = first.path;
        state.offset = initialTail(first.path, lines, deps.print) ?? 0;
    }
    let stopped = false;
    const stop = () => {
        stopped = true;
    };
    process.on('SIGINT', stop);
    try {
        while (!stopped) {
            followStep(state, prefix, deps);
            await deps.sleep(deps.intervalMs);
        }
    } finally {
        process.removeListener('SIGINT', stop);
    }
    deps.print(STOPPED_MESSAGE);
    return 0;
};

export { followLogs, followStep, latestLogFile, showLogs };
