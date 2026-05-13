#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const appName = 'gurushots-auto-vote';
const userData =
    {
        darwin: path.join(os.homedir(), 'Library', 'Application Support', appName),
        win32: path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName),
    }[process.platform] ?? path.join(os.homedir(), '.config', appName);

const logsDir = path.join(userData, 'logs');
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
