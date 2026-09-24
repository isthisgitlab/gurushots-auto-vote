/**
 * Tests for scripts/fetch-vision-model.js — the pinned model download and the
 * WebView asset staging. Hermetic: fetch is stubbed, pins are hashes of tiny
 * fixtures, and every write lands in an os.tmpdir() sandbox, so the real
 * .cache/vision-model and dist/ are never touched.
 */

// tests/setup.js globally mocks fs and path; this suite needs the real modules.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
    FILES,
    MODEL_DIR,
    ensureVisionModel,
    removeVisionWebAssets,
    stageVisionWebAssets,
    main,
} = require('../../scripts/fetch-vision-model');

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const okResponse = (text) => ({ ok: true, status: 200, body: new Response(text).body });

describe('scripts/fetch-vision-model.js', () => {
    let directory;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-model-'));
    });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('pins every model and tokenizer file by sha256 under the repository cache', () => {
        expect(MODEL_DIR).toBe(path.join(__dirname, '..', '..', '.cache', 'vision-model'));
        expect(FILES.map(([, name]) => name)).toContain('onnx/model_quantized.onnx');
        for (const [source, , digest] of FILES) {
            expect(['model', 'tokenizer']).toContain(source);
            expect(digest).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    test('downloads missing files from the pinned revision and skips verified ones', async () => {
        const files = [
            ['model', 'onnx/model.onnx', sha('weights')],
            ['tokenizer', 'tokenizer.json', sha('vocab')],
        ];
        fs.writeFileSync(path.join(directory, 'tokenizer.json'), 'vocab');
        const fetchImpl = jest.fn(async () => okResponse('weights'));

        expect(await ensureVisionModel({ modelDir: directory, fetchImpl, files })).toBe(directory);
        expect(fetchImpl.mock.calls).toEqual([
            [
                'https://huggingface.co/onnx-community/siglip-base-patch16-224-ONNX/resolve/9f0328bdd0eb4f62d0f6c10625f43d882b32102b/onnx/model.onnx',
            ],
        ]);
        expect(fs.readFileSync(path.join(directory, 'onnx', 'model.onnx'), 'utf8')).toBe('weights');

        await ensureVisionModel({ modelDir: directory, fetchImpl, files });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('re-downloads a cached file whose hash no longer matches', async () => {
        const files = [['tokenizer', 'spiece.model', sha('fresh')]];
        fs.writeFileSync(path.join(directory, 'spiece.model'), 'stale');
        const fetchImpl = jest.fn(async () => okResponse('fresh'));
        await ensureVisionModel({ modelDir: directory, fetchImpl, files });
        expect(fetchImpl.mock.calls[0][0]).toBe(
            'https://huggingface.co/google/siglip-base-patch16-224/resolve/7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed/spiece.model',
        );
        expect(fs.readFileSync(path.join(directory, 'spiece.model'), 'utf8')).toBe('fresh');
    });

    test.each([
        ['an HTTP error', { ok: false, status: 404, body: null }, 'HTTP 404'],
        ['an empty body', { ok: true, status: 200, body: null }, 'HTTP 200'],
    ])('%s fails the download without writing the file', async (_name, response, detail) => {
        const files = [['model', 'config.json', sha('{}')]];
        await expect(
            ensureVisionModel({ modelDir: directory, fetchImpl: async () => response, files }),
        ).rejects.toThrow(`Vision model download failed: config.json (${detail})`);
        expect(fs.readdirSync(directory)).toEqual([]);
    });

    test('a checksum mismatch rejects the download and removes the partial file', async () => {
        const files = [['model', 'config.json', sha('expected')]];
        await expect(
            ensureVisionModel({ modelDir: directory, fetchImpl: async () => okResponse('tampered'), files }),
        ).rejects.toThrow('Vision model checksum mismatch: config.json');
        expect(fs.readdirSync(directory)).toEqual([]);
    });

    test('stages the model and only the single-threaded WASM runtime into dist', async () => {
        const modelDir = path.join(directory, 'model');
        const distDir = path.join(directory, 'dist');
        fs.mkdirSync(modelDir);
        fs.writeFileSync(path.join(modelDir, 'config.json'), '{}');
        fs.mkdirSync(distDir);
        for (const stale of ['vision-runtime.tar.gz', 'sea-prep.blob', 'ort-wasm-simd-threaded.jsep.wasm', 'app.js']) {
            fs.writeFileSync(path.join(distDir, stale), 'x');
        }

        await stageVisionWebAssets(distDir, { modelDir, files: [] });

        expect(fs.readdirSync(distDir).sort()).toEqual([
            'app.js',
            'ort-wasm-simd-threaded.asyncify.mjs',
            'ort-wasm-simd-threaded.asyncify.wasm',
            'vision-model',
        ]);
        expect(fs.readFileSync(path.join(distDir, 'vision-model', 'config.json'), 'utf8')).toBe('{}');
    });

    test('a lite build clears the model and WASM runtime a full build left in dist', () => {
        const distDir = path.join(directory, 'dist');
        fs.mkdirSync(path.join(distDir, 'vision-model'), { recursive: true });
        fs.writeFileSync(path.join(distDir, 'vision-model', 'config.json'), '{}');
        for (const name of ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs', 'app.js']) {
            fs.writeFileSync(path.join(distDir, name), 'x');
        }

        removeVisionWebAssets(distDir);

        expect(fs.readdirSync(distDir)).toEqual(['app.js']);
    });

    test('main reports a failed fetch through the exit code', async () => {
        const originalExitCode = process.exitCode;
        const error = new Error('offline');
        jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
        jest.spyOn(globalThis, 'fetch').mockRejectedValue(error);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await main();
            expect(errorSpy).toHaveBeenCalledWith(error);
            expect(process.exitCode).toBe(1);
        } finally {
            process.exitCode = originalExitCode;
        }
    });
});
