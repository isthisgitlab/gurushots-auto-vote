/**
 * The member payloads: identity and profile, the photo library and its
 * per-photo records, the currency balances, and the missions.
 */

import type { UnixSeconds } from './base';

/** rest_mobile/signup. */
export interface LoginResponse {
    token?: string;
}

/** get_bankroll, raw. */
export interface BankrollResponse {
    success?: boolean;
    bankroll?: { challenges?: Array<{ type?: string; amount?: number | string } | null> };
}

/** The account's currency balances, normalized from get_bankroll. */
export interface Bankroll {
    keys: number;
    swaps: number;
    fills: number;
    coins: number;
}

/** One photo of the member's library (get_photos_private items). */
export interface LibraryPhoto {
    id: string;
    labels?: string[];
    /** Always 0 on the live endpoint; get_image_data carries the real count. */
    votes?: number;
    views?: number;
    upload_date?: UnixSeconds;
    permission?: { allowed?: boolean; message?: string | null };
}

/** get_photos_private. */
export interface PhotosPrivateResponse {
    items?: LibraryPhoto[];
}

/** get_image_data `data`: the per-photo popularity record. */
export interface ImageRecord {
    id?: string;
    votes?: number;
    views?: number;
    likes?: number;
    /** The Guru-picks COUNT, not a list. */
    guru_picks?: number;
    /** Only the count is read; the entries' own shape is not relied on. */
    achievements?: unknown[];
}

/** get_image_data. */
export interface ImageDataResponse {
    success?: boolean;
    data?: ImageRecord;
}

/** get_current_member_profile. */
export interface CurrentMemberProfileResponse {
    profile?: { id?: string; user_name?: string };
}

/** The signed-in member's identity, resolved from the session token. */
export interface MemberIdentity {
    id: string;
    userName: string;
}

/** search_autocomplete. Entries are untrusted and filtered down to strings. */
export interface SearchAutocompleteResponse {
    items?: unknown[];
}

/** A mission from get_my_missions; claim_state 'CLAIM' once completed and unclaimed. */
export interface Mission {
    id: number | string;
    name?: string;
    description?: string;
    claim_state?: string;
    /** Unix seconds the mission expires. */
    expiration_timestamp?: UnixSeconds;
    progress?: { current?: number; required?: number };
    prizes?: Array<{ type?: string; amount?: number }>;
}

/** get_my_missions. */
export interface MissionsResponse {
    list?: Mission[];
}
