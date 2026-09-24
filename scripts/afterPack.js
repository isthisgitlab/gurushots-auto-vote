/**
 * electron-builder afterPack hook — hardens the packaged Electron binary's fuses.
 *
 * By default a packaged Electron app ships with RunAsNode (and the Node CLI /
 * NODE_OPTIONS escape hatches) enabled, so anyone with local execution access can
 * run it as a plain Node interpreter:
 *
 *     ELECTRON_RUN_AS_NODE=1 /path/to/GuruShotsAutoVote arbitrary.js
 *
 * — a well-known local-code-execution-under-the-app's-identity technique that sits
 * orthogonally to the renderer's contextIsolation/sandbox hardening. We flip the
 * relevant fuses off at pack time. On macOS the app is ad-hoc signed (no Developer
 * ID), and flipping fuses invalidates that signature, so we re-apply the ad-hoc
 * signature via resetAdHocDarwinSignature.
 *
 * Note: EmbeddedAsarIntegrityValidation is deliberately left un-flipped — it is
 * macOS-only and requires electron-builder's asar-integrity wiring to be exactly
 * right or the app fails to launch; OnlyLoadAppFromAsar already blocks loading a
 * swapped-in unpacked app dir (asar:true is the electron-builder default here).
 */

const fs = require('fs');
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/**
 * onnxruntime-node (local image inference, services/visionVerifier.js) ships
 * prebuilt binaries for every OS and CPU — 30–130 MB that this package can
 * never load. They sit in app.asar.unpacked (see asarUnpack), so they are plain
 * files here. A per-platform electron-builder `files` exclusion can't do this:
 * a platform list holding only negations makes electron-builder fall back to
 * packing the whole repository.
 */
// electron-builder's Arch enum (builder-util) → onnxruntime's directory names.
// Anything else (universal) keeps every architecture.
const ONNX_ARCH_DIRS = Object.freeze({ 1: 'x64', 3: 'arm64' });

const pruneForeignOnnxBinaries = (resourcesDir, targetOs, targetArch) => {
    const binRoot = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin');
    if (!fs.existsSync(binRoot)) return;
    const remove = (target) => fs.rmSync(target, { recursive: true, force: true });
    for (const napi of fs.readdirSync(binRoot)) {
        for (const os of fs.readdirSync(path.join(binRoot, napi))) {
            const osDir = path.join(binRoot, napi, os);
            if (os !== targetOs) {
                remove(osDir);
                continue;
            }
            if (!targetArch) continue;
            for (const cpu of fs.readdirSync(osDir)) if (cpu !== targetArch) remove(path.join(osDir, cpu));
        }
    }
};

exports.default = async function afterPack(context) {
    const { appOutDir, packager, electronPlatformName, arch } = context;
    const productName = packager.appInfo.productFilename;
    const isMac = electronPlatformName === 'darwin' || electronPlatformName === 'mas';

    let electronBinary;
    if (isMac) {
        electronBinary = path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName);
    } else if (electronPlatformName === 'win32') {
        electronBinary = path.join(appOutDir, `${productName}.exe`);
    } else {
        // Linux: electron-builder names the executable after the packager's
        // executableName — appInfo.sanitizedName.toLowerCase() derived from
        // package.json "name" ("gurushots-auto-vote"), NOT productFilename
        // ("GuruShotsAutoVote"). Mirror app-builder-lib's own resolution
        // (platformPackager: `this instanceof LinuxPackager ? this.executableName
        // : productFilename`); using productName here would ENOENT and fail the
        // whole Linux/Linux-ARM build.
        electronBinary = path.join(appOutDir, packager.executableName);
    }

    // Before the fuse flip, whose ad-hoc re-sign must cover the final tree.
    pruneForeignOnnxBinaries(
        isMac ? path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources') : path.join(appOutDir, 'resources'),
        isMac ? 'darwin' : electronPlatformName,
        ONNX_ARCH_DIRS[arch],
    );

    await flipFuses(electronBinary, {
        version: FuseVersion.V1,
        // Re-apply the ad-hoc macOS signature that flipping fuses invalidates.
        resetAdHocDarwinSignature: isMac,
        // The core of the finding: no running the app as a bare Node interpreter.
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        // Encrypt the cookie store at rest (harmless; no downside for this app).
        [FuseV1Options.EnableCookieEncryption]: true,
        // Refuse to load an app dir swapped in beside the asar.
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });

    console.log(`[afterPack] Hardened Electron fuses for ${electronPlatformName}: ${electronBinary}`);
};
