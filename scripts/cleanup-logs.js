#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
// The shared resolver, so this script targets the same userData dir as the
// app (the -dev dir when run from source, where the logs actually live).
const runtime = require('../src/js/runtime');
const { runIfMain } = require('./lib/run-if-main');

// Deletes the legacy api-debug-* files from `logsDir` (defaults to the
// userData logs dir). Exported so tests can point it at a temp dir; the
// deletion runs only when the file is executed directly.
function cleanupLogs(logsDir = path.join(runtime.getAppUserDataPath(), 'logs')) {
    if (!fs.existsSync(logsDir)) {
        console.log(`No logs directory at ${logsDir}`);
        return;
    }

    let count = 0;
    let bytes = 0;
    for (const file of fs.readdirSync(logsDir)) {
        if (!file.startsWith('api-debug-')) continue;
        const filePath = path.join(logsDir, file);
        bytes += fs.statSync(filePath).size;
        fs.unlinkSync(filePath);
        count++;
    }

    console.log(
        `Deleted ${count} legacy api-debug-* file(s) (${(bytes / 1024 / 1024).toFixed(2)} MB) from ${logsDir}.`,
    );
}

runIfMain(require.main, module, cleanupLogs);

module.exports = { cleanupLogs };
