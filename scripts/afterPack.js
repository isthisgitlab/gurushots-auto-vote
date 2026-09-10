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

const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
    const { appOutDir, packager, electronPlatformName } = context;
    const productName = packager.appInfo.productFilename;
    const isMac = electronPlatformName === 'darwin' || electronPlatformName === 'mas';

    let electronBinary;
    if (isMac) {
        electronBinary = path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName);
    } else if (electronPlatformName === 'win32') {
        electronBinary = path.join(appOutDir, `${productName}.exe`);
    } else {
        electronBinary = path.join(appOutDir, productName);
    }

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
