#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
// The shared resolver — this script previously hand-rolled the userData
// path a third way (and always targeted the non-dev dir even when run
// from source, where the logs actually live under the -dev dir).
const runtime = require('../src/js/runtime');

const logsDir = path.join(runtime.getAppUserDataPath(), 'logs');
if (!fs.existsSync(logsDir)) {
    console.log(`No logs directory at ${logsDir}`);
    process.exit(0);
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

console.log(`Deleted ${count} legacy api-debug-* file(s) (${(bytes / 1024 / 1024).toFixed(2)} MB) from ${logsDir}.`);
