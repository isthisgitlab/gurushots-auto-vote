const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tar = require('tar');
const sea = require('node:sea');
const runtime = require('../runtime');

const IN_USE_WINDOW_MS = 60 * 60 * 1000;

/** Extract the build-embedded model and native Node runtime once per version. */
const extractVisionCliAssets = () => {
    const expected = sea.getAsset('vision-runtime.sha256', 'utf8').trim();
    const parent = path.join(runtime.getUserDataDir('gurushots-auto-vote'), 'vision');
    const root = path.join(parent, expected.slice(0, 20));
    const ready = path.join(root, '.ready');
    if (!fs.existsSync(ready)) {
        fs.mkdirSync(parent, { recursive: true });
        const temporary = `${root}.${process.pid}`;
        const archive = `${temporary}.tar.gz`;
        try {
            fs.mkdirSync(temporary, { recursive: true });
            const bytes = Buffer.from(sea.getAsset('vision-runtime.tar.gz'));
            if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) {
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
    // Mark this copy in use right before the model loads from it.
    const now = new Date();
    fs.utimesSync(ready, now, now);
    return {
        root,
        modulePath: path.join(root, 'vision-entry.js'),
    };
};

module.exports = { extractVisionCliAssets };
