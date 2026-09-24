const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { runIfMain } = require('./lib/run-if-main');

const ROOT = path.join(__dirname, '..');
const MODEL_DIR = path.join(ROOT, '.cache', 'vision-model');
const REPOS = {
    model: 'onnx-community/siglip-base-patch16-224-ONNX/9f0328bdd0eb4f62d0f6c10625f43d882b32102b',
    tokenizer: 'google/siglip-base-patch16-224/7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed',
};
const FILES = [
    ['model', 'config.json', 'e97dd7d219a4689bbbe90ef767ce757cee99b99879d9d62010bdb1fa6620592a'],
    ['model', 'preprocessor_config.json', 'bec6ca696ddd6c2050ce0ea9fcb7581b052d267059a3341b6c1456cab54b1d07'],
    ['model', 'onnx/model_quantized.onnx', '6f4f2d66dac783d6a72204961df627789fc559c98ab76f8ea36c4f6b1ba89058'],
    ['tokenizer', 'tokenizer.json', 'c6e405cb7c670d56636a9402c81023a55bc6c3c53d89cf02b92f5c5005bfe920'],
    ['tokenizer', 'tokenizer_config.json', 'd6423dae508cc3a129d22ea443841c111832a1a73125b8f25ea8736951698bcb'],
    ['tokenizer', 'special_tokens_map.json', '2b6a1ff67a27e0df9ac0c7d93250fc0d87431c7b366b3d5669217104f9088a26'],
    ['tokenizer', 'spiece.model', '1e5036bed065526c3c212dfbe288752391797c4bb1a284aa18c9a0b23fcaf8ec'],
];

const hashFile = (file) =>
    new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const input = fs.createReadStream(file);
        input.on('data', (chunk) => hash.update(chunk));
        input.on('error', reject);
        input.on('end', () => resolve(hash.digest('hex')));
    });

// Tests inject a sandbox directory, a stubbed fetch, and fixture pins.
const ensureVisionModel = async ({ modelDir = MODEL_DIR, fetchImpl = fetch, files = FILES } = {}) => {
    for (const [source, name, expected] of files) {
        const target = path.join(modelDir, name);
        if (fs.existsSync(target) && (await hashFile(target)) === expected) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const [owner, repo, revision] = REPOS[source].split('/');
        const response = await fetchImpl(`https://huggingface.co/${owner}/${repo}/resolve/${revision}/${name}`);
        if (!response.ok || !response.body)
            throw new Error(`Vision model download failed: ${name} (HTTP ${response.status})`);
        const temporary = `${target}.${process.pid}.tmp`;
        try {
            await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
            if ((await hashFile(temporary)) !== expected) throw new Error(`Vision model checksum mismatch: ${name}`);
            fs.renameSync(temporary, target);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
    }
    return modelDir;
};

const stageVisionWebAssets = async (distDir, options) => {
    const modelDir = await ensureVisionModel(options);
    // dist/ is also the Android webDir. Remove CLI outputs from older builds.
    for (const name of ['vision-runtime.tar.gz', 'vision-runtime.sha256', 'sea-prep.blob', 'sea-config.json']) {
        fs.rmSync(path.join(distDir, name), { force: true });
    }
    fs.cpSync(modelDir, path.join(distDir, 'vision-model'), { recursive: true });
    const transformersEntry = require.resolve('@huggingface/transformers');
    const ortEntry = require.resolve('onnxruntime-web/webgpu', { paths: [path.dirname(transformersEntry)] });
    const wasmAssets = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
    for (const name of fs.readdirSync(distDir)) {
        if (name.startsWith('ort-wasm-simd-threaded.') && !wasmAssets.includes(name)) {
            fs.rmSync(path.join(distDir, name), { force: true });
        }
    }
    for (const name of wasmAssets) {
        fs.copyFileSync(path.join(path.dirname(ortEntry), name), path.join(distDir, name));
    }
};

const main = () =>
    ensureVisionModel().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

runIfMain(require.main, module, main);

module.exports = { FILES, MODEL_DIR, ensureVisionModel, stageVisionWebAssets, main };
