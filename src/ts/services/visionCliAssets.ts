import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as tar from 'tar';
import * as sea from 'node:sea';
import * as runtime from '../runtime';

const IN_USE_WINDOW_MS = 60 * 60 * 1000;

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * Digest of the runtime's executable code: every file under `node_modules`
 * (JavaScript, the `.node` addons, the shared libraries they load) by path and
 * content, and every symlink by path and target, in name order. The model
 * under `vision-model` is data and left out. The CLI build computes it over the
 * tree it archives; loading recomputes it over the extracted copy.
 */
const digestVisionRuntime = (root: string) => {
    const hash = crypto.createHash('sha256');
    const walk = (dir: string, name: string) => {
        // Default sort: UTF-16 code-unit order, the same on every host and locale.
        for (const entryName of fs.readdirSync(dir).sort()) {
            const entryPath = path.join(dir, entryName);
            const entryId = `${name}/${entryName}`;
            const stat = fs.lstatSync(entryPath);
            if (stat.isSymbolicLink()) hash.update(`L ${entryId}\0${fs.readlinkSync(entryPath)}\n`);
            else if (stat.isDirectory()) walk(entryPath, entryId);
            else hash.update(`F ${entryId}\0${sha256(fs.readFileSync(entryPath))}\n`);
        }
    };
    walk(path.join(root, 'node_modules'), 'node_modules');
    return hash.digest('hex');
};

/**
 * Compares the extracted runtime's code digest with the one embedded in the
 * binary at build time (never one stored beside the extracted files, which
 * whoever can edit the files can edit too). A copy that fails is removed so
 * the next run extracts a clean one.
 */
const verifyVisionRuntime = (root: string) => {
    const embedded = sea.getAsset('vision-runtime.code.sha256', 'utf8').trim();
    let actual: string | undefined;
    try {
        actual = digestVisionRuntime(root);
    } catch {
        // An unreadable or incomplete tree fails the comparison below.
    }
    if (actual !== embedded) {
        fs.rmSync(root, { recursive: true, force: true });
        throw new Error(
            'Vision runtime failed its integrity check and was removed; it is extracted again on the next run',
        );
    }
};

/** Extract the build-embedded model and native Node runtime once per version. */
const extractVisionCliAssets = () => {
    const expected = sea.getAsset('vision-runtime.sha256', 'utf8').trim();
    const parent = path.join(runtime.getUserDataDir('gurushots-auto-vote'), 'vision');
    const root = path.join(parent, expected.slice(0, 20));
    const ready = path.join(root, '.ready');
    if (!fs.existsSync(ready)) {
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const temporary = `${root}.${process.pid}`;
        const archive = `${temporary}.tar.gz`;
        try {
            fs.mkdirSync(temporary, { recursive: true });
            const bytes = Buffer.from(sea.getAsset('vision-runtime.tar.gz'));
            if (sha256(bytes) !== expected) {
                throw new Error('Embedded vision runtime checksum mismatch');
            }
            fs.writeFileSync(archive, bytes, { mode: 0o600 });
            tar.x({ file: archive, cwd: temporary, sync: true, strict: true });
            fs.writeFileSync(path.join(temporary, '.ready'), expected);
            try {
                fs.renameSync(temporary, root);
            } catch (error) {
                if (!fs.existsSync(ready)) throw error;
            }
        } finally {
            fs.rmSync(archive, { force: true });
            fs.rmSync(temporary, { recursive: true, force: true });
        }
        // Each version extracts beside the last, so a finished older copy
        // (hundreds of MB) is removed once this one is ready. A copy marked in
        // use within the last hour stays: an older CLI still running may not
        // have loaded its model yet (after loading, the files are in memory and
        // deleting them is harmless). A folder without .ready may be another
        // process mid-extraction, so it stays too.
        for (const entry of fs.readdirSync(parent)) {
            const previousReady = path.join(parent, entry, '.ready');
            if (
                entry !== path.basename(root) &&
                fs.existsSync(previousReady) &&
                Date.now() - fs.statSync(previousReady).mtimeMs > IN_USE_WINDOW_MS
            ) {
                fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
            }
        }
    }
    verifyVisionRuntime(root);
    // Mark this copy in use right before the model loads from it.
    const now = new Date();
    fs.utimesSync(ready, now, now);
    return {
        root,
        modulePath: path.join(root, 'vision-entry.js'),
    };
};

export { extractVisionCliAssets, digestVisionRuntime };
