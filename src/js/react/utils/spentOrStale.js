/**
 * Whether a currency-spend result calls for a refresh: the spend went through,
 * or the server reports it is no longer possible (the card is stale).
 *
 * @param {{success?: boolean, outcome?: string}|null|undefined} result
 * @returns {boolean}
 */
export const spentOrStale = (result) => Boolean(result?.success || result?.outcome === 'not-available');
