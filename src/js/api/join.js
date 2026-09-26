// @ts-check
/**
 * GuruShots Auto Voter - Join Module
 *
 * Web-API endpoints for the challenge-join flow, captured from a gurushots.com
 * browser session. Uses the same WEB header profile as submissions/turbo
 * (x-env: WEB, x-api-version: 13).
 *
 *   getMemberChallenges - list un-joined ("open") challenges the member can join
 *   coinsUnlock         - spend COINS to unlock a paid challenge for joining
 *   getBankroll         - read the account currency balances
 *
 * The actual join is submit_to_challenge (see ./submissions.js). A free join is
 * submit-only; a paid join is coinsUnlock THEN submitToChallenge.
 *
 * SECURITY: every dynamic value is encodeURIComponent'd into the form body (a
 * bare `&`/`=` would otherwise inject extra form fields), and this module never
 * logs the headers object — log redaction is a key allowlist, so it only guards
 * the header names it lists.
 */

import { makePostRequest } from './api-client';
import { ENDPOINTS, createWebHeaders, makeRequireValue } from './constants';

/**
 * @import { ActionResult, Bankroll, BankrollResponse, Challenge, MemberChallengesResponse, SuccessResponse } from '../types/gurushots'
 */

const requireValue = makeRequireValue('join');

/**
 * Lists challenges the member has NOT joined yet.
 *
 * @param {string} token
 * @param {string} [filter='open'] server-side filter (the web app uses 'open')
 * @returns {Promise<Challenge[]>} the challenge items, or [] on failure
 */
const getMemberChallenges = async (token, filter = 'open') => {
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `filter=${encodeURIComponent(String(filter))}`;
    const response = /** @type {MemberChallengesResponse | null} */ (
        await makePostRequest(ENDPOINTS.getMemberChallenges, headers, data)
    );
    if (!response || !Array.isArray(response.items)) {
        return [];
    }
    return response.items;
};

/**
 * Unlocks a paid challenge by spending COINS. This DEDUCTS the challenge's
 * join_coins from the account and is NOT known to be idempotent — callers must
 * guard against calling it twice for the same challenge (see
 * services/joinChallenges.js: in-flight lock + persisted unlock marker).
 *
 * @param {string|number} challengeId
 * @param {string} token
 * @param {string} [usage='JOIN_CHALLENGE']
 * @returns {Promise<ActionResult>}
 */
const coinsUnlock = async (challengeId, token, usage = 'JOIN_CHALLENGE') => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = [
        `challenge_id=${encodeURIComponent(String(challengeId))}`,
        `usage=${encodeURIComponent(String(usage))}`,
    ].join('&');
    const response = /** @type {SuccessResponse | null} */ (
        await makePostRequest(ENDPOINTS.coinsUnlock, headers, data)
    );
    if (!response) {
        return { ok: false, raw: null };
    }
    return { ok: response.success === true, raw: response };
};

// Map the API's currency `type` tokens to our normalized field names.
/** @type {Record<string, keyof Bankroll>} */
const BANKROLL_FIELDS = {
    KEYS: 'keys',
    SWAPS: 'swaps',
    FILLS: 'fills',
    COINS: 'coins',
};

/**
 * Reads the account bankroll and normalizes it to a flat balance object.
 *
 * The raw payload is `{bankroll:{challenges:[{type,amount},...]}}`. We map only
 * the known currency types and deliberately DO NOT return the raw payload, so an
 * unexpected new field on the upstream response is never forwarded to the
 * renderer/CLI.
 *
 * @param {string} token
 * @returns {Promise<Bankroll|null>}
 *   null on transport failure or an unsuccessful/malformed payload (callers must
 *   distinguish this from a genuine zero balance).
 */
const getBankroll = async (token) => {
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const response = /** @type {BankrollResponse | null} */ (await makePostRequest(ENDPOINTS.getBankroll, headers, ''));
    if (!response || response.success !== true) {
        return null;
    }
    const entries = response.bankroll?.challenges;
    if (!Array.isArray(entries)) {
        return null;
    }
    /** @type {Bankroll} */
    const balances = { keys: 0, swaps: 0, fills: 0, coins: 0 };
    for (const entry of entries) {
        // An absent type looks up the key "undefined", which no currency uses.
        const field = BANKROLL_FIELDS[/** @type {string} */ (entry?.type)];
        if (field) {
            const amount = Number(entry?.amount);
            balances[field] = Number.isFinite(amount) ? amount : 0;
        }
    }
    return balances;
};

export { getMemberChallenges, coinsUnlock, getBankroll };
