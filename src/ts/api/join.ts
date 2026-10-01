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
 * The actual join is submit_to_challenge (see ./submissions.ts). A free join is
 * submit-only; a paid join is coinsUnlock THEN submitToChallenge.
 *
 * SECURITY: every dynamic value is encodeURIComponent'd into the form body (a
 * bare `&`/`=` would otherwise inject extra form fields), and this module never
 * logs the headers object — log redaction is a key allowlist, so it only guards
 * the header names it lists.
 */

import { makePostRequest } from './api-client';
import { ENDPOINTS, createWebHeaders, makeRequireValue } from './constants';

import type {
    ActionResult,
    Bankroll,
    BankrollResponse,
    Challenge,
    MemberChallengesResponse,
    SuccessResponse,
} from '../types/gurushots';

const requireValue = makeRequireValue('join');

/**
 * Lists challenges the member has NOT joined yet.
 *
 * @param filter server-side filter (the web app uses 'open')
 * @returns the challenge items, or [] on failure
 */
const getMemberChallenges = async (token: string, filter: string = 'open'): Promise<Challenge[]> => {
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `filter=${encodeURIComponent(filter)}`;
    const response = await makePostRequest<MemberChallengesResponse>(ENDPOINTS.getMemberChallenges, headers, data);
    if (!response || !Array.isArray(response.items)) {
        return [];
    }
    return response.items;
};

/**
 * Unlocks a paid challenge by spending COINS. This DEDUCTS the challenge's
 * join_coins from the account and is NOT known to be idempotent — callers must
 * guard against calling it twice for the same challenge (see
 * services/joinChallenges.ts: in-flight lock + persisted unlock marker).
 */
const coinsUnlock = async (
    challengeId: string | number,
    token: string,
    usage: string = 'JOIN_CHALLENGE',
): Promise<ActionResult> => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = [`challenge_id=${encodeURIComponent(String(challengeId))}`, `usage=${encodeURIComponent(usage)}`].join(
        '&',
    );
    const response = await makePostRequest<SuccessResponse>(ENDPOINTS.coinsUnlock, headers, data);
    if (!response) {
        return { ok: false, raw: null };
    }
    return { ok: response.success === true, raw: response };
};

// Map the API's currency `type` tokens to our normalized field names.
const BANKROLL_FIELDS: Record<string, keyof Bankroll> = {
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
 *   null on transport failure or an unsuccessful/malformed payload (callers must
 *   distinguish this from a genuine zero balance).
 */
const getBankroll = async (token: string): Promise<Bankroll | null> => {
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const response = await makePostRequest<BankrollResponse>(ENDPOINTS.getBankroll, headers, '');
    if (!response || response.success !== true) {
        return null;
    }
    const entries = response.bankroll?.challenges;
    if (!Array.isArray(entries)) {
        return null;
    }
    const balances: Bankroll = { keys: 0, swaps: 0, fills: 0, coins: 0 };
    for (const entry of entries) {
        const field = BANKROLL_FIELDS[entry?.type ?? ''];
        if (field) {
            const amount = Number(entry?.amount);
            balances[field] = Number.isFinite(amount) ? amount : 0;
        }
    }
    return balances;
};

export { getMemberChallenges, coinsUnlock, getBankroll };
