// The shared tests/setup.ts mocks path and fs globally; this suite stages a real temp tree.
jest.unmock('node:path');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('fs');

import fs = require('node:fs');
import os = require('node:os');
import nodePath = require('node:path');
import { buildRemoteSite } from '../../scripts/build-site';

describe('the current remote page tree', () => {
    let tmp: string;
    let out: string;
    let dist: string;
    let logSpy: jest.SpiedFunction<typeof console.log>;

    const write = (rel: string, body: string): void => {
        const full = nodePath.join(tmp, rel);
        fs.mkdirSync(nodePath.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    };
    const read = (...parts: string[]): string => fs.readFileSync(nodePath.join(out, 'remote', ...parts), 'utf8');
    const listing = (): string[] => fs.readdirSync(nodePath.join(out, 'remote')).sort();

    const seedDist = (): void => {
        write(nodePath.join('dist', 'remote-loader.html'), '<!doctype html><title>launcher</title>');
        write(nodePath.join('dist', 'remoteLoader-bundle.js'), '// launcher');
        write(nodePath.join('dist', 'styles.css'), 'body{}');
        write(nodePath.join('dist', 'THIRD_PARTY_NOTICES.txt'), 'root-notices');
        write(nodePath.join('dist', 'remote', 'v2', 'index.html'), '<html>current</html>');
        write(nodePath.join('dist', 'remote', 'v2', 'remote-bundle.js'), '// current page');
        write(nodePath.join('dist', 'remote', 'v2', 'styles.css'), 'staged-css');
        write(nodePath.join('dist', 'remote', 'v2', 'THIRD_PARTY_NOTICES.txt'), 'page-notices');
    };

    beforeEach(() => {
        tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'build-site-remote-'));
        out = nodePath.join(tmp, 'dist-site');
        dist = nodePath.join(tmp, 'dist');
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('stages only the current launcher, stylesheet, notices, and v2 page', () => {
        seedDist();

        buildRemoteSite(out, dist);

        expect(listing()).toEqual([
            'THIRD_PARTY_NOTICES.txt',
            'index.html',
            'remoteLoader-bundle.js',
            'styles.css',
            'v2',
        ]);
        expect(read('index.html')).toContain('launcher');
        expect(read('remoteLoader-bundle.js')).toBe('// launcher');
        expect(read('styles.css')).toBe('body{}');
        expect(read('THIRD_PARTY_NOTICES.txt')).toBe('root-notices');
        expect(read('v2', 'index.html')).toBe('<html>current</html>');
        expect(read('v2', 'remote-bundle.js')).toBe('// current page');
        expect(read('v2', 'styles.css')).toBe('body{}');
        expect(read('v2', 'THIRD_PARTY_NOTICES.txt')).toBe('page-notices');
    });

    test('removes stale older-version output before staging v2', () => {
        seedDist();
        write(nodePath.join('dist-site', 'remote', 'v1', 'index.html'), '<html>stale</html>');
        write(nodePath.join('dist-site', 'remote', 'v99', 'index.html'), '<html>stale</html>');

        buildRemoteSite(out, dist);

        expect(listing()).toEqual([
            'THIRD_PARTY_NOTICES.txt',
            'index.html',
            'remoteLoader-bundle.js',
            'styles.css',
            'v2',
        ]);
        expect(fs.existsSync(nodePath.join(out, 'remote', 'v1'))).toBe(false);
        expect(fs.existsSync(nodePath.join(out, 'remote', 'v99'))).toBe(false);
    });

    test('never fetches a release archive', () => {
        seedDist();
        const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));

        try {
            buildRemoteSite(out, dist);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
    });

    test('does not stage a launcher when its bundle is absent', () => {
        write(nodePath.join('dist', 'remote-loader.html'), '<!doctype html><title>launcher</title>');

        buildRemoteSite(out, dist);

        expect(fs.existsSync(nodePath.join(out, 'remote'))).toBe(false);
        expect(logSpy).toHaveBeenCalledWith('⏭️  remote/ launcher: build:react has not produced it yet');
    });

    test('stages a launcher without notices when the current build has none', () => {
        write(nodePath.join('dist', 'remote-loader.html'), '<!doctype html><title>launcher</title>');
        write(nodePath.join('dist', 'remoteLoader-bundle.js'), '// launcher');

        buildRemoteSite(out, dist);

        expect(listing()).toEqual(['index.html', 'remoteLoader-bundle.js']);
        expect(fs.existsSync(nodePath.join(out, 'remote', 'THIRD_PARTY_NOTICES.txt'))).toBe(false);
    });

    test('stages the root stylesheet without a current page', () => {
        write(nodePath.join('dist', 'styles.css'), 'body{}');

        buildRemoteSite(out, dist);

        expect(listing()).toEqual(['styles.css']);
        expect(read('styles.css')).toBe('body{}');
        expect(fs.existsSync(nodePath.join(out, 'remote', 'v2'))).toBe(false);
        expect(logSpy).toHaveBeenCalledWith('⏭️  remote/v2/: build:react has not staged it yet');
    });

    test('leaves no remote output when the local build has produced no current assets', () => {
        buildRemoteSite(out, dist);

        expect(fs.existsSync(nodePath.join(out, 'remote'))).toBe(false);
        expect(logSpy).toHaveBeenCalledWith('⏭️  remote/ launcher: build:react has not produced it yet');
        expect(logSpy).toHaveBeenCalledWith('⏭️  remote/v2/: build:react has not staged it yet');
        expect(logSpy).toHaveBeenCalledWith('⏭️  remote/styles.css: build:css has not produced it yet');
    });
});
