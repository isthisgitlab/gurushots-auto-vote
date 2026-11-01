/**
 * The desktop's pairing store: the one `remote-access.json` file in userData that holds
 * `{enabled, key}` for the remote-access feature. It is deliberately not part of `config.json`,
 * so no settings channel, export or profile can read the pairing key or switch the feature.
 *
 * The key is 32 random bytes in base64url, made once and kept until "Reset pairing" replaces
 * it. The pairing link is `<pages origin>/remote/#k=<key>` — a dev-only launcher argument
 * (`--remote-link-origin=<origin>`, ignored in a packaged build) points it at a local site
 * build for end-to-end checks. The key and the link are never logged and never sent over the
 * peer connection; the QR code is made here in the main process as a `data:image/svg+xml`
 * URL for an `<img>`.
 */

import * as crypto from 'node:crypto';
import qrcode from 'qrcode-generator';

import { createJsonStore } from '../../../core/settings/storage';
import { REMOTE_PAGES_ORIGIN, REMOTE_PAGES_PATH } from '../../../core/remote/relays';

import type { ThroughResult } from '../../../core/types/stores';

/** The stored shape of `remote-access.json`. */
export type RemoteAccessState = {
    enabled: boolean;
    /** The permanent pairing key: 32 random bytes in base64url. */
    key: string;
};

interface RemotePairingDeps {
    /** Whether this build is packaged: true ignores the dev-only link-origin argument. */
    isPackaged: () => boolean;
    /** The process arguments the dev-only link origin is read from. */
    argv: readonly string[];
    /** Warns about an ignored dev argument; the logger is injected so tests pass a spy. */
    warn: (message: string) => void;
}

export type RemotePairing = {
    /** The stored state, with a key made on first use. */
    state: () => RemoteAccessState;
    /** Switch the feature on or off. */
    setEnabled: (enabled: boolean) => boolean;
    /** Replace the key, so every paired phone must scan again; answers the new one. */
    resetKey: () => string;
    /** `{enabled, link, qrDataUrl}` for the get-remote-access channel. */
    accessInfo: () => { enabled: boolean; link: string; qrDataUrl: string };
};

const KEY_BYTES = 32;

/** The QR's cell size in the SVG's user units; the `<img>` scales it. */
const QR_CELL_SIZE = 4;
const QR_MARGIN = 2;

const isRemoteAccessState = (value: unknown): value is RemoteAccessState =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as RemoteAccessState).enabled === 'boolean' &&
    typeof (value as RemoteAccessState).key === 'string' &&
    (value as RemoteAccessState).key.length > 0;

const newKey = (): string => crypto.randomBytes(KEY_BYTES).toString('base64url');

/**
 * The dev-only pairing-link origin: `--remote-link-origin=<origin>` points the QR link at a
 * local site build for end-to-end checks. In a packaged build the argument is ignored with a
 * log line — it is a development aid, not configuration.
 */
const readDevLinkOrigin = (deps: RemotePairingDeps): string | null => {
    const given = deps.argv.find((arg) => arg.startsWith('--remote-link-origin='));
    if (given === undefined) return null;
    const origin = given.slice('--remote-link-origin='.length).trim();
    if (deps.isPackaged()) {
        deps.warn('Ignoring --remote-link-origin in a packaged build; the pairing link uses the published pages.');
        return null;
    }
    return origin.length > 0 ? origin : null;
};

const createRemotePairing = (deps: RemotePairingDeps): RemotePairing => {
    const store = createJsonStore({ fileName: 'remote-access.json', prefKey: 'gs_remote_access', atomic: true });
    const devLinkOrigin = readDevLinkOrigin(deps);

    /** The stored state a raw text holds, or null when there is none it can be read as. */
    const parseState = (raw: string | null): RemoteAccessState | null => {
        if (raw === null) return null;
        try {
            const parsed: unknown = JSON.parse(raw);
            return isRemoteAccessState(parsed) ? parsed : null;
        } catch {
            return null;
        }
    };

    const readState = (): RemoteAccessState => {
        const stored = parseState(store.readRaw());
        if (stored !== null) return stored;
        // First use (or a file the wipe left half of): make the key once and keep it.
        const fresh: RemoteAccessState = { enabled: false, key: newKey() };
        store.writeRaw(JSON.stringify(fresh));
        return fresh;
    };

    const linkFor = (key: string): string => `${devLinkOrigin ?? REMOTE_PAGES_ORIGIN}${REMOTE_PAGES_PATH}#k=${key}`;

    const qrDataUrlFor = (link: string): string => {
        const qr = qrcode(0, 'M');
        qr.addData(link);
        qr.make();
        const svg = qr.createSvgTag({ cellSize: QR_CELL_SIZE, margin: QR_MARGIN, scalable: true });
        return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    };

    return {
        state: readState,
        setEnabled: (enabled) => {
            const result: ThroughResult | null = store.updateNow((raw) => {
                const current = parseState(raw);
                const next: RemoteAccessState = current !== null ? { ...current, enabled } : { enabled, key: newKey() };
                return JSON.stringify(next);
            });
            return result === 'saved';
        },
        resetKey: () => {
            const key = newKey();
            store.updateNow((raw) => {
                const enabled = parseState(raw)?.enabled ?? false;
                return JSON.stringify({ enabled, key } satisfies RemoteAccessState);
            });
            return key;
        },
        accessInfo: () => {
            const { enabled, key } = readState();
            const link = linkFor(key);
            return { enabled, link, qrDataUrl: qrDataUrlFor(link) };
        },
    };
};

export { createRemotePairing, isRemoteAccessState, newKey };
