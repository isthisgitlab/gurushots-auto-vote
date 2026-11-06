/** Extracts the CLI SEA's bundled FFmpeg decoder and verifies its manifest. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sea from 'node:sea';
import * as tar from 'tar';
import { isPlainObject } from '../../core/plainObject';
import { platform } from '../../core/platform/port';

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

const readFileNoFollow = (file: string): Buffer => {
    if (process.platform === 'win32') return fs.readFileSync(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        return fs.readFileSync(fd);
    } finally {
        fs.closeSync(fd);
    }
};

const decoderFileName = (): string => (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const probeFileName = (): string => (process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

const manifestChecksum = (root: string, expectedManifest: string): { decoderPath: string; probePath: string } => {
    const manifest = readFileNoFollow(path.join(root, 'MANIFEST.json'));
    if (sha256(manifest) !== expectedManifest) throw new Error('Embedded video decoder manifest checksum mismatch');
    const parsed: unknown = JSON.parse(manifest.toString('utf8'));
    if (
        !isPlainObject(parsed) ||
        typeof parsed.binary !== 'string' ||
        typeof parsed.binarySha256 !== 'string' ||
        typeof parsed.probe !== 'string' ||
        typeof parsed.probeSha256 !== 'string'
    ) {
        throw new Error('Embedded video decoder manifest is invalid');
    }
    if (parsed.binary !== decoderFileName() || parsed.probe !== probeFileName()) {
        throw new Error('Embedded video decoder executable name is invalid');
    }
    const binary = path.join(root, parsed.binary);
    const probe = path.join(root, parsed.probe);
    if (sha256(readFileNoFollow(binary)) !== parsed.binarySha256) {
        throw new Error('Embedded video decoder checksum mismatch');
    }
    if (sha256(readFileNoFollow(probe)) !== parsed.probeSha256) {
        throw new Error('Embedded video probe checksum mismatch');
    }
    return { decoderPath: binary, probePath: probe };
};

const cacheIsValid = (
    root: string,
    ready: string,
    expected: string,
    expectedManifest: string,
): { decoderPath: string; probePath: string } => {
    const directory = fs.lstatSync(root);
    if (!directory.isDirectory()) {
        throw new Error('Embedded video decoder cache directory is invalid');
    }
    if (readFileNoFollow(ready).toString('utf8') !== expected) {
        throw new Error('Embedded video decoder cache marker is invalid');
    }
    return manifestChecksum(root, expectedManifest);
};

const replaceCache = (root: string): void => {
    fs.rmSync(root, { recursive: true, force: true });
};

/** Extracts the checked full-build decoder once per embedded archive checksum. */
const extractVideoDecoderCliAssets = (): { decoderPath: string; probePath: string } => {
    const expected = sea.getAsset('video-decoder.sha256', 'utf8').trim();
    const expectedManifest = sea.getAsset('video-decoder.manifest.sha256', 'utf8').trim();
    const parent = path.join(platform().paths.getUserDataDir('gurushots-auto-vote'), 'video-decoder');
    const root = path.join(parent, expected.slice(0, 20));
    const ready = path.join(root, '.ready');
    try {
        return cacheIsValid(root, ready, expected, expectedManifest);
    } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (code !== undefined && code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw error;
        replaceCache(root);
    }
    {
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') fs.chmodSync(parent, 0o700);
        const temporary = `${root}.${process.pid}`;
        const archive = `${temporary}.tar.gz`;
        try {
            fs.mkdirSync(temporary, { recursive: true });
            const bytes = Buffer.from(sea.getAsset('video-decoder.tar.gz'));
            if (sha256(bytes) !== expected) throw new Error('Embedded video decoder archive checksum mismatch');
            fs.writeFileSync(archive, bytes, { mode: 0o600 });
            tar.x({ file: archive, cwd: temporary, sync: true, strict: true });
            const executables = manifestChecksum(temporary, expectedManifest);
            if (process.platform !== 'win32') {
                fs.chmodSync(executables.decoderPath, 0o700);
                fs.chmodSync(executables.probePath, 0o700);
            }
            fs.writeFileSync(path.join(temporary, '.ready'), expected);
            try {
                fs.renameSync(temporary, root);
            } catch (error) {
                try {
                    cacheIsValid(root, ready, expected, expectedManifest);
                } catch {
                    throw error;
                }
            }
        } finally {
            fs.rmSync(archive, { force: true });
            fs.rmSync(temporary, { recursive: true, force: true });
        }
    }
    return cacheIsValid(root, ready, expected, expectedManifest);
};

export { extractVideoDecoderCliAssets };
