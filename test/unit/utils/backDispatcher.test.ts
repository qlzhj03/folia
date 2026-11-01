import { afterEach, describe, expect, it } from 'vitest';
import { addBackHandler, handleBackPress } from '@/utils/backDispatcher';

// test/unit/utils/backDispatcher.test.ts
// 返回派发的两条规则：后登记的先被问（后开的东西画在上面、也后登记），以及有消费即停——
// 下面的层不能在一个浮层已经接住返回之后又退一步。注销发生在自己被问的时刻（关窗），
// 派发正往栈顶方向走，不能因此错位。

const unregisterAll: Array<() => void> = [];
const register = (handler: () => boolean): (() => void) => {
    const unregister = addBackHandler(handler);
    unregisterAll.push(unregister);
    return unregister;
};

afterEach(() => {
    while (unregisterAll.length) unregisterAll.pop()!();
});

describe('backDispatcher', () => {
    it('没有登记任何层时报告没人接住', () => {
        expect(handleBackPress()).toBe(false);
    });

    it('最上层的层先被问，接住后下面的层不再被问', () => {
        const asked: string[] = [];
        register(() => { asked.push('navigation'); return true; });
        register(() => { asked.push('sheet'); return true; });
        expect(handleBackPress()).toBe(true);
        expect(asked).toEqual(['sheet']);
    });

    it('上面的层不接（返回 false）时落到底下的层', () => {
        const asked: string[] = [];
        register(() => { asked.push('navigation'); return true; });
        register(() => { asked.push('palette'); return false; });
        expect(handleBackPress()).toBe(true);
        expect(asked).toEqual(['palette', 'navigation']);
    });

    it('谁都不接时报告没人接住', () => {
        register(() => false);
        expect(handleBackPress()).toBe(false);
    });

    it('层在自己被问时注销自己，不影响同一次派发里更深层的处理', () => {
        const asked: string[] = [];
        register(() => { asked.push('navigation'); return true; });
        const unregisterSheet = register(() => { asked.push('sheet'); unregisterSheet(); return true; });
        expect(handleBackPress()).toBe(true);
        expect(asked).toEqual(['sheet']);
        // 注销过的层下一次派发不再被问。
        expect(handleBackPress()).toBe(true);
        expect(asked).toEqual(['sheet', 'navigation']);
    });

    it('层被问时连带注销还没被问的层，那次派发就不再问它', () => {
        const asked: string[] = [];
        const unregisterNavigation = register(() => { asked.push('navigation'); return true; });
        register(() => { asked.push('dialog'); unregisterNavigation(); return true; });
        expect(handleBackPress()).toBe(true);
        expect(asked).toEqual(['dialog']);
    });

    it('同一层注销两次是安全的（关窗与卸载各走一次清理）', () => {
        const unregister = register(() => true);
        unregister();
        expect(() => unregister()).not.toThrow();
        expect(handleBackPress()).toBe(false);
    });
});
