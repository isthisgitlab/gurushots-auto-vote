/**
 * Whether a currency-spend result calls for a refresh: the spend went through,
 * the server reports it is no longer possible (the card is stale), or the
 * challenge was refused as data-incomplete (the refusal is worded, the card
 * reloads).
 */
export const spentOrStale = (result: { success?: boolean; outcome?: string } | null | undefined): boolean =>
    Boolean(result?.success || result?.outcome === 'not-available' || result?.outcome === 'data-incomplete');

/**
 * Whether a refused swap named a photo the entry list already holds: the card on screen is stale (it still offers
 * that photo), but nothing was spent, so a dialog stays open for another pick.
 */
export const alreadyEntered = (result: { success?: boolean; outcome?: string } | null | undefined): boolean =>
    result?.success !== true && result?.outcome === 'already-entered';
