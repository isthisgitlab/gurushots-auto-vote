/**
 * The `logs --follow` mode: tails the newest of the category's log files and
 * keeps printing what is appended to any of them — the live view the Logs
 * window gives. The shared print split lives in logs.ts (printPieces); the
 * logger owns the file paths, this mode only reads and tails them, and every
 * follow line goes to the console only, so following a log never writes into
 * the files it reads.
 */

import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import * as logger from '../../logger';
import { stripTerminalControl } from '../../format/logSafe';
import { latestLogFile, listLogFiles, printPieces } from './logs';
import type { LatestLogFile } from './logs';

// The on-disk file prefix per category, following getLogFilePaths' names
// (logger/files.ts): app-YYYY-MM-DD.log, errors-…, api-…, settings-….
type LogFileCategory = 'app' | 'error' | 'api' | 'settings';

const LOG_FILE_PREFIXES: Record<LogFileCategory, string> = {
    app: 'app',
    error: 'errors',
    api: 'api',
    settings: 'settings',
};

/** Where one followed file is: the byte offset the next poll reads from, the
 * UTF-8 decoder carrying a multi-byte character split across polls, the text
 * after the last newline, held until its newline arrives, and the file's
 * identity — inode plus birth time. A change of either means the name names
 * a different file again (deleted and re-created; a filesystem may hand a
 * re-created file the same inode), which restarts the file at byte 0. `-1`
 * means the value is not known yet; the first poll adopts the file's real
 * one. A birth time of `0` (what a platform without the value reports) is
 * never compared — there the inode decides alone. */
export type FileFollowState = {
    offset: number;
    decoder: StringDecoder;
    pending: string;
    ino: number;
    birthtimeMs: number;
};

/** Where the follower is: per-file state for every file of the category, the
 * file the last printed line came from — the `--- <file path>` separator
 * shows when that changes — and whether the start-up seed is still owed
 * (its listing failed): the first good poll then seeds the files it lists at
 * their current size, instead of taking them for new ones. */
export type FollowState = { files: Map<string, FileFollowState>; lastPrinted: string | null; seedPending: boolean };

/** The follower's surroundings, injectable so tests drive the poll steps directly. */
export type FollowDeps = {
    dir: string;
    intervalMs: number;
    /** Every `<prefix>-*.log` path in the directory, in print order; null
     * when the listing itself cannot be read (the poll is skipped whole). */
    list: (dir: string, prefix: string) => string[] | null;
    /** The newest file of the category — the one the initial tail comes from. */
    latest: (dir: string, prefix: string) => LatestLogFile | null;
    print: (text: string) => void;
    sleep: (ms: number) => Promise<void>;
};

// How often the follower polls for appended bytes and fresher files.
const FOLLOW_INTERVAL_MS = 1000;

// The most bytes one poll reads from a file in a single read: an unread span
// is read in chunks of at most this size until the stat's size, never one
// allocation for whatever grew.
const FOLLOW_READ_CHUNK_BYTES = 1024 * 1024;

// The one writer the follower prints through: console only (printLine never
// writes a log entry), the line stripped of terminal control — an info()
// here would append to the very file being followed. Lines arrive from
// printFollowedLine already split to the print cap.
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
 * come from a file different from the previous printed lines', then the line
 * — one print call, or the pieces printPieces splits a line longer than the
 * print cap into, so nothing is cut. Mutates `state.lastPrinted`.
 */
const printFollowedLine = (state: FollowState, filePath: string, line: string, print: (text: string) => void): void => {
    if (state.lastPrinted !== filePath) {
        print(`--- ${filePath}`);
        state.lastPrinted = filePath;
    }
    for (const piece of printPieces(line)) print(piece);
};

/** The state one existing file is seeded with: its byte size as the offset
 * the polls continue from — only what is appended after the seed prints —
 * and the identity the stat read. */
const seededFileState = (stat: fs.Stats): FileFollowState => ({
    offset: stat.size,
    decoder: new StringDecoder('utf8'),
    pending: '',
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
});

/** The state a file new to the follower starts from: the first byte, and the
 * `-1` identity the first poll adopts (stat'ing it here would race the
 * poll's own stat). */
const newFileState = (): FileFollowState => ({
    offset: 0,
    decoder: new StringDecoder('utf8'),
    pending: '',
    ino: -1,
    birthtimeMs: -1,
});

/** Seed one listed file at its current size; a stat that fails falls back to
 * the first byte, the way a seed-stat failure behaves in a normal start. */
const seedOrNewFileState = (filePath: string): FileFollowState => {
    try {
        return seededFileState(fs.statSync(filePath));
    } catch {
        return newFileState();
    }
};

/**
 * Gives every existing file of the category its current byte size as the
 * offset the polls continue from, so only what is appended after the start
 * prints. One whose stat fails is not seeded — the first poll then follows it
 * from its first byte. A listing that cannot be read seeds nothing and marks
 * the state seedPending: the first good poll seeds the files it lists at
 * their current size (followStep), so a start-up whose folder read failed
 * never replays the older files. The file the initial tail reads has its
 * entry set again by the tail itself, from the bytes it read
 * (printInitialTail).
 */
const seedFollowState = (state: FollowState, prefix: string, deps: FollowDeps): void => {
    const listed = deps.list(deps.dir, prefix);
    if (listed === null) {
        // The read failed: nothing is known about the folder's contents.
        state.seedPending = true;
        return;
    }
    for (const filePath of listed) {
        try {
            state.files.set(filePath, seededFileState(fs.statSync(filePath)));
        } catch {
            // Gone between the listing and the stat.
        }
    }
};

/**
 * Prints the last `lines` complete lines of `filePath`, and seeds the file's
 * followed state from this read: the offset is the bytes the tail itself read
 * — not a stat taken earlier, whose size bytes appended since have left
 * behind, so nothing prints twice — the inode is the file's own, the decoder
 * carries a multi-byte character the read's end cut, and a last line without
 * its newline becomes the held partial line, printing once when its newline
 * arrives. A non-regular entry (a FIFO with a log's name) is skipped whole —
 * its open is non-blocking so it cannot hang the tail, and nothing prints
 * or seeds.
 */
const printInitialTail = (filePath: string, lines: number, state: FollowState, print: (text: string) => void): void => {
    let fd: number;
    try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch {
        return; // gone between the listing and this read; the polls re-resolve
    }
    let content: Buffer;
    let ino: number;
    let birthtimeMs: number;
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return; // a non-regular entry (a FIFO) is not tailed
        ino = stat.ino;
        birthtimeMs = stat.birthtimeMs;
        content = fs.readFileSync(fd);
    } catch {
        return; // the fstat or the read of the open file failed; the polls re-resolve
    } finally {
        fs.closeSync(fd);
    }
    const decoder = new StringDecoder('utf8');
    const text = decoder.write(content);
    const pieces = text.split('\n');
    let pending = '';
    if (text.endsWith('\n')) {
        pieces.pop(); // the empty piece the final newline leaves is not a line
    } else {
        // The last line has no newline yet: hold it, never print it half.
        pending = pieces[pieces.length - 1];
        pieces.length -= 1;
    }
    for (const line of pieces.slice(-lines)) printFollowedLine(state, filePath, line, print);
    state.files.set(filePath, { offset: content.length, decoder, pending, ino, birthtimeMs });
};

/**
 * One poll of one followed file: opens the file once and takes its identity
 * and size from that open file (fstat), so the stat and the bytes read are
 * always of the same file; skips it for the poll when the open or that stat
 * fails or the entry is not a regular file (the open is non-blocking so a
 * FIFO with a log's name cannot hang it; the state survives — deletion is
 * the listing prune's call and a re-created name the identity check's),
 * restarts it at byte 0 when it
 * shrank (truncated in place) or when its identity changed (the name was
 * deleted and a different file written under it — a changed inode, or a
 * changed birth time under a reused inode; the new file is followed from its
 * first byte, never past the old file's offset), and reads and prints only
 * the bytes appended past its offset — complete lines only, each in its own
 * print call, with the text after the last newline held until its newline
 * arrives. The offset counts bytes and moves by bytes read, so a multi-byte
 * UTF-8 character split across polls survives in the decoder. Mutates
 * `state`.
 */
const pollFollowedFile = (
    state: FollowState,
    filePath: string,
    st: FileFollowState,
    print: (text: string) => void,
): void => {
    let fd: number;
    try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch {
        // An open error (a transient EACCES/EIO, or the file going away) is
        // not the fact "gone": skip this file for this poll and keep its
        // state, so no error can wipe the offset and replay the file. A
        // deleted file is retired by the listing prune, a re-created one by
        // the identity check below.
        return;
    }
    try {
        let size: number;
        let ino: number;
        let birthtimeMs: number;
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) return; // a non-regular entry (a FIFO) is not followed
            size = stat.size;
            ino = stat.ino;
            birthtimeMs = stat.birthtimeMs;
        } catch {
            return; // the stat through the open file failed: skip, as above
        }
        // A different file now carries this name (deleted and re-created): the
        // inode changed, or the birth time changed under a reused inode (ext4
        // can hand the same one back). A birth time that is not known yet (-1)
        // or not reported by the platform (0) cannot be compared — there the
        // inode decides alone.
        const birthtimeKnown = st.birthtimeMs > 0 && birthtimeMs > 0;
        const birthtimeChanged = birthtimeKnown && birthtimeMs !== st.birthtimeMs;
        if (ino !== st.ino || birthtimeChanged) {
            // Follow the new file from its first byte, with fresh decoder and
            // line state.
            st.ino = ino;
            st.birthtimeMs = birthtimeMs;
            st.offset = 0;
            st.decoder = new StringDecoder('utf8');
            st.pending = '';
        }
        if (size < st.offset) {
            // Truncated in place: start over as a fresh file.
            st.offset = 0;
            st.decoder = new StringDecoder('utf8');
            st.pending = '';
        }
        if (size <= st.offset) return; // nothing appended past the offset
        // The unread span is read in bounded chunks (FOLLOW_READ_CHUNK_BYTES)
        // until the size the fstat reported, and each chunk's complete lines
        // print as they are decoded — the span is never one allocation, and
        // never one print call past the cap.
        while (st.offset < size) {
            const buffer = Buffer.allocUnsafe(Math.min(FOLLOW_READ_CHUNK_BYTES, size - st.offset));
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, st.offset);
            if (bytesRead <= 0) return; // the file ended before this position
            st.offset += bytesRead;
            st.pending += st.decoder.write(buffer.subarray(0, bytesRead));
            const lines = st.pending.split('\n');
            st.pending = lines[lines.length - 1];
            for (const line of lines.slice(0, -1)) printFollowedLine(state, filePath, line, print);
        }
    } finally {
        fs.closeSync(fd);
    }
};

/**
 * One poll of the followed category: every `<prefix>-*.log` in the directory
 * is followed at once, each from its own byte offset — never one shared one —
 * so two writers (the desktop app's file and a CLI command's file) can never
 * make the follower replay a file it already printed. A failed listing (null)
 * skips the poll whole — no prune, no reads, nothing printed — so one poll
 * whose folder read fails cannot wipe the follow state and replay files from
 * byte 0 on the next good listing. When the start-up seed is still owed (its
 * listing failed), the first good listing is that seed: every file it names
 * starts at its current size, the same as a normal start, and the file the
 * initial tail read keeps the offset the tail seeded. From the next poll on,
 * a file not in the state appeared (or re-appeared) after the start and is
 * followed from its first byte; a file the listing no longer names has its
 * state removed, so only a listing that succeeded may retire one. Mutates
 * `state`.
 */
const followStep = (state: FollowState, prefix: string, deps: FollowDeps): void => {
    const listed = deps.list(deps.dir, prefix);
    if (listed === null) return; // the folder read failed: prune nothing, poll nothing
    const named = new Set(listed);
    for (const filePath of state.files.keys()) {
        if (!named.has(filePath)) state.files.delete(filePath); // deleted: not in the listing
    }
    const seeding = state.seedPending;
    state.seedPending = false;
    for (const filePath of listed) {
        let st = state.files.get(filePath);
        if (st === undefined) {
            st = seeding ? seedOrNewFileState(filePath) : newFileState();
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
    const state: FollowState = { files: new Map(), lastPrinted: null, seedPending: false };
    seedFollowState(state, prefix, deps);
    const first = deps.latest(deps.dir, prefix);
    if (first === null) {
        deps.print(`No ${category} log file to follow yet; waiting for one to appear.`);
    } else {
        printInitialTail(first.path, lines, state, deps.print);
    }
    deps.print(`Following ${category} logs (Ctrl+C to stop)`);
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

export { FOLLOW_READ_CHUNK_BYTES, followLogs, followStep };
