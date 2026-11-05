/**
 * The two small limiters the relay link is built on: a token bucket (the send budget and the
 * decrypt cap) and a seen-set whose entries expire (the replay memory). Both read an injected
 * clock in milliseconds, so tests drive them without timers. Dependency-free.
 */

export type TokenBucket = {
    /** Takes one token if there is one. */
    tryTake: () => boolean;
    /** Milliseconds until a token is available (0 when one is). */
    msUntilToken: () => number;
};

/** A bucket that refills `perSecond` tokens a second up to `burst`, starting full. */
export const createTokenBucket = (perSecond: number, burst: number, now: () => number): TokenBucket => {
    let tokens = burst;
    let refilledAt = now();
    const refill = (): void => {
        const at = now();
        tokens = Math.min(burst, tokens + ((at - refilledAt) * perSecond) / 1000);
        refilledAt = at;
    };
    return {
        tryTake: () => {
            refill();
            if (tokens < 1) return false;
            tokens -= 1;
            return true;
        },
        msUntilToken: () => {
            refill();
            return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * 1000) / perSecond);
        },
    };
};

export type SeenSet = {
    has: (key: string) => boolean;
    add: (key: string) => void;
    /** Forgets a key at once (it is then not a replay); a key that is not held is ignored. */
    delete: (key: string) => void;
};

/**
 * A set whose entries are forgotten `ttlMs` after they were added, and which holds at most
 * `maxEntries`: past that the oldest is dropped. Entries expire in insertion order, so pruning
 * stops at the first live one.
 */
export const createSeenSet = (ttlMs: number, now: () => number, maxEntries = Infinity): SeenSet => {
    const expiries = new Map<string, number>();
    const prune = (): void => {
        const at = now();
        for (const [key, expiry] of expiries) {
            if (expiry > at) return;
            expiries.delete(key);
        }
    };
    return {
        has: (key) => {
            prune();
            return expiries.has(key);
        },
        add: (key) => {
            prune();
            expiries.delete(key);
            expiries.set(key, now() + ttlMs);
            if (expiries.size > maxEntries) expiries.delete(expiries.keys().next().value as string);
        },
        delete: (key) => {
            expiries.delete(key);
        },
    };
};
