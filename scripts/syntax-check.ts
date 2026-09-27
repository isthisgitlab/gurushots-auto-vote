#!/usr/bin/env node

/**
 * Node.js Syntax Check Script
 *
 * Runs `node --check` on every CommonJS .js file in the project by WALKING
 * scripts and tests — an explicit exclude list below removes what is not Node
 * CommonJS. src/js is TypeScript, so oxlint, esbuild, swc and tsc parse it
 * instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runIfMain } from './lib/run-if-main';

// Colors for console output (failure output only)
const colors = {
    red: '\x1b[31m',
    reset: '\x1b[0m',
    bold: '\x1b[1m',
};

// Roots to walk for .js files.
const includeDirs = ['scripts', 'tests'];

// Excluded paths (relative, forward-slash): code `node --check` cannot parse as
// CommonJS.
const excludePaths = [
    'scripts/site/', // static-site sources, not Node CJS
];

type SyntaxCheckResult = { success: true } | { success: false; error: string };

// What execFileSync throws on a non-zero exit: an Error carrying the child's
// captured stderr (stdio: 'pipe').
type ExecFileError = Error & { stderr?: Buffer };

/**
 * Recursively get all .js files in a directory
 */
function getJsFiles(dir: string): string[] {
    const files: string[] = [];

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
function shouldExclude(filePath: string): boolean {
    const normalized = filePath.split(path.sep).join('/');
    return excludePaths.some((excluded) => normalized === excluded || normalized.startsWith(excluded));
}

/**
 * Run syntax check on a single file. execFileSync (no shell) so the path
 * is passed as an argument, never interpolated into a command string.
 */
function checkFileSyntax(filePath: string): SyntaxCheckResult {
    try {
        execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
        return { success: true };
    } catch (error) {
        const execError = error as ExecFileError;
        return {
            success: false,
            error: execError.stderr ? execError.stderr.toString() : execError.message,
        };
    }
}

/**
 * Main execution. `dirs` defaults to the project roots; tests pass temp dirs.
 */
function main(dirs: string[] = includeDirs) {
    const filesToCheck: string[] = [];
    for (const dir of dirs) {
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

runIfMain(require.main, module, main);

export { main, checkFileSyntax, getJsFiles, shouldExclude };
