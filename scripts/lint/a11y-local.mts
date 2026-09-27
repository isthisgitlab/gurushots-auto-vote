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

// The slice of the ESTree/JSX AST these checks read.
type JsxNode = { type: string };
type JsxName = JsxNode & { name?: string };
interface JsxElement extends JsxNode {
    openingElement: { name: JsxName; attributes: Array<JsxNode & { name: JsxName }> };
    children: JsxNode[];
}
interface RuleContext {
    report(descriptor: { node: JsxElement; message: string }): void;
}

// Elements a label can label by nesting (HTML "labelable elements").
// Typed to take a missing tag/attribute name: a lookup of one just misses.
const CONTROLS: ReadonlySet<string | null> = new Set(['input', 'select', 'textarea', 'meter', 'output', 'progress']);
const LABEL_ATTRIBUTES: ReadonlyArray<string | undefined> = ['htmlFor', 'for'];

const isElement = (node: JsxNode): node is JsxElement => node.type === 'JSXElement';

const tagOf = (element: JsxElement): string | null => {
    const { name } = element.openingElement;
    // A JSXIdentifier always carries its name.
    return name.type === 'JSXIdentifier' ? (name.name as string) : null;
};

const wrapsControl = (element: JsxElement): boolean =>
    element.children.some((child) => isElement(child) && (CONTROLS.has(tagOf(child)) || wrapsControl(child)));

const namesControl = (element: JsxElement): boolean =>
    element.openingElement.attributes.some(
        (attribute) => attribute.type === 'JSXAttribute' && LABEL_ATTRIBUTES.includes(attribute.name.name),
    );

const labelHasControl = {
    meta: {
        type: 'problem',
        docs: { description: 'Require every <label> to name its control (htmlFor) or wrap it' },
    },
    create(context: RuleContext) {
        return {
            JSXElement(node: JsxElement) {
                if (tagOf(node) !== 'label' || namesControl(node) || wrapsControl(node)) return;
                context.report({ node, message: 'A <label> must name its control with htmlFor or wrap it.' });
            },
        };
    },
};

export default {
    meta: { name: 'a11y-local' },
    rules: { 'label-has-control': labelHasControl },
};
