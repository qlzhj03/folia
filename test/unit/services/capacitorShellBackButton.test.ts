import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/capacitorShellBackButton.test.ts
// 安卓壳返回键的兜底分支规则：有层接住就复位双击计时、不出提示不退出；根上第一次按只出
// 「再按一次退出」，2 秒内再按才真退。这是用户看不见的计时与重置逻辑，按 testing-strategy
// 补的逻辑测试；派发本身由 test/unit/utils/backDispatcher.test.ts 覆盖，这里用真派发器接住
// 或放行，驱动壳层监听器。

const addListenerMock = vi.hoisted(() => vi.fn(async () => ({ remove: async () => {} })));
const exitAppMock = vi.hoisted(() => vi.fn());
const setStatusMessageMock = vi.hoisted(() => vi.fn());

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: addListenerMock,
        exitApp: exitAppMock,
    },
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
    },
}));
vi.mock('../../../src/stores/useStatusMessageStore', () => ({
    setStatusMessage: setStatusMessageMock,
}));
vi.mock('../../../src/i18n/config', () => ({
    default: { t: (key: string) => key },
}));

// initCapacitorShell 只往 viewport meta 追加属性：给一个没有 meta 的 document 就行；
// isCapacitorAndroid 还要求 window 存在。
vi.stubGlobal('document', { querySelector: () => null });
vi.stubGlobal('window', {});

// 用真实量级的纪元时间：双击计时器初值是 0，假时钟拨到 0 会把第一次按当成窗口内的第二次。
const TEST_EPOCH = Date.parse('2026-01-01T00:00:00Z');

type BackListener = () => void;

/** 每个用例重新加载壳层模块（它带着模块级的双击计时），返回刚注册的返回监听器。 */
const loadShell = async (): Promise<BackListener> => {
    vi.resetModules();
    addListenerMock.mockClear();
    exitAppMock.mockClear();
    setStatusMessageMock.mockClear();
    const shell = await import('../../../src/services/capacitorShell');
    shell.initCapacitorShell();
    const calls = addListenerMock.mock.calls as unknown as Array<[string, BackListener]>;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('backButton');
    return calls[0][1];
};

describe('capacitorShell backButton', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('根上第一次按只出提示，2 秒内再按才退出', async () => {
        const onBack = await loadShell();

        vi.setSystemTime(TEST_EPOCH);
        onBack();
        expect(setStatusMessageMock).toHaveBeenCalledTimes(1);
        expect(setStatusMessageMock).toHaveBeenCalledWith({ type: 'info', text: 'status.backAgainToExit' });
        expect(exitAppMock).not.toHaveBeenCalled();

        vi.setSystemTime(TEST_EPOCH + 1500);
        onBack();
        expect(exitAppMock).toHaveBeenCalledTimes(1);
        // 退出这一下不再出新的提示。
        expect(setStatusMessageMock).toHaveBeenCalledTimes(1);
    });

    it('超过窗口期的第二次按不退出，重新出提示', async () => {
        const onBack = await loadShell();

        vi.setSystemTime(TEST_EPOCH);
        onBack();
        vi.setSystemTime(TEST_EPOCH + 2500);
        onBack();
        expect(exitAppMock).not.toHaveBeenCalled();
        expect(setStatusMessageMock).toHaveBeenCalledTimes(2);
    });

    it('有层接住时不出提示不退出，并把双击计时清零', async () => {
        const onBack = await loadShell();
        const { addBackHandler } = await import('../../../src/utils/backDispatcher');

        vi.setSystemTime(TEST_EPOCH);
        onBack();
        expect(setStatusMessageMock).toHaveBeenCalledTimes(1);

        // 中间夹一次被层接住的返回（窗口期内）：计时清零，之后即使还在 2 秒内也按第一次算。
        const unregister = addBackHandler(() => true);
        vi.setSystemTime(TEST_EPOCH + 1000);
        onBack();
        expect(exitAppMock).not.toHaveBeenCalled();
        expect(setStatusMessageMock).toHaveBeenCalledTimes(1);
        unregister();

        vi.setSystemTime(TEST_EPOCH + 2000);
        onBack();
        expect(exitAppMock).not.toHaveBeenCalled();
        expect(setStatusMessageMock).toHaveBeenCalledTimes(2);
    });
});
