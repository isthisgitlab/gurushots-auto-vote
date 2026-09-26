/**
 * Oxlint JS plugin: the renderer's accessibility checks that no built-in
 * Oxlint rule covers.
 *
 * `label-has-control` — every `<label>` names its control (`htmlFor`) or wraps
 * it. jsx-a11y's label-has-associated-control skips a label whose only text is
 * an expression, and every label in this translated UI reads `{t('…')}`, so an
 * orphan `<label>` tied to no control would otherwise pass. This is the old
 * jsx-a11y label-has-for "nesting OR id" check.
 *
 * Loaded through `jsPlugins` in .oxlintrc.json; the rule API is ESLint's.
 */

// Elements a label can label by nesting (HTML "labelable elements").
const CONTROLS = new Set(['input', 'select', 'textarea', 'meter', 'output', 'progress']);

/** @param {any} element - a JSXElement node */
const tagOf = (element) => {
    const { name } = element.openingElement;
    return name.type === 'JSXIdentifier' ? name.name : null;
};

/** @param {any} element - a JSXElement node */
const wrapsControl = (element) =>
    element.children.some(
        (child) => child.type === 'JSXElement' && (CONTROLS.has(tagOf(child)) || wrapsControl(child)),
    );

/** @param {any} element - a JSXElement node */
const namesControl = (element) =>
    element.openingElement.attributes.some(
        (attribute) => attribute.type === 'JSXAttribute' && ['htmlFor', 'for'].includes(attribute.name.name),
    );

const labelHasControl = {
    meta: {
        type: 'problem',
        docs: { description: 'Require every <label> to name its control (htmlFor) or wrap it' },
    },
    /** @param {any} context */
    create(context) {
        return {
            /** @param {any} node */
            JSXElement(node) {
                if (tagOf(node) !== 'label' || namesControl(node) || wrapsControl(node)) return;
                context.report({ node, message: 'A <label> must name its control with htmlFor or wrap it.' });
            },
        };
    },
};

module.exports = {
    meta: { name: 'a11y-local' },
    rules: { 'label-has-control': labelHasControl },
};
