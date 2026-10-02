/** Fatal-exit and SHA-256 helpers shared across the pipeline. */

import fs from 'node:fs';
import crypto from 'node:crypto';

export const fail: (lines: string | Array<string>) => never = (lines) => {
    console.error(`❌ ${Array.isArray(lines) ? lines.join('\n   ') : lines}`);
    process.exit(1);
};

export const sha256OfFile = (filePath: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(filePath)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });

export const sha256OfString = (str: string): string => crypto.createHash('sha256').update(str).digest('hex');
