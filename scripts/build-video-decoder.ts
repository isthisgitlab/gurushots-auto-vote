#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIfMain } from './lib/run-if-main';

const FFMPEG_REVISION = '71403a21b02a92b925e26e609e9bd3e48df451cf';
const FFMPEG_ARCHIVE_URL = `https://code.ffmpeg.org/FFmpeg/FFmpeg/archive/${FFMPEG_REVISION}.tar.gz`;
const FFMPEG_ARCHIVE_SHA256 = '0a943b4fbd4d7e5c8513733e15668d1ff5671fb8d34fcd0ed0f89751349eae8b';
const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'video-decoder');
const SOURCE_ARCHIVE = path.join(CACHE_DIR, `ffmpeg-${FFMPEG_REVISION}.tar.gz`);
const OUTPUT_DIR = path.join(CACHE_DIR, `${process.platform}-${process.arch}`);
const ELECTRON_STAGE_DIR = path.join(ROOT, 'build', 'video-decoder');
const DECODER_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

const CONFIGURE_ARGS = [
    '--disable-autodetect',
    '--disable-x86asm',
    '--disable-avdevice',
    '--disable-bsfs',
    '--disable-doc',
    '--disable-gpl',
    '--disable-network',
    '--disable-nonfree',
    '--disable-programs',
    '--disable-shared',
    '--disable-swresample',
    '--enable-avcodec',
    '--enable-avfilter',
    '--enable-avformat',
    '--enable-avutil',
    '--enable-ffmpeg',
    '--enable-filter=scale',
    '--enable-muxer=image2',
    '--enable-protocol=file',
    '--enable-protocol=pipe',
    '--enable-small',
    '--enable-static',
    '--enable-swscale',
    '--disable-decoders',
    '--enable-decoder=av1',
    '--enable-decoder=h264',
    '--enable-decoder=hevc',
    '--enable-decoder=mjpeg',
    '--enable-decoder=mpeg2video',
    '--enable-decoder=mpeg4',
    '--enable-decoder=prores',
    '--enable-decoder=vp8',
    '--enable-decoder=vp9',
    '--disable-demuxers',
    '--enable-demuxer=mov',
    '--disable-encoders',
    '--enable-encoder=mjpeg',
    '--disable-filters',
    '--enable-filter=scale',
    '--disable-muxers',
    '--enable-muxer=image2',
    '--disable-parsers',
    '--enable-parser=av1',
    '--enable-parser=h264',
    '--enable-parser=hevc',
    '--enable-parser=mjpeg',
    '--enable-parser=mpeg4video',
    '--enable-parser=mpegvideo',
    '--enable-parser=vp8',
    '--enable-parser=vp9',
    '--disable-protocols',
    '--enable-protocol=file',
    '--enable-protocol=pipe',
];

const buildConfigureArgs = (): string[] =>
    process.platform === 'win32' ? [...CONFIGURE_ARGS, '--extra-ldflags=-static'] : CONFIGURE_ARGS;

const buildEnvironment = (): NodeJS.ProcessEnv =>
    process.platform === 'darwin' ? { ...process.env, MACOSX_DEPLOYMENT_TARGET: '11.0' } : process.env;

const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

const assertArchive = (archive: string): void => {
    if (sha256(fs.readFileSync(archive)) !== FFMPEG_ARCHIVE_SHA256) {
        throw new Error(`FFmpeg source archive checksum does not match ${FFMPEG_REVISION}`);
    }
};

const downloadSourceArchive = async (): Promise<Buffer> => {
    const response = await fetch(FFMPEG_ARCHIVE_URL, { redirect: 'error' });
    if (!response.ok) throw new Error(`FFmpeg source download failed with HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
};

/** Reads a verified cache entry or downloads and verifies the fixed upstream source. */
const ensureSourceArchive = async (): Promise<string> => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (fs.existsSync(SOURCE_ARCHIVE)) {
        assertArchive(SOURCE_ARCHIVE);
        return SOURCE_ARCHIVE;
    }
    const downloaded = await downloadSourceArchive();
    if (sha256(downloaded) !== FFMPEG_ARCHIVE_SHA256) {
        throw new Error(`Downloaded FFmpeg source checksum does not match ${FFMPEG_REVISION}`);
    }
    const temporary = `${SOURCE_ARCHIVE}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, downloaded, { mode: 0o600 });
        assertArchive(temporary);
        fs.renameSync(temporary, SOURCE_ARCHIVE);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
    return SOURCE_ARCHIVE;
};

const sourceTree = (directory: string): string => {
    const source = path.join(directory, 'ffmpeg');
    const encryptionInfo = fs.readFileSync(path.join(source, 'libavutil', 'encryption_info.c'), 'utf8');
    const mov = fs.readFileSync(path.join(source, 'libavformat', 'mov.c'), 'utf8');
    if (
        !encryptionInfo.includes('void av_encryption_init_info_free') ||
        !encryptionInfo.includes('while (info)') ||
        !mov.includes('av_encryption_init_info_append_side_data')
    ) {
        throw new Error('Pinned FFmpeg source lacks the required encryption metadata fixes');
    }
    return source;
};

const buildDecoder = (archive: string): string => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gurushots-ffmpeg-build-'));
    try {
        execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: 'inherit' });
        const source = sourceTree(work);
        const configure = path.join(source, 'configure');
        const configureArgs = buildConfigureArgs();
        const env = buildEnvironment();
        if (process.platform === 'win32') {
            execFileSync('bash', [configure, ...configureArgs], { cwd: source, env, stdio: 'inherit' });
        } else execFileSync(configure, configureArgs, { cwd: source, env, stdio: 'inherit' });
        execFileSync('make', ['-j', String(Math.max(1, os.cpus().length))], { cwd: source, env, stdio: 'inherit' });
        const binary = path.join(source, DECODER_NAME);
        if (!fs.existsSync(binary)) throw new Error('FFmpeg build did not produce the decoder executable');
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        fs.copyFileSync(binary, path.join(OUTPUT_DIR, DECODER_NAME));
        if (process.platform !== 'win32') fs.chmodSync(path.join(OUTPUT_DIR, DECODER_NAME), 0o755);
        fs.copyFileSync(path.join(source, 'COPYING.LGPLv2.1'), path.join(OUTPUT_DIR, 'LICENSE.txt'));
        fs.copyFileSync(archive, path.join(OUTPUT_DIR, `ffmpeg-${FFMPEG_REVISION}.tar.gz`));
        fs.writeFileSync(
            path.join(OUTPUT_DIR, 'BUILD_CONFIG.txt'),
            `${configureArgs.join('\n')}\n${process.platform === 'darwin' ? 'MACOSX_DEPLOYMENT_TARGET=11.0\n' : ''}`,
        );
        const manifest = {
            binary: DECODER_NAME,
            binarySha256: sha256(fs.readFileSync(path.join(OUTPUT_DIR, DECODER_NAME))),
            buildConfig: configureArgs,
            macosDeploymentTarget: process.platform === 'darwin' ? '11.0' : null,
            license: 'LGPL-2.1-or-later',
            sourceArchive: `ffmpeg-${FFMPEG_REVISION}.tar.gz`,
            sourceRevision: FFMPEG_REVISION,
            sourceSha256: FFMPEG_ARCHIVE_SHA256,
            target: `${process.platform}-${process.arch}`,
        };
        fs.writeFileSync(path.join(OUTPUT_DIR, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        return OUTPUT_DIR;
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
};

/** Builds the native, separate LGPL decoder for this runner's platform and CPU. */
const prepareVideoDecoder = async (): Promise<string> => buildDecoder(await ensureSourceArchive());

/** Stages only this native target's complete decoder distribution for Electron. */
const stageElectronVideoDecoder = async (target: string): Promise<string> => {
    const built = `${process.platform}-${process.arch}`;
    if (target !== built) throw new Error(`Cannot package ${built} decoder for ${target}`);
    const decoder = await prepareVideoDecoder();
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(decoder, 'MANIFEST.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null || !('target' in manifest) || manifest.target !== target) {
        throw new Error(`Built decoder manifest does not match ${target}`);
    }
    fs.rmSync(ELECTRON_STAGE_DIR, { recursive: true, force: true });
    fs.cpSync(decoder, ELECTRON_STAGE_DIR, { recursive: true });
    return ELECTRON_STAGE_DIR;
};

const main = async (): Promise<void> => {
    const stage = process.argv.slice(2).find((argument) => argument.startsWith('--stage'));
    if (stage) {
        const target = stage.includes('=') ? stage.slice('--stage='.length) : `${process.platform}-${process.arch}`;
        if (!target) throw new Error('Decoder stage target is required');
        const output = await stageElectronVideoDecoder(target);
        console.log(`Staged video decoder: ${output}`);
        return;
    }
    const output = await prepareVideoDecoder();
    console.log(`Built video decoder: ${output}`);
};

runIfMain(require.main, module, main);

export {
    CONFIGURE_ARGS,
    DECODER_NAME,
    FFMPEG_ARCHIVE_SHA256,
    FFMPEG_ARCHIVE_URL,
    FFMPEG_REVISION,
    SOURCE_ARCHIVE,
    OUTPUT_DIR,
    ELECTRON_STAGE_DIR,
    buildConfigureArgs,
    buildEnvironment,
    assertArchive,
    downloadSourceArchive,
    ensureSourceArchive,
    buildDecoder,
    main,
    prepareVideoDecoder,
    stageElectronVideoDecoder,
};
