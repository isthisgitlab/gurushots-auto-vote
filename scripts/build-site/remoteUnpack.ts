// Fetching and unpacking the phone pages the releases carry. Nothing is written or unpacked before
// its bytes are verified, and a page that cannot be fetched or verified throws: a site without a
// page some desktops depend on must never deploy.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { errorMessage } from '../../src/ts/core/errorMessage';
import { checksumNameOf } from './remoteReleases';
import type { LinkVersionPage, RemoteRelease } from './remoteReleases';

/**
 * The one legacy page the site keeps: 1.15.0 (and its betas, which fall to the "update" notice) named its page by
 * app version, so its desktops are sent to `/remote/1.15.0/`. It stays until a release removes it on purpose, the
 * moment 1.15.0 desktops are no longer supported. A fix to it needs a new 1.15.x asset and a new pin.
 */
export const LEGACY_PAGE_VERSION = '1.15.0';
export const LEGACY_PAGE_TAG = `v${LEGACY_PAGE_VERSION}`;
export const LEGACY_PAGE_ZIP = 'remote-page.zip';
/** The SHA-256 of the v1.15.0 release's `remote-page.zip`: the legacy page is checked against this pin, not against anything the release says about itself. */
export const LEGACY_PAGE_SHA256 = '3e81b7f2964b9ccef1519ead21dfa1aa5b8f742efa48b1d052ff82e76f38cf4d';

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

/** The legacy 1.15.0 page, fetched by tag and checked against the pinned hash before it is written or unpacked. */
export const unpackLegacyPage = async (
    getReleaseByTag: (tag: string) => Promise<RemoteRelease>,
    target: string,
    deps: UnpackDeps,
    pinnedSha256: string = LEGACY_PAGE_SHA256,
): Promise<void> => {
    try {
        const release = await getReleaseByTag(LEGACY_PAGE_TAG);
        const zip = release.assets.find((asset) => asset.name === LEGACY_PAGE_ZIP);
        if (zip === undefined) throw new Error(`${LEGACY_PAGE_TAG} carries no ${LEGACY_PAGE_ZIP}`);
        const zipBytes = await deps.download(zip.browser_download_url);
        if (sha256Of(zipBytes) !== pinnedSha256) {
            throw new Error(`${LEGACY_PAGE_ZIP} does not match the pinned SHA-256`);
        }
        await unpackVerifiedZip(zipBytes, target, deps.unzip);
    } catch (error) {
        throw new Error(
            `could not build the legacy ${LEGACY_PAGE_VERSION} phone page: ${errorMessage(error) ?? 'no reason given'}`,
            { cause: error },
        );
    }
    console.log(`✓ remote/${LEGACY_PAGE_VERSION}/ (from ${LEGACY_PAGE_TAG}, pinned SHA-256 verified)`);
};
