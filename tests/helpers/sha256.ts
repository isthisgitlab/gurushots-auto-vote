/** The SHA-256 hex digest of a text, for tests that pin a derived name. */
export const sha256Hex = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
