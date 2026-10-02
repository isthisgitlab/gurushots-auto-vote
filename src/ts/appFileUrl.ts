import { appPath } from './appPaths';

/**
 * Whether a `file:` URL addresses one of the app's own pages — a file below
 * `src/html` in the app root, which is where every window loads its HTML from.
 * The navigation guard (index/navigationGuard.ts) lets a window stay on such a
 * URL and refuses every other one, so a dropped or linked local document can
 * not replace a window that has the preload's `window.api`.
 *
 * `platform` selects the path flavour the URL is parsed and compared in:
 * win32 compares case-insensitively and rejects another drive or a UNC share
 * (a `\\host\share` path comes back from `path.win32.relative` as absolute).
 * Non-file and unparsable URLs are not app files.
 *
 * `node:url` and `node:path` are required on call, like in appPaths.ts.
 *
 * @param url - the URL a window is about to navigate to
 * @param platform - the platform whose path rules apply; defaults to the host's
 */
const isAppFileUrl = (url: string, platform: NodeJS.Platform = process.platform): boolean => {
    const windows = platform === 'win32';
    const path = (require('node:path') as typeof import('node:path'))[windows ? 'win32' : 'posix'];
    const { fileURLToPath } = require('node:url') as typeof import('node:url');
    let filePath: string;
    try {
        filePath = fileURLToPath(url, { windows });
    } catch {
        return false;
    }
    const rel = path.relative(appPath('src', 'html'), filePath);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

export { isAppFileUrl };
