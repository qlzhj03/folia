import { Capacitor } from '@capacitor/core';

// 安卓壳（Capacitor）的环境适配：只在原生壳里给 viewport meta 追加 viewport-fit=cover，
// 让运行时 SystemBars 走 passthrough、WebView 铺满整屏不被原生侧垫状态栏边距；浏览器和桌面版是 no-op。
export function initCapacitorShell(): void {
    if (!Capacitor.isNativePlatform()) {
        return;
    }

    const meta = document.querySelector('meta[name="viewport"]');
    const content = meta?.getAttribute('content');
    if (meta && content && !content.includes('viewport-fit=cover')) {
        meta.setAttribute('content', `${content}, viewport-fit=cover`);
        console.info('[capacitorShell] native shell active, viewport-fit=cover applied');
    }
}
