// The current remote-access site tree. The local renderer build stages the only supported phone
// page at /remote/v2/; /remote/ carries its launcher and shared current assets.

import fs from 'node:fs';
import path from 'node:path';
import { LINK_VERSION } from '../../src/ts/core/remote/protocol';
import { NOTICES_ASSET_NAME } from '../../src/ts/core/thirdPartyNotices';

const distDir = path.join(__dirname, '..', '..', 'dist');

const copyLoader = (remoteOut: string, dist: string): void => {
    const loaderHtml = path.join(dist, 'remote-loader.html');
    const loaderBundle = path.join(dist, 'remoteLoader-bundle.js');
    if (fs.existsSync(loaderHtml) && fs.existsSync(loaderBundle)) {
        fs.mkdirSync(remoteOut, { recursive: true });
        fs.copyFileSync(loaderHtml, path.join(remoteOut, 'index.html'));
        fs.copyFileSync(loaderBundle, path.join(remoteOut, 'remoteLoader-bundle.js'));
        const notices = path.join(dist, NOTICES_ASSET_NAME);
        if (fs.existsSync(notices)) fs.copyFileSync(notices, path.join(remoteOut, NOTICES_ASSET_NAME));
        console.log('✓ remote/index.html (the /remote/ launcher)');
    } else {
        console.log('⏭️  remote/ launcher: build:react has not produced it yet');
    }
};

const copyCurrentPage = (remoteOut: string, dist: string): void => {
    const name = `v${LINK_VERSION}`;
    const localDir = path.join(dist, 'remote', name);
    if (fs.existsSync(localDir)) {
        fs.mkdirSync(remoteOut, { recursive: true });
        fs.cpSync(localDir, path.join(remoteOut, name), { recursive: true });
        console.log(`✓ remote/${name}/ (the local build)`);
    } else {
        console.log(`⏭️  remote/${name}/: build:react has not staged it yet`);
    }
};

const copyAppStylesheet = (remoteOut: string, dist: string): void => {
    const appCss = path.join(dist, 'styles.css');
    if (fs.existsSync(appCss)) {
        fs.mkdirSync(remoteOut, { recursive: true });
        fs.copyFileSync(appCss, path.join(remoteOut, 'styles.css'));
        const currentPage = path.join(remoteOut, `v${LINK_VERSION}`);
        if (fs.existsSync(currentPage)) fs.copyFileSync(appCss, path.join(currentPage, 'styles.css'));
        console.log('✓ remote/styles.css (the current launcher and page stylesheet)');
    } else {
        console.log('⏭️  remote/styles.css: build:css has not produced it yet');
    }
};

/** Fills `dist-site/remote/` with the current local launcher and v2 page only. */
const buildRemoteSite = (out: string, dist = distDir): void => {
    const remoteOut = path.join(out, 'remote');
    fs.rmSync(remoteOut, { recursive: true, force: true });
    copyLoader(remoteOut, dist);
    copyCurrentPage(remoteOut, dist);
    copyAppStylesheet(remoteOut, dist);
};

export { buildRemoteSite };
