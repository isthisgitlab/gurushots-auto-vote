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
 * EmbeddedAsarIntegrityValidation is turned on wherever electron-builder embeds
 * the asar header hash: the macOS Info.plist (ElectronAsarIntegrity) and the
 * Windows executable's INTEGRITY resource. Linux carries no hash, so the fuse
 * stays off there. With the fuse on, Electron refuses to start when app.asar was
 * modified after packing; the macOS build also fails here if the plist entry is
 * missing, since a fuse without a hash would make the app unlaunchable.
 * OnlyLoadAppFromAsar additionally blocks loading an unpacked app dir swapped in
 * beside the asar (asar:true is the electron-builder default here).
 */

import fs from 'node:fs';
import path from 'node:path';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import type { AfterPackContext, LinuxPackager } from 'electron-builder';

/**
 * onnxruntime-node (local image inference, services/visionVerifier.ts) ships
 * prebuilt binaries for every OS and CPU — 30–130 MB that this package can
 * never load. They sit in app.asar.unpacked (see asarUnpack), so they are plain
 * files here. A per-platform electron-builder `files` exclusion can't do this:
 * a platform list holding only negations makes electron-builder fall back to
 * packing the whole repository.
 */
// electron-builder's Arch enum (builder-util) → onnxruntime's directory names.
// Anything else (universal) keeps every architecture.
const ONNX_ARCH_DIRS: Readonly<Record<number, string>> = Object.freeze({ 1: 'x64', 3: 'arm64' });

const pruneForeignOnnxBinaries = (resourcesDir: string, targetOs: string, targetArch: string | undefined) => {
    const binRoot = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin');
    if (!fs.existsSync(binRoot)) return;
    const remove = (target: string) => fs.rmSync(target, { recursive: true, force: true });
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

// Throws unless electron-builder wrote the asar header hash into the app's Info.plist.
const assertMacAsarIntegrity = (appBundle: string) => {
    const plist = fs.readFileSync(path.join(appBundle, 'Contents', 'Info.plist'), 'utf8');
    if (!plist.includes('<key>ElectronAsarIntegrity</key>') || !plist.includes('<key>Resources/app.asar</key>')) {
        throw new Error(`${appBundle}: Info.plist has no ElectronAsarIntegrity entry for Resources/app.asar`);
    }
};

export default async function afterPack(context: AfterPackContext) {
    const { appOutDir, packager, electronPlatformName, arch } = context;
    const productName = packager.appInfo.productFilename;
    const isMac = electronPlatformName === 'darwin' || electronPlatformName === 'mas';

    let electronBinary;
    if (isMac) {
        assertMacAsarIntegrity(path.join(appOutDir, `${productName}.app`));
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
        electronBinary = path.join(appOutDir, (packager as LinuxPackager).executableName);
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
        // Refuse to start from an app.asar that no longer matches the embedded header hash.
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: isMac || electronPlatformName === 'win32',
    });

    console.log(`[afterPack] Hardened Electron fuses for ${electronPlatformName}: ${electronBinary}`);
}
