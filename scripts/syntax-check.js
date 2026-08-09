#!/usr/bin/env node

/**
 * Node.js Syntax Check Script
 *
 * Runs `node --check` on every CommonJS .js file in the project by WALKING
 * src/js, scripts, and tests — an explicit exclude list below removes the
 * ES-module/JSX islands. (The previous allowlist silently covered fewer
 * than half of src/js's directories and referenced files that no longer
 * exist.)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Colors for console output (failure output only)
const colors = {
    red: '\x1b[31m',
    reset: '\x1b[0m',
    bold: '\x1b[1m',
};

// Roots to walk for .js files.
const includeDirs = ['src/js', 'scripts', 'tests'];

// Excluded paths (relative, forward-slash): ESM/JSX islands and Electron
// entry points the check has always skipped.
const excludePaths = [
    'src/js/index.js', // Electron main process
    'src/js/preload.js', // Electron preload
    'src/js/react/', // renderer tree — ESM/JSX, checked by eslint + esbuild
    'scripts/site/', // static-site sources, not Node CJS
];

/**
 * Recursively get all .js files in a directory
 */
function getJsFiles(dir) {
    const files = [];

    if (!fs.existsSync(dir)) {
        return files;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            files.push(...getJsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(fullPath);
        }
    }

    return files;
}

/**
 * Check if a file should be excluded
 */
function shouldExclude(filePath) {
    const normalized = filePath.split(path.sep).join('/');
    return excludePaths.some((excluded) => normalized === excluded || normalized.startsWith(excluded));
}

/**
 * Run syntax check on a single file. execFileSync (no shell) so the path
 * is passed as an argument, never interpolated into a command string.
 */
function checkFileSyntax(filePath) {
    try {
        execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error.stderr ? error.stderr.toString() : error.message,
        };
    }
}

/**
 * Main execution
 */
function main() {
    const filesToCheck = [];
    for (const dir of includeDirs) {
        filesToCheck.push(...getJsFiles(dir).filter((file) => !shouldExclude(file)));
    }

    const uniqueFiles = [...new Set(filesToCheck)].sort();

    let failCount = 0;

    for (const filePath of uniqueFiles) {
        const result = checkFileSyntax(filePath);

        if (!result.success) {
            console.log(`${colors.red}✗${colors.reset} ${filePath}`);
            console.log(`  ${colors.red}${result.error.trim()}${colors.reset}`);
            failCount++;
        }
    }

    if (failCount > 0) {
        console.log(`\n${colors.bold}${colors.red}${failCount} syntax error(s) found:${colors.reset}`);
        process.exit(1);
    }

    // Silent success
    process.exit(0);
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { main, checkFileSyntax, getJsFiles };
