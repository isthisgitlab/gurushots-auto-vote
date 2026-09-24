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
 *      it only catches gross regressions (e.g. a wrong-arch copy or a doubled
 *      embedded model), not small code changes.
 *
 * Both checks are skipped (not failed) when the artifact is absent, so the
 * script is safe to run before any build. In CI it runs after build:cli, where
 * the artifacts exist and the budgets are enforced. Tighten the budgets below
 * once the real CI sizes are known.
 */

const fs = require('node:fs');
const path = require('node:path');
const { runIfMain } = require('./lib/run-if-main');

const ROOT = path.join(__dirname, '..');
const BUNDLE_PATH = path.join(ROOT, 'dist', 'cli-bundled.js');
const CLI_BUILD_DIR = path.join(ROOT, 'build', 'cli');

// Guardrail budgets. Generous on purpose — these catch packaging mistakes, not
// incremental growth. Revisit when actual CI sizes are established.
const MAX_BUNDLE_MB = 5; // dist/cli-bundled.js (our code, unminified)
const MAX_BINARY_MB = 600; // Node with exported N-API symbols + embedded local vision runtime/model

const MB = 1024 * 1024;
const fmt = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

function check(label, filePath, maxMb, tally) {
    if (!fs.existsSync(filePath)) {
        return false;
    }
    tally.checked += 1;
    const bytes = fs.statSync(filePath).size;
    const overBudget = bytes > maxMb * MB;
    const status = overBudget ? '❌ OVER' : '✅ ok';
    console.log(`${status}  ${label}: ${fmt(bytes)} (budget ${maxMb} MB)`);
    if (overBudget) {
        tally.failed += 1;
    }
    return true;
}

function main({ bundlePath = BUNDLE_PATH, cliBuildDir = CLI_BUILD_DIR } = {}) {
    const tally = { checked: 0, failed: 0 };

    console.log('📏 CLI size guard');

    check('dist/cli-bundled.js', bundlePath, MAX_BUNDLE_MB, tally);

    if (fs.existsSync(cliBuildDir)) {
        const binaries = fs.readdirSync(cliBuildDir).filter((name) => name.startsWith('gurucli-'));
        for (const name of binaries) {
            check(`build/cli/${name}`, path.join(cliBuildDir, name), MAX_BINARY_MB, tally);
        }
    }

    if (tally.checked === 0) {
        console.log('ℹ️  No CLI artifacts found — run a CLI build first (e.g. pnpm build:cli:mac). Nothing to check.');
        process.exit(0);
        return;
    }

    if (tally.failed > 0) {
        console.error(`\n❌ ${tally.failed} CLI artifact(s) over budget.`);
        process.exit(1);
        return;
    }

    console.log(`\n🎉 All ${tally.checked} CLI artifact(s) within budget.`);
}

runIfMain(require.main, module, main);

module.exports = { check, main, MAX_BUNDLE_MB, MAX_BINARY_MB };
