/**
 * scripts/lint/a11y-local.js — the Oxlint JS plugin rule that every <label>
 * names or wraps its control. Nodes are built by hand in the ESTree/JSX shape
 * Oxlint hands to JS plugins.
 */
const plugin = require('../../scripts/lint/a11y-local');

const rule = plugin.rules['label-has-control'];

const attr = (name) => ({ type: 'JSXAttribute', name: { type: 'JSXIdentifier', name } });
const el = (name, { attributes = [], children = [] } = {}) => ({
    type: 'JSXElement',
    openingElement: {
        name: typeof name === 'string' ? { type: 'JSXIdentifier', name } : name,
        attributes,
    },
    children,
});
const text = { type: 'JSXExpressionContainer' };

const reportsFor = (node) => {
    const report = jest.fn();
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
        reportsFor(el('label', { attributes: [{ type: 'JSXSpreadAttribute' }], children: [text, el('span')] })),
    ).toHaveLength(1);
});

test('only <label> elements are checked', () => {
    expect(reportsFor(el('span', { children: [text] }))).toEqual([]);
    // A member-expression tag (Foo.Label) is not a plain <label>.
    expect(reportsFor(el({ type: 'JSXMemberExpression' }, { children: [text] }))).toEqual([]);
    // A member-expression child is not a control either.
    expect(reportsFor(el('label', { children: [el({ type: 'JSXMemberExpression' })] }))).toHaveLength(1);
});
