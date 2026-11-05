/**
 * The WebView fetch of one runtime asset: the reader the webview and headless
 * families' assets members share (the guarded form of the loaders'
 * loadViaFetch, thirdPartyNotices.ts and services/semantic/assets.ts). The
 * assets are served from the webDir (dist/), so the relative URL resolves
 * against the WebView document; a fetch without a response, or one that is
 * not ok, rejects.
 */

const fetchAsset = async (relativePath: string): Promise<string> => {
    // Relative URL resolves against the WebView document served from the webDir.
    const res = await fetch(relativePath);
    if (!res || !res.ok) throw new Error(`fetch ${relativePath}: HTTP ${res ? res.status : 'no response'}`);
    return res.text();
};

export { fetchAsset };
