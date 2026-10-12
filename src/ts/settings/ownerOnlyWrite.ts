/**
 * The owner-only write of a userData file: the transport of every JSON store that is not replaced atomically.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as logger from '../logger';
import { errorMessage } from '../errorMessage';

// Paths whose refused chmod has been logged. A path is dropped again (and the
// recovery logged) once a chmod on it succeeds, so a file that stays
// unrestrictable warns once per failure episode rather than on every write.
const warnedUnrestrictable = new Set<string>();

/**
 * Write a userData file owner-only (0o600), creating its directory 0o700.
 * The mode passed to writeFileSync only applies when the file is created, so
 * an existing file is chmod'ed to 0o600 before the new content lands in it:
 * when that chmod succeeds the data is never written into a file other local
 * users can read. A chmod that reaches no file (ENOENT: it does not exist yet;
 * EACCES: a directory on its path cannot be searched) is skipped silently: the
 * write then creates it with 0o600 or fails with its own error, and a "could
 * not restrict" warning would point at the wrong fix. A chmod the filesystem
 * refuses (a file owned by another uid, a vfat/SMB/FUSE mount) is logged with
 * what it needs, once per failure episode (until a chmod on that path succeeds
 * again, which is logged as the recovery), and does not fail the write: the
 * data still persists. The files can carry the auth token. The file is
 * rewritten in place rather than replaced by a rename.
 */
const writeOwnerOnly = (filePath: string, data: string) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
        fs.chmodSync(filePath, 0o600);
        if (warnedUnrestrictable.delete(filePath)) {
            logger.withCategory('settings').info(`Restricted ${filePath} to owner-only`);
        }
    } catch (err) {
        const code = err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
        if (code !== 'ENOENT' && code !== 'EACCES' && !warnedUnrestrictable.has(filePath)) {
            warnedUnrestrictable.add(filePath);
            const reason = code ?? errorMessage(err) ?? 'unknown error';
            logger
                .withCategory('settings')
                .warning(
                    `Could not restrict ${filePath} to owner-only (${reason}); other local users may be able to read it. It must be a regular file owned by the account this app runs as, on a filesystem that supports permissions (not FAT, SMB or FUSE); once it is, the next save restricts it automatically.`,
                );
        }
    }
    fs.writeFileSync(filePath, data, { encoding: 'utf8', mode: 0o600 });
};

export { writeOwnerOnly };
