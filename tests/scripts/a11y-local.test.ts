/**
 * scripts/lint/a11y-local.mts — the Oxlint JS plugin rule that every <label>
 * names or wraps its control. Nodes are built by hand in the ESTree/JSX shape
 * Oxlint hands to JS plugins.
 */
import type a11yLocalPlugin from '../../scripts/lint/a11y-local.mts';
import { invalid } from '../helpers/invalid';
const plugin: typeof a11yLocalPlugin = (require('../../scripts/lint/a11y-local') as { default: typeof a11yLocalPlugin })
    .default;

const rule = plugin.rules['label-has-control'];

type JsxElement = Parameters<ReturnType<typeof rule.create>['JSXElement']>[0];
type JsxNode = JsxElement['children'][number];
type JsxAttribute = JsxElement['openingElement']['attributes'][number];

const attr = (name: string): JsxAttribute => ({ type: 'JSXAttribute', name: { type: 'JSXIdentifier', name } });
const el = (
    name: string | JsxNode,
    { attributes = [], children = [] }: { attributes?: JsxAttribute[]; children?: JsxNode[] } = {},
): JsxElement => ({
    type: 'JSXElement',
    openingElement: {
        name: typeof name === 'string' ? { type: 'JSXIdentifier', name } : name,
        attributes,
    },
    children,
});
const text = { type: 'JSXExpressionContainer' };

const reportsFor = (node: JsxElement) => {
    const report = jest.fn<void, [{ node: JsxElement; message: string }]>();
    rule.create({ report }).JSXElement(node);
    return report.mock.calls.map(([arg]) => arg.message);
};

test('is registered under its plugin name', () => {
    expect(plugin.meta.name).toBe('a11y-local');
    expect(rule.meta.type).toBe('problem');
});

test('a label that names its control passes (htmlFor or for)', () => {
    expect(reportsFor(el('label', { attributes: [attr('htmlFor')], children: [text] }))).toEqual([]);
    expect(reportsFor(el('label', { attributes: [attr('for')], children: [text] }))).toEqual([]);
});

test('a label that wraps a control passes, however deep', () => {
    expect(reportsFor(el('label', { children: [text, el('input')] }))).toEqual([]);
    expect(reportsFor(el('label', { children: [el('span', { children: [el('select')] })] }))).toEqual([]);
});

test('an orphan label is reported, whatever its text', () => {
    expect(reportsFor(el('label', { children: [text] }))).toEqual([
        'A <label> must name its control with htmlFor or wrap it.',
    ]);
    // Spread attributes and non-control children do not count.
    expect(
        reportsFor(
            el('label', {
                attributes: [invalid<JsxAttribute>({ type: 'JSXSpreadAttribute' })],
                children: [text, el('span')],
            }),
        ),
    ).toHaveLength(1);
});

test('only <label> elements are checked', () => {
    expect(reportsFor(el('span', { children: [text] }))).toEqual([]);
    // A member-expression tag (Foo.Label) is not a plain <label>.
    expect(reportsFor(el({ type: 'JSXMemberExpression' }, { children: [text] }))).toEqual([]);
    // A member-expression child is not a control either.
    expect(reportsFor(el('label', { children: [el({ type: 'JSXMemberExpression' })] }))).toHaveLength(1);
});
