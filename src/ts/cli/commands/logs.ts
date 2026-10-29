/**
 * CLI `logs` command. Prints the tail of one of the on-disk log files so CLI
 * users get the after-the-fact log access the Electron Logs page provides,
 * and `--follow` keeps printing what is appended to any of the category's
 * files — the live view the Logs window gives. The logger owns the file
 * paths; this command only reads and tails them, and every follow line goes
 * to the console only, so following a log never writes into the files it
 * reads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
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
        const tail = allLines.slice(-lines);
        logger.withCategory('ui').info(`=== ${category} log (last ${lines} lines): ${filePath} ===`);
        // The log lines as the file holds them, one print call per line — one
        // call is capped, so a tail printed as one string would lose its newest
        // lines — on the console only, not written back into the log file they
        // came from.
        for (const line of tail) logger.printLine(stripTerminalControl(line));
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

/**
 * Every `<prefix>-YYYY-MM-DD.log` path in `dir`, sorted by name (the dated
 * names sort chronologically), or an empty list when there is no directory
 * (yet) — nothing to follow.
 */
const listLogFiles = (dir: string, prefix: string): string[] => {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const pattern = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.log$`);
    return names
        .filter((name) => pattern.test(name))
        .map((name) => path.join(dir, name))
        .sort();
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
    let best: LatestLogFile | null = null;
    for (const filePath of listLogFiles(dir, prefix)) {
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

/** Where one followed file is: the byte offset the next poll reads from, the
 * UTF-8 decoder carrying a multi-byte character split across polls, and the
 * text after the last newline, held until its newline arrives. */
export type FileFollowState = { offset: number; decoder: StringDecoder; pending: string };

/** Where the follower is: per-file state for every file of the category, and
 * the file the last printed line came from — the `--- <file path>` separator
 * shows when that changes. */
export type FollowState = { files: Map<string, FileFollowState>; lastPrinted: string | null };

/** The follower's surroundings, injectable so tests drive the poll steps directly. */
export type FollowDeps = {
    dir: string;
    intervalMs: number;
    /** Every `<prefix>-*.log` path in the directory, in print order. */
    list: (dir: string, prefix: string) => string[];
    /** The newest file of the category — the one the initial tail comes from. */
    latest: (dir: string, prefix: string) => LatestLogFile | null;
    print: (text: string) => void;
    sleep: (ms: number) => Promise<void>;
};

// How often the follower polls for appended bytes and fresher files.
const FOLLOW_INTERVAL_MS = 1000;

// The one writer the follower prints through: console only (printLine never
// writes a log entry), the line stripped of terminal control — an info()
// here would append to the very file being followed.
const printFollow = (text: string) => logger.printLine(stripTerminalControl(text));

const defaultFollowDeps = (): FollowDeps => ({
    dir: logger.logsDir,
    intervalMs: FOLLOW_INTERVAL_MS,
    list: listLogFiles,
    latest: latestLogFile,
    print: printFollow,
    sleep: (ms) =>
        new Promise((resolve) => {
            setTimeout(resolve, ms);
        }),
});

/**
 * One followed line: the `--- <file path>` separator first whenever the lines
 * come from a file different from the previous printed lines', then the line —
 * one print call per line, since one call is capped and a longer batch would
 * lose its newest lines. Mutates `state.lastPrinted`.
 */
const printFollowedLine = (state: FollowState, filePath: string, line: string, print: (text: string) => void): void => {
    if (state.lastPrinted !== filePath) {
        print(`--- ${filePath}`);
        state.lastPrinted = filePath;
    }
    print(line);
};

/**
 * Gives every existing file of the category its current byte size as the
 * offset the polls continue from, so only what is appended after the start
 * prints. One whose stat fails is not seeded — the first poll then follows it
 * from its first byte.
 */
const seedFollowState = (state: FollowState, prefix: string, deps: FollowDeps): void => {
    for (const filePath of deps.list(deps.dir, prefix)) {
        try {
            const offset = fs.statSync(filePath).size;
            state.files.set(filePath, { offset, decoder: new StringDecoder('utf8'), pending: '' });
        } catch {
            // Gone between the listing and the stat.
        }
    }
};

/** Prints the last `lines` lines of `filePath`, one print call per line. */
const printInitialTail = (filePath: string, lines: number, state: FollowState, print: (text: string) => void): void => {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return; // gone between the listing and this read; the polls re-resolve
    }
    for (const line of content.split('\n').slice(-lines)) printFollowedLine(state, filePath, line, print);
};

/**
 * One poll of one followed file: drops it when it is gone, restarts it at
 * byte 0 when it shrank (truncated in place), and reads and prints only the
 * bytes appended past its offset — complete lines only, each in its own print
 * call, with the text after the last newline held until its newline arrives.
 * The offset counts bytes and moves by bytes read, so a multi-byte UTF-8
 * character split across polls survives in the decoder. Mutates `state`.
 */
const pollFollowedFile = (
    state: FollowState,
    filePath: string,
    st: FileFollowState,
    print: (text: string) => void,
): void => {
    let size: number;
    try {
        size = fs.statSync(filePath).size;
    } catch {
        state.files.delete(filePath); // gone under us (cleanupOldLogs removes old files)
        return;
    }
    if (size < st.offset) {
        // Truncated in place: start over as a fresh file.
        st.offset = 0;
        st.decoder = new StringDecoder('utf8');
        st.pending = '';
    }
    if (size <= st.offset) return; // nothing appended past the offset
    let fd: number;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch {
        return; // vanished between the stat and the open; the next poll re-stats
    }
    try {
        const buffer = Buffer.allocUnsafe(size - st.offset);
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, st.offset);
        if (bytesRead <= 0) return; // the file ended right after the stat
        st.offset += bytesRead;
        st.pending += st.decoder.write(buffer.subarray(0, bytesRead));
    } finally {
        fs.closeSync(fd);
    }
    const lines = st.pending.split('\n');
    st.pending = lines[lines.length - 1];
    for (const line of lines.slice(0, -1)) printFollowedLine(state, filePath, line, print);
};

/**
 * One poll of the followed category: every `<prefix>-*.log` in the directory
 * is followed at once, each from its own byte offset — never one shared one —
 * so two writers (the desktop app's file and a CLI command's file) can never
 * make the follower replay a file it already printed. A file not in the state
 * appeared (or re-appeared) after the start and is followed from its first
 * byte. Mutates `state`.
 */
const followStep = (state: FollowState, prefix: string, deps: FollowDeps): void => {
    for (const filePath of deps.list(deps.dir, prefix)) {
        let st = state.files.get(filePath);
        if (st === undefined) {
            st = { offset: 0, decoder: new StringDecoder('utf8'), pending: '' };
            state.files.set(filePath, st);
        }
        pollFollowedFile(state, filePath, st, deps.print);
    }
};

/** The line the follower prints when SIGINT ends it. */
const STOPPED_MESSAGE = 'Stopped following the log.';

/**
 * Tail the category's log files and keep printing what is appended to any of
 * them — every `<prefix>-*.log` in the logs dir is followed at once, each
 * from its own byte offset — until SIGINT, then exit 0. The poll loop is
 * small on purpose: `deps` injects the directory, the file listing, the
 * newest-file lookup, the printer and the sleep, so tests drive the steps
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
    const state: FollowState = { files: new Map(), lastPrinted: null };
    seedFollowState(state, prefix, deps);
    const first = deps.latest(deps.dir, prefix);
    if (first === null) {
        deps.print(`No ${category} log file to follow yet; waiting for one to appear.`);
    } else {
        printInitialTail(first.path, lines, state, deps.print);
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
