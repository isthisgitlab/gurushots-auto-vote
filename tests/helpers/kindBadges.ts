/**
 * The ghost badges of a challenge's kind (🏁 type or badge, 🖼 photo count) and its tags look the same
 * (`badge badge-ghost`); the kind ones lead with their icon.
 */

const KIND_ICON = /^[🏁🖼]/u;

export const isKindBadgeText = (text: string): boolean => KIND_ICON.test(text);
