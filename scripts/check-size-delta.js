#!/usr/bin/env node
/**
 * Renderer bundle size gate — DELTA based, not an absolute ceiling.
 *
 * size-limit fails whenever total size crosses a fixed number, so any organic
 * growth forces a limit bump to an arbitrary round value. What we actually want
 * to catch is a *jump*: a single change that adds a lot (e.g. accidentally
 * pulling zod / a heavy dep into a bundle, ~60 kB), while letting a few kB of
 * real feature growth through without ceremony.
 *
 * This compares each bundle's current brotli size against a committed baseline
 * (`.size-baseline.json`) and FAILS only when a bundle grew by more than the
 * threshold (default 5 kB) since that baseline. When growth is intentional you
 * refresh the baseline with `--update` (or `pnpm size:update`) and commit the
 * new numbers — the diff shows exactly how much each bundle moved.
 *
 * Brotli sizing is done here with zlib at quality 11 so the baseline and the
 * check are always measured the same way (self-consistent, even if the absolute
 * number differs slightly from size-limit's).
 *
 * Usage:
 *   node scripts/check-size-delta.js            # check (exit 1 on a too-big jump)
 *   node scripts/check-size-delta.js --update   # rewrite the baseline to current
 *   SIZE_DELTA_KB=8 node scripts/check-size-delta.js   # override the threshold
 *
 * Assumes the bundles are already built (the `size` npm script runs build:react
 * first).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, '.size-baseline.json');

// The renderer/service bundles produced by scripts/build-react.js.
const BUNDLES = [
    { name: 'app', path: 'dist/app-bundle.js', label: 'app (Electron renderer)' },
    { name: 'login', path: 'dist/login-bundle.js', label: 'login (Electron renderer)' },
    { name: 'logs', path: 'dist/logs-bundle.js', label: 'logs (Electron renderer)' },
    { name: 'capacitor', path: 'dist/capacitor-bundle.js', label: 'capacitor (Android WebView)' },
    { name: 'headless', path: 'dist/headless-bundle.js', label: 'headless (Android background service)' },
    { name: 'preload', path: 'dist/preload-bundle.js', label: 'preload (Electron sandboxed preload)' },
];

const THRESHOLD_KB = Number.parseFloat(process.env.SIZE_DELTA_KB || '5');
const THRESHOLD_BYTES = Math.round(THRESHOLD_KB * 1024);

const UPDATE = process.argv.includes('--update');

const kb = (bytes) => `${(bytes / 1024).toFixed(2)} kB`;
const signedKb = (bytes) => `${bytes >= 0 ? '+' : ''}${(bytes / 1024).toFixed(2)} kB`;

const brotliSize = (filePath) => {
    const buf = fs.readFileSync(filePath);
    const compressed = zlib.brotliCompressSync(buf, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    });
    return compressed.length;
};

const readBaseline = () => {
    try {
        const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

const main = () => {
    const baseline = readBaseline();
    const measured = {};
    const rows = [];
    let failed = false;
    let missingBaseline = false;

    for (const bundle of BUNDLES) {
        const abs = path.join(ROOT, bundle.path);
        if (!fs.existsSync(abs)) {
            console.error(
                `✗ ${bundle.label}: bundle not found at ${bundle.path} — build first (pnpm run build:react).`,
            );
            failed = true;
            continue;
        }
        const current = brotliSize(abs);
        measured[bundle.name] = current;

        const base = baseline[bundle.name];
        if (typeof base !== 'number') {
            rows.push({ bundle, current, base: null, delta: null });
            missingBaseline = true;
            continue;
        }
        const delta = current - base;
        rows.push({ bundle, current, base, delta });
        if (!UPDATE && delta > THRESHOLD_BYTES) {
            failed = true;
        }
    }

    // Report table.
    console.log(`\nBundle size delta (threshold: +${THRESHOLD_KB} kB per bundle vs baseline)\n`);
    for (const row of rows) {
        const { bundle, current, base, delta } = row;
        if (base === null) {
            console.log(`  • ${bundle.label.padEnd(38)} ${kb(current).padStart(10)}   (no baseline)`);
            continue;
        }
        const flag = delta > THRESHOLD_BYTES ? '  ✗ JUMP' : delta < 0 ? '  ↓' : '';
        console.log(
            `  • ${bundle.label.padEnd(38)} ${kb(current).padStart(10)}   ${signedKb(delta).padStart(10)}${flag}`,
        );
    }
    console.log('');

    if (UPDATE) {
        const next = { ...baseline, ...measured };
        fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 4)}\n`, 'utf8');
        console.log(`✔ Baseline updated (${BASELINE_PATH}). Commit it so the new sizes are the reference.`);
        process.exit(failed ? 1 : 0); // failed here only means a bundle was missing
    }

    if (missingBaseline) {
        console.error(
            '✗ One or more bundles have no baseline entry. Run `pnpm size:update` and commit .size-baseline.json.',
        );
        process.exit(1);
    }

    if (failed) {
        console.error(
            `✗ A bundle grew by more than +${THRESHOLD_KB} kB. If that's an accidental heavy import, fix it; if the\n` +
                '  growth is intentional, run `pnpm size:update` and commit the new .size-baseline.json.',
        );
        process.exit(1);
    }

    console.log('✔ All bundles within +' + THRESHOLD_KB + ' kB of baseline.');
    process.exit(0);
};

main();
