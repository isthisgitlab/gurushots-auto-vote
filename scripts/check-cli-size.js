#!/usr/bin/env node

/**
 * SEA CLI size guard.
 *
 * size-limit can budget the renderer bundles (see .size-limit.json), but it
 * cannot meaningfully measure the CLI artifacts: the SEA binary is a postject'd
 * Node executable (its size is dominated by the embedded Node runtime, not our
 * code). This script fills that gap with two coarse guardrails:
 *
 *   1. dist/cli-bundled.js — the esbuild bundle of our CLI + shared core. This
 *      is OUR code; a jump here means we pulled in something heavy.
 *   2. build/cli/gurucli-* — the final SEA binaries. The budget here is loose;
 *      it only catches gross regressions (e.g. a skipped `strip`, a wrong-arch
 *      copy, or a doubled binary), not small code changes.
 *
 * Both checks are skipped (not failed) when the artifact is absent, so the
 * script is safe to run before any build. In CI it runs after build:cli, where
 * the artifacts exist and the budgets are enforced. Tighten the budgets below
 * once the real CI sizes are known.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUNDLE_PATH = path.join(ROOT, 'dist', 'cli-bundled.js');
const CLI_BUILD_DIR = path.join(ROOT, 'build', 'cli');

// Guardrail budgets. Generous on purpose — these catch packaging mistakes, not
// incremental growth. Revisit when actual CI sizes are established.
const MAX_BUNDLE_MB = 5; // dist/cli-bundled.js (our code, unminified)
const MAX_BINARY_MB = 150; // each SEA binary (Node runtime + our blob)

const MB = 1024 * 1024;
const fmt = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

let checked = 0;
let failed = 0;

function check(label, filePath, maxMb) {
    if (!fs.existsSync(filePath)) {
        return false;
    }
    checked += 1;
    const bytes = fs.statSync(filePath).size;
    const overBudget = bytes > maxMb * MB;
    const status = overBudget ? '❌ OVER' : '✅ ok';
    console.log(`${status}  ${label}: ${fmt(bytes)} (budget ${maxMb} MB)`);
    if (overBudget) {
        failed += 1;
    }
    return true;
}

console.log('📏 CLI size guard');

check('dist/cli-bundled.js', BUNDLE_PATH, MAX_BUNDLE_MB);

if (fs.existsSync(CLI_BUILD_DIR)) {
    const binaries = fs.readdirSync(CLI_BUILD_DIR).filter((name) => name.startsWith('gurucli-'));
    for (const name of binaries) {
        check(`build/cli/${name}`, path.join(CLI_BUILD_DIR, name), MAX_BINARY_MB);
    }
}

if (checked === 0) {
    console.log('ℹ️  No CLI artifacts found — run a CLI build first (e.g. pnpm build:cli:mac). Nothing to check.');
    process.exit(0);
}

if (failed > 0) {
    console.error(`\n❌ ${failed} CLI artifact(s) over budget.`);
    process.exit(1);
}

console.log(`\n🎉 All ${checked} CLI artifact(s) within budget.`);
