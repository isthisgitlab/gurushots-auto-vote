/**
 * Whether a currency-spend result calls for a refresh: the spend went through,
 * or the server reports it is no longer possible (the card is stale).
 */
export const spentOrStale = (result: { success?: boolean; outcome?: string } | null | undefined): boolean =>
    Boolean(result?.success || result?.outcome === 'not-available');
