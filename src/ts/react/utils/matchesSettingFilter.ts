// Text compared without case and without accents: NFD splits "ā" into "a" plus a combining mark, which is dropped.
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/**
 * Whether a settings filter matches: true when any of the texts contains the query, compared without case and
 * accents (so "a" finds "ā"), or when the query is blank. The query is only ever searched for as text, never built
 * into a pattern.
 */
export function matchesSettingFilter(texts: readonly string[], query: string): boolean {
    const needle = fold(query.trim());
    return needle === '' || texts.some((text) => fold(text).includes(needle));
}
