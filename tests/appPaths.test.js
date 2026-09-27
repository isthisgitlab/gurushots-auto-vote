/**
 * src/js/appPaths.ts — the app's own files are addressed from the app root,
 * the directory holding package.json.
 */
jest.unmock('path');

const fs = jest.requireActual('node:fs');
const path = jest.requireActual('node:path');
const { appPath } = require('../src/js/appPaths');

test('resolves below the app root', () => {
    expect(appPath()).toBe(path.resolve(__dirname, '..'));
    expect(fs.existsSync(appPath('package.json'))).toBe(true);
    expect(fs.existsSync(appPath('src', 'html', 'app.html'))).toBe(true);
});
