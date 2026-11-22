import { Component, createElement, render, type ComponentChildren, type VNode } from 'preact';
import { Suspense } from 'preact/compat';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';

type TreeNode = VNode & { __: TreeNode | null; __k: (TreeNode | null)[] };
const tree = <T,>(vnode: VNode<T>): TreeNode => vnode as VNode<T> & TreeNode;

let container: HTMLDivElement;
beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
});
afterEach(() => {
    render(null, container);
    container.remove();
});

test('detaches a replaced child while the current child keeps its exact parent', () => {
    const oldChild = createElement('span', null, 'old');
    const oldParent = createElement('div', null, oldChild);
    render(oldParent, container);
    const element = container.querySelector('span');
    expect(tree(oldChild).__).toBe(oldParent);

    const newChild = createElement('span', null, 'new');
    const newParent = createElement('div', null, newChild);
    render(newParent, container);
    expect(tree(oldChild).__).toBeNull();
    expect(tree(newChild).__).toBe(newParent);
    expect(tree(newParent).__k).toContain(newChild);
    expect(container.querySelector('span')).toBe(element);
    expect(element?.textContent).toBe('new');
});

test('replaces refs on the existing element and clears the new ref on unmount', () => {
    const oldRef = jest.fn<void, [HTMLSpanElement | null]>();
    const newRef = jest.fn<void, [HTMLSpanElement | null]>();
    render(createElement('span', { ref: oldRef }), container);
    const element = container.querySelector('span');
    expect(element).not.toBeNull();
    expect(oldRef).toHaveBeenLastCalledWith(element);
    render(createElement('span', { ref: newRef }), container);
    expect(oldRef).toHaveBeenLastCalledWith(null);
    expect(newRef).toHaveBeenLastCalledWith(element);
    render(null, container);
    expect(newRef).toHaveBeenLastCalledWith(null);
});

test('keeps keyed component ancestry and state after a move', async () => {
    let update = () => {};
    function Child() {
        const [count, setCount] = useState(0);
        update = () => setCount((value) => value + 1);
        return createElement('span', null, `count ${count}`);
    }
    class Retained extends Component {
        override shouldComponentUpdate() {
            return false;
        }
        override render() {
            return createElement(Child, null);
        }
    }
    const oldChild = createElement(Retained, { key: 'a' });
    render(createElement('div', null, oldChild, createElement('b', { key: 'b' }, 'b')), container);
    const element = container.querySelector('span');
    await act(() => update());
    expect(element?.textContent).toBe('count 1');
    const moved = createElement(Retained, { key: 'a' });
    const parent = createElement('div', null, createElement('b', { key: 'b' }, 'b'), moved);
    render(parent, container);
    expect(Array.from(container.querySelector('div')?.children ?? []).map((el) => el.tagName)).toEqual(['B', 'SPAN']);
    expect(container.querySelector('span')).toBe(element);
    expect(element?.textContent).toBe('count 1');
    expect(tree(moved).__).toBe(parent);
    expect(tree(tree(moved).__k[0]!).__).toBe(moved);
    await act(() => update());
    expect(element?.textContent).toBe('count 2');
    expect(container.querySelector('span')).toBe(element);
    expect(tree(tree(moved).__k[0]!).__).toBe(moved);
});

test.each(['suspend', 'error'] as const)('preserves ancestry during parent-driven %s and recovers', async (mode) => {
    let update = () => {};
    let resolve = () => {};
    const pending = new Promise<void>((done) => {
        resolve = done;
    });
    let failing = false;
    function Child({ fail }: { fail: boolean }) {
        const [count, setCount] = useState(0);
        update = () => setCount((value) => value + 1);
        if (fail && failing) throw mode === 'suspend' ? pending : new Error('expected');
        return createElement('span', null, `count ${count}`);
    }
    let boundary: Boundary | undefined;
    class Boundary extends Component<{ children: ComponentChildren }, { failed: boolean }> {
        override state = { failed: false };
        static override getDerivedStateFromError() {
            return { failed: true };
        }
        override componentDidMount() {
            boundary = this;
        }
        override render() {
            return this.state.failed ? createElement('strong', null, 'error') : this.props.children;
        }
    }
    const wrap = <T extends { fail: boolean }>(child: VNode<T>) =>
        mode === 'suspend'
            ? createElement(Suspense, { fallback: createElement('strong', null, 'loading') }, child)
            : createElement(Boundary, { children: child });
    const oldChild = createElement(Child, { fail: false });
    render(wrap(oldChild), container);
    const oldParent = tree(oldChild).__;
    const retained = tree(oldChild).__k[0];
    expect(retained?.__).toBe(oldChild);
    failing = true;
    render(wrap(createElement(Child, { fail: true })), container);
    expect(tree(oldChild).__).toBe(oldParent);
    expect(retained?.__).toBe(oldChild);
    await act(() => {});
    expect(container.querySelector('strong')?.textContent).toBe(mode === 'suspend' ? 'loading' : 'error');
    failing = false;
    await act(() => {
        if (mode === 'suspend') resolve();
        else boundary?.setState({ failed: false });
    });
    await act(() => update());
    expect(container.querySelector('span')?.textContent).toBe('count 1');
    const root = (container as HTMLDivElement & { __k: TreeNode }).__k;
    const findChild = (node: TreeNode): TreeNode | undefined => {
        if (node.type === Child) return node;
        for (const child of node.__k ?? []) {
            if (child) {
                const found = findChild(child);
                if (found) return found;
            }
        }
        return undefined;
    };
    const current = findChild(root);
    expect(current).toBeDefined();
    expect(current?.__?.__k).toContain(current);
    expect(current?.__k[0]?.__).toBe(current);
});
