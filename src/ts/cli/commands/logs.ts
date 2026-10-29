/**
 * CLI `logs` command. Prints the tail of one of the on-disk log files so CLI
 * users get the after-the-fact log access the Electron Logs page provides;
 * `--follow` (logsFollow.ts) keeps printing what is appended to any of the
 * category's files — the live view the Logs window gives. The logger owns
 * the file paths; this command only reads and tails them, and every line
 * goes to the console only, so reading a log never writes into the file it
 * reads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as logger from '../../logger';
import { MAX_MESSAGE_LENGTH } from '../../logger/write';
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

// A log file line can be longer than MAX_MESSAGE_LENGTH — the cap
// logger/write.ts applies to every message (the file's own prefix rides in
// the same message) — and one printLine call would cut it. A line past the
// cap prints in order, in pieces no longer than the cap, so every character
// reaches the console; plain `logs` and the follower share the split. A cut
// that would land between the two code units of a surrogate pair (an astral
// character at the cap) moves back one unit, so the character prints whole
// instead of as two U+FFFD.
const printPieces = (line: string): string[] => {
    const clean = stripTerminalControl(line);
    const pieces: string[] = [];
    let at = 0;
    while (at < clean.length) {
        let end = Math.min(at + MAX_MESSAGE_LENGTH, clean.length);
        const last = clean.charCodeAt(end - 1);
        if (end < clean.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        pieces.push(clean.slice(at, end));
        at = end;
    }
    return pieces.length > 0 ? pieces : [''];
};

// Plain `logs` prints each tail line through the split, console only.
const printUncut = (text: string): void => {
    for (const piece of printPieces(text)) logger.printLine(piece);
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
        // The piece after the file's final newline is the split artefact, not a
        // line: drop it, so --lines=N prints the last N real lines.
        if (allLines[allLines.length - 1] === '') allLines.pop();
        const tail = allLines.slice(-lines);
        logger.withCategory('ui').info(`=== ${category} log (last ${lines} lines): ${filePath} ===`);
        // The log lines as the file holds them, one print call per line — a
        // tail printed as one string would be cut at the cap and lose its
        // newest lines — on the console only, not written back into the log
        // file they came from.
        for (const line of tail) printUncut(line);
    } catch (error) {
        logger.withCategory('ui').error(`Error reading ${category} log`, error);
    }
};

/**
 * Every `<prefix>-YYYY-MM-DD.log` path in `dir`, sorted by name (the dated
 * names sort chronologically). Empty when the directory holds no matching
 * file; null when the directory itself cannot be read — a failed listing is
 * not the fact "every file is gone", and only a listing that succeeded may
 * prune the follow state.
 */
const listLogFiles = (dir: string, prefix: string): string[] | null => {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return null; // the read failed: nothing is known about the folder's contents
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
    // A failed listing is no file to tail, like an empty folder.
    for (const filePath of listLogFiles(dir, prefix) ?? []) {
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

export { latestLogFile, listLogFiles, printPieces, showLogs };
