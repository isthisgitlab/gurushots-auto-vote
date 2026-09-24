const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tar = require('tar');
const sea = require('node:sea');
const runtime = require('../runtime');

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
    }
    return {
        root,
        modulePath: path.join(root, 'vision-entry.js'),
    };
};

module.exports = { extractVisionCliAssets };
