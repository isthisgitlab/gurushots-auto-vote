/**
 * What the computer paints now, as the paired phone's bridge knows it: the last presentation projection a host event or answer
 * carried (theme, language, availability and its revision). The phone paints its own four view preferences and never these;
 * this is for a panel that inspects the host. The peer bridge (shells/remote) installs the source, and the renderer reads it
 * here: react may not import a shell, and the host's `window.api` has no such call. Dependency-free.
 */

/** The host's presentation as its last projection said. */
export type HostPresentation = {
    revision: number;
    available: boolean;
    theme: string | null;
    language: string | null;
};

let source: (() => HostPresentation | null) | null = null;

/** Called by the peer bridge once; `null` removes it. */
export const setHostPresentationSource = (next: (() => HostPresentation | null) | null): void => {
    source = next;
};

/** The host's presentation, or null where this page has no host bridge (every shell but the phone) or none arrived yet. */
export const readHostPresentation = (): HostPresentation | null => source?.() ?? null;
