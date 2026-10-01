/**
 * src/ts/appPaths.ts — the app's own files are addressed from the app root,
 * the directory holding package.json.
 */

import type * as appPathsModule from '../src/ts/appPaths';
jest.unmock('path');

const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
const path = jest.requireActual<typeof import('node:path')>('node:path');
const { appPath } = require('../src/ts/appPaths') as typeof appPathsModule;

test('resolves below the app root', () => {
    expect(appPath()).toBe(path.resolve(__dirname, '..'));
    expect(fs.existsSync(appPath('package.json'))).toBe(true);
    expect(fs.existsSync(appPath('src', 'html', 'app.html'))).toBe(true);
});
