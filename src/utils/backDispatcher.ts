// src/utils/backDispatcher.ts
// 全局返回的派发器：每一层「此刻该退的一步」（弹窗、命令面板、应用导航）把自己登记进来，
// 系统返回键（安卓壳）来问时，从最近登记的一层问起，谁消费了这一下就停。
//
// 登记顺序是层叠顺序的镜像：后开的东西画在上面、也后登记，所以从栈顶往下问就是从最上层往下问。
// 纯注册表，不碰 React 与 DOM：组件经 hooks/useBackHandler 登记，壳层（services/capacitorShell）
// 直接调用 handleBackPress。

/** 处理一次返回；返回 true 表示这一下由它处理了，派发就此停止。 */
export type BackHandler = () => boolean;

const handlers: BackHandler[] = [];

/** 登记一个返回处理器（后登记的先被问）；返回注销函数。 */
export const addBackHandler = (handler: BackHandler): (() => void) => {
    handlers.push(handler);
    return () => {
        const index = handlers.indexOf(handler);
        if (index !== -1) handlers.splice(index, 1);
    };
};

/** 派发一次返回：从最近登记的处理器问起，有消费即停。返回有没有层接住这一下。 */
export const handleBackPress = (): boolean => {
    // 快照 + 在册检查：处理器被问时可能注销自己，也可能连带注销别的层（关窗连带关窗）。
    // 快照让循环不错位，在册检查让注销过的层不再被问。
    for (const handler of [...handlers].reverse()) {
        if (!handlers.includes(handler)) continue;
        if (handler()) return true;
    }
    return false;
};
