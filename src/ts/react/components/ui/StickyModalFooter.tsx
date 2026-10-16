import type { ComponentChildren } from 'preact';

// The modal hosting the footer must put this on its `.modal-box` (via Modal's
// `className`): the opaque footer covers the bottom of the scroll area, and the
// scroll padding keeps a focused control scrolled above it. On phones the
// footer is at its tallest, about 13.2rem (the settings row's buttons wrapped
// onto two rows and a multi-line Latvian save-error alert at 320px), so 15rem.
// The `md:` value assumes a `size="2xl"` or `size="xl"` host, whose box is
// 91.67% of the viewport: about 704px at 768px (a classic scrollbar takes ~15px
// off). There the buttons and the Latvian save-error alert each fit one line
// and the footer is about 7rem, so 8rem. Each includes room for the focus ring.
// A larger Android system font scale can still outgrow the phone value.
export const STICKY_FOOTER_SCROLL_PADDING = 'scroll-pb-60 md:scroll-pb-32';

/**
 * A footer pinned to the bottom of a modal's scroll area (the settings modals' action row, the photo
 * pickers' Submit / Save): render it as the last child of the modal content. The negative margins cancel the
 * modal box's padding so the bar sits flush with the box edges and the opaque background hides the content
 * scrolling underneath. The hosting modal passes STICKY_FOOTER_SCROLL_PADDING as the Modal's className so
 * focus scrolling keeps controls above the footer.
 */
export function StickyModalFooter({ children }: { children?: ComponentChildren }) {
    return (
        <div className="sticky -bottom-6 z-10 -mx-6 -mb-6 px-6 py-4 bg-base-100 border-t border-base-300 space-y-2">
            {children}
        </div>
    );
}
