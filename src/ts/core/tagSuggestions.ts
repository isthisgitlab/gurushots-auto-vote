/**
 * The picker's tag suggestions, one logic for the GUI search box and the CLI
 * `list-photos --search`: of the tags the search-photo-tags handler answers
 * (the library's tags that CONTAIN the term), the ones shown as one-click
 * exact searches. Dependency-free so the renderer bundle can use it.
 */

// Most tag suggestions shown, whatever the endpoint answered.
const MAX_TAG_SUGGESTIONS = 8;

/**
 * The tags to offer for a typed term: every tag that is not the term itself
 * (trimmed, case-insensitively — pressing it would re-run the search already
 * typed), in the order given, at most MAX_TAG_SUGGESTIONS.
 */
const suggestedTags = (tags: readonly string[], term: string): string[] => {
    const trimmed = term.trim().toLowerCase();
    return tags.filter((tag) => tag.toLowerCase() !== trimmed).slice(0, MAX_TAG_SUGGESTIONS);
};

export { MAX_TAG_SUGGESTIONS, suggestedTags };
