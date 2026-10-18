import { ICON_PATHS, StrokeIcon } from './StrokeIcon';

import type { ComponentChildren } from 'preact';

export type Tone = 'info' | 'warning' | 'error';

// One distinct shape per tone, so the tone survives without its colour.
const TONE_ICON: Record<Tone, { d: string; colorClass: string }> = {
    info: { d: ICON_PATHS.info, colorClass: 'text-info' },
    warning: { d: ICON_PATHS.warning, colorClass: 'text-warning' },
    error: { d: ICON_PATHS.xCircle, colorClass: 'text-error' },
};

/**
 * The tone's icon in the tone colour, set inline ahead of the text it belongs to. It is a supplementary cue: the text
 * beside it carries the meaning.
 *
 * @param props.tone - which shape and colour to draw
 */
export function ToneIcon({ tone }: { tone: Tone }) {
    const { d, colorClass } = TONE_ICON[tone];
    return <StrokeIcon d={d} className={`inline-block w-4 h-4 mr-1 align-text-bottom ${colorClass}`} />;
}

/**
 * A note or warning in body-text colour behind a leading tone icon. Coloured text fails 4.5:1 on the light themes'
 * base backgrounds (1.5-3:1), so the colour sits on the icon and the words stay in `text-base-content`. Because
 * the icon's shape differs per tone, the tone also reads without colour. The icon is inline, so the element keeps
 * the shape of the plain text it replaces: `role` and `id` sit on the element that holds the text.
 *
 * @param props.tone - info, warning or error
 * @param props.as - the element to render; a `span` stays inline in running text
 * @param props.className - size, weight and spacing classes of the element
 * @param props.role - live-region role, when the note appears after the page is up
 * @param props.id - for an `aria-describedby` on the field the note belongs to
 */
export function ToneNote({
    tone,
    as: Tag = 'p',
    className = '',
    role,
    id,
    children,
}: {
    tone: Tone;
    as?: 'p' | 'div' | 'span';
    className?: string;
    role?: 'alert' | 'status';
    id?: string;
    children: ComponentChildren;
}) {
    return (
        <Tag id={id} role={role} className={`text-base-content ${className}`.trim()}>
            <ToneIcon tone={tone} />
            {children}
        </Tag>
    );
}
