/**
 * Which account the process's per-account memory belongs to. The caches that hold something an account
 * read (the upcoming-challenge list, the photo-library listing) key it by a hash of the token and compare
 * the generation before and after an await, so a read that began under an account that has since left
 * never writes anything.
 */

/** A short non-cryptographic digest (cyrb53): it only keeps the raw token out of a map key. */
const tokenKey = (token: string): string => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < token.length; i += 1) {
        const code = token.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

// Bumped whenever the account's memory is forgotten (logout, account switch): a request that
// began before it belongs to the account that left, and must not write anything afterwards.
let generation = 0;

/** Which account's memory is current; compare before and after an await to see it was forgotten meanwhile. */
const accountGeneration = (): number => generation;

/** Marks the account's memory as forgotten: every request that began earlier now belongs to a past account. */
const bumpAccountGeneration = (): void => {
    generation += 1;
};

export { tokenKey, accountGeneration, bumpAccountGeneration };
