import { render, screen } from './helpers/test-utils';
import { mockTranslator } from './helpers/setup';
import { EntryTime } from '@/components/app/EntryTime';
import { createTranslator } from '../../src/ts/translations/translator';
import { app } from '../../src/ts/translations/english';
import { formatEndTimeIn } from '../../src/ts/format/endTime';
import type { Translate } from '../../src/ts/translations/translator';

const AT = 1_792_420_000;
const when = formatEndTimeIn(AT, 'UTC', 'en-GB');

// The real English strings, placeholders filled like the real t fills them.
const translator = createTranslator();
const english: Translate = (key, vars) => translator.t(key, vars, 'en');

beforeEach(() => {
    mockTranslator.t.mockImplementation(english);
});

describe('EntryTime', () => {
    test('an exact time reads "Submitted <time>", plain', () => {
        const { container } = render(<EntryTime time={{ at: AT, exact: true }} timezone="UTC" />);
        const text = screen.getByText(`Submitted ${when}`);
        expect(text.className).not.toContain('italic');
        expect(text.getAttribute('title')).toBeNull();
        expect(container.querySelector('.sr-only')).toBeNull();
    });

    test('an approximate time says "or earlier", in italics and dimmed, with the long text for a screen reader and a title', () => {
        const { container } = render(<EntryTime time={{ at: AT, exact: false }} timezone="UTC" />);
        const visible = screen.getByText(`Submitted ${when} or earlier`);
        expect(visible.getAttribute('aria-hidden')).toBe('true');
        const wrapper = visible.parentElement!;
        expect(wrapper.className).toContain('italic');
        expect(wrapper.className).toContain('text-base-content/70');
        expect(wrapper.getAttribute('title')).toBe(app.entrySubmittedOrEarlierLong);
        const hidden = container.querySelector('.sr-only')!;
        expect(hidden.textContent).toBe(`Submitted ${when} or earlier. ${app.entrySubmittedOrEarlierLong}`);
    });

    test('the time is written in the timezone it is given', () => {
        render(<EntryTime time={{ at: AT, exact: true }} timezone="Asia/Tokyo" />);
        expect(screen.getByText(`Submitted ${formatEndTimeIn(AT, 'Asia/Tokyo', 'en-GB')}`)).toBeTruthy();
        expect(formatEndTimeIn(AT, 'Asia/Tokyo', 'en-GB')).not.toBe(when);
    });

    test.each([
        ['no time', undefined],
        ['a zero time', { at: 0, exact: false }],
        ['a negative time', { at: -5, exact: true }],
    ])('%s shows nothing', (_name, time) => {
        const { container } = render(<EntryTime time={time} timezone="UTC" />);
        expect(container.innerHTML).toBe('');
    });
});
