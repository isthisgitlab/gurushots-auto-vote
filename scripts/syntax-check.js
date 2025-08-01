#!/usr/bin/env node

/**
 * Node.js Syntax Check Script
 * 
 * This script runs 'node -c' (syntax check) on all appropriate JavaScript files
 * in the project. It handles both Node.js and mixed environments by:
 * 
 * - Including: CLI files, API files, services, utilities, tests, build scripts
 * - Excluding: Electron main process files, preload scripts, files with ES6 imports
 * - Providing clear feedback on syntax errors
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Colors for console output
const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m',
    bold: '\x1b[1m',
};

// Files to exclude from syntax checking (Electron-specific or problematic)
const excludeFiles = [
    'src/js/index.js',           // Electron main process
    'src/js/preload.js',         // Electron preload
    'src/js/app.js',             // Uses ES6 imports
];

// Directories to include for syntax checking
const includeDirs = [
    'src/js/api',
    'src/js/cli',
    'src/js/services',
    'src/js/strategies',
    'src/js/mock',
    'src/js/translations',
    'src/js/interfaces',
    'scripts',
    'tests',
];

// Individual files to include
const includeFiles = [
    'src/js/apiFactory.js',
    'src/js/logger.js', 
    'src/js/login.js',
    'src/js/metadata.js',
    'src/js/settings.js',
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
    return excludeFiles.some(excluded => filePath.includes(excluded.replace(/\//g, path.sep)));
}

/**
 * Run syntax check on a single file
 */
function checkFileSyntax(filePath) {
    try {
        execSync(`node -c "${filePath}"`, { stdio: 'pipe' });
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
    // Collect all files to check
    const filesToCheck = [];
    
    // Add files from included directories
    for (const dir of includeDirs) {
        const dirFiles = getJsFiles(dir);
        filesToCheck.push(...dirFiles.filter(file => !shouldExclude(file)));
    }
    
    // Add individual files
    for (const file of includeFiles) {
        if (fs.existsSync(file) && !shouldExclude(file)) {
            filesToCheck.push(file);
        }
    }
    
    // Remove duplicates and sort
    const uniqueFiles = [...new Set(filesToCheck)].sort();
    
    let failCount = 0;
    const failures = [];
    
    // Check each file
    for (const filePath of uniqueFiles) {
        const result = checkFileSyntax(filePath);
        
        if (!result.success) {
            console.log(`${colors.red}✗${colors.reset} ${filePath}`);
            console.log(`  ${colors.red}${result.error.trim()}${colors.reset}`);
            failures.push({ file: filePath, error: result.error.trim() });
            failCount++;
        }
    }
    
    // Only output if there are errors
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