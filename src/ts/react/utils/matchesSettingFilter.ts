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

/**
 * The texts a piece of the modal is found by: the labels the user can see, and the descriptions
 * searched only when no name matched anywhere.
 */
export type SettingFilterTexts = { names: readonly string[]; descriptions: readonly string[] };

/**
 * Whether one piece of the modal matches the settings filter `query`.
 *
 * `namesOnly`: the query matched a name somewhere in the modal, so descriptions are not searched.
 */
export function matchesFilterTexts(texts: SettingFilterTexts, query: string, namesOnly: boolean): boolean {
    return matchesSettingFilter(texts.names, query) || (!namesOnly && matchesSettingFilter(texts.descriptions, query));
}
