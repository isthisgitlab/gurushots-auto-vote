/**
 * electron-builder config for the lite desktop build (`build:<os>:lite`): the
 * package.json `build` block without the local vision model and its inference
 * runtime (services/visionVerifier.js), for users who don't want either.
 * visionVerifier sees no bundled model and keeps the tag order.
 *
 * Lite artifacts carry a "-lite" suffix, land in build/lite/, and publish
 * their own update files (lite*.yml) so electron-updater keeps a lite install
 * on lite. services/AutoUpdater.js limits lite to stable releases: on a
 * prerelease the GitHub provider would fall back to latest*.yml, the full build.
 */

const { build } = require('../package.json');

// @huggingface/transformers and the native runtimes it loads (the full build
// already leaves out onnxruntime-web).
const VISION_PACKAGES = ['@huggingface', 'onnxruntime-node', 'onnxruntime-common', 'sharp', '@img'];

// "…-${arch}.${ext}" → "…-${arch}-lite.${ext}" (also for a literal ".exe"/".AppImage").
const liteArtifact = (artifactName) => artifactName.replace(/(\.[^.]+)$/, '-lite$1');

module.exports = {
    ...build,
    files: [...build.files, ...VISION_PACKAGES.map((name) => `!**/node_modules/${name}\${/*}`)],
    extraResources: [],
    asarUnpack: [],
    directories: { ...build.directories, output: 'build/lite' },
    mac: { ...build.mac, artifactName: liteArtifact(build.mac.artifactName) },
    win: { ...build.win, artifactName: liteArtifact(build.win.artifactName) },
    linux: { ...build.linux, artifactName: liteArtifact(build.linux.artifactName) },
    publish: { ...build.publish, channel: 'lite' },
};
