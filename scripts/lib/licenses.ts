/**
 * Vendored license texts (`scripts/licenses/texts/<id>.txt`) and the notice
 * that travels with the SigLIP vision model. Shared by the notices generator
 * and the model download, which writes the same LICENSE and NOTICE next to the
 * model files it fetches.
 */

import fs from 'node:fs';
import path from 'node:path';

const TEXTS_DIR = path.join(__dirname, '..', 'licenses', 'texts');

/** A vendored license text without its trailing whitespace. */
const readLicenseText = (id: string, textsDir = TEXTS_DIR) =>
    fs.readFileSync(path.join(textsDir, `${id}.txt`), 'utf8').replace(/\s+$/, '');

/** Hugging Face repositories as `owner/repo/revision`, keyed by what they provide. */
interface VisionModelRepos {
    model: string;
    tokenizer: string;
}

const repoUrl = (ownerRepoRevision: string) => {
    const [owner, repo, revision] = ownerRepoRevision.split('/');
    return { url: `https://huggingface.co/${owner}/${repo}`, name: `${owner}/${repo}`, revision };
};

/**
 * The NOTICE for the vision model: where each file comes from, the license it is
 * under, and that the ONNX weights are a quantized conversion of the original.
 */
const visionModelNotice = (repos: VisionModelRepos) => {
    const model = repoUrl(repos.model);
    const tokenizer = repoUrl(repos.tokenizer);
    return [
        'SigLIP vision model — NOTICE',
        '',
        'These files are the SigLIP base model (patch 16, 224 px) and its tokenizer, used for the',
        'optional on-device photo check. SigLIP is Copyright Google LLC, released under the Apache',
        'License, Version 2.0 (see the LICENSE shipped with the model files).',
        '',
        `Tokenizer files: ${tokenizer.name}, revision ${tokenizer.revision}`,
        `  ${tokenizer.url}`,
        '  Unmodified copies of the original files.',
        '',
        `Model files: ${model.name}, revision ${model.revision}`,
        `  ${model.url}`,
        '  onnx/model_quantized.onnx is a quantized (8-bit) ONNX conversion of the original SigLIP',
        '  weights, made by the onnx-community project. It is a modified derivative of the original',
        '  model, not the original file. config.json and preprocessor_config.json are the',
        '  configuration files published with that conversion.',
        '',
    ].join('\n');
};

export { readLicenseText, visionModelNotice };
