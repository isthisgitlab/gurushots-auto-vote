// Fetching and unpacking the phone pages the releases carry. Nothing is written or unpacked before
// its bytes are verified, and a page that cannot be fetched or verified throws: a site without a
// page some desktops depend on must never deploy.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { checksumNameOf } from './remoteReleases';
import type { LinkVersionPage } from './remoteReleases';

export type UnpackDeps = {
    download: (url: string) => Promise<Buffer>;
    unzip: (zipPath: string, dir: string) => Promise<void>;
};

/** A SHA-256 as `sha256sum` writes it: 64 hex digits. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

const sha256Of = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

/** Writes already verified bytes to a temp zip, unpacks them into `target` and always cleans the temp dir up. */
const unpackVerifiedZip = async (zipBytes: Buffer, target: string, unzip: UnpackDeps['unzip']): Promise<void> => {
    const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-page-')), 'remote-page.zip');
    try {
        fs.writeFileSync(zipPath, zipBytes);
        fs.mkdirSync(target, { recursive: true });
        await unzip(zipPath, target);
    } finally {
        fs.rmSync(path.dirname(zipPath), { recursive: true, force: true });
    }
};

/**
 * One link version's page: downloads the zip and its checksum, throws when the release attaches no checksum or the
 * zip's sha256 does not match it, and unpacks the verified zip into `target`.
 */
export const unpackLinkVersionPage = async (page: LinkVersionPage, target: string, deps: UnpackDeps): Promise<void> => {
    if (page.checksum === undefined) {
        throw new Error(`${page.tag}: ${page.zip.name} has no ${checksumNameOf(page.zip.name)} beside it`);
    }
    const [zipBytes, checksumBytes] = await Promise.all([
        deps.download(page.zip.browser_download_url),
        deps.download(page.checksum.browser_download_url),
    ]);
    const expected = checksumBytes.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
    if (!SHA256_HEX.test(expected)) {
        throw new Error(`${page.tag}: ${page.checksum.name} is not a SHA-256 checksum file`);
    }
    if (sha256Of(zipBytes) !== expected) {
        throw new Error(`${page.tag}: ${page.zip.name} does not match its checksum`);
    }
    await unpackVerifiedZip(zipBytes, target, deps.unzip);
    console.log(`✓ remote/v${page.linkVersion}/ (from ${page.tag}, checksum verified)`);
};
