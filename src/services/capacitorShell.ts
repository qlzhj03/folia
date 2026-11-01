import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import i18n from '../i18n/config';
import { isCapacitorAndroid } from '../platform/runtime';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { handleBackPress } from '../utils/backDispatcher';

// 安卓壳（Capacitor）的环境适配：注册系统返回键监听、给 viewport meta 追加 viewport-fit=cover；
// 浏览器和桌面版是 no-op。
//
// 状态栏与返回手势（定案见 capacitor.config.ts 的 SystemBars 注释）：系统栏常显、透明叠加在
// 全屏内容上，顶部操作区用 SystemBars 插件注入的 --safe-area-inset-top 让位。这里的
// viewport-fit=cover 必须保留：SystemBars 在页面加载后按页面真实的 viewport-fit meta 决定
// insets 模式，没有 cover 会退回原生垫边、WebView 被压到状态栏下方，视觉墙铺不到状态栏底下。
export function initCapacitorShell(): void {
    if (!Capacitor.isNativePlatform()) {
        return;
    }

    const meta = document.querySelector('meta[name="viewport"]');
    const content = meta?.getAttribute('content');
    if (meta && content && !content.includes('viewport-fit=cover')) {
        meta.setAttribute('content', `${content}, viewport-fit=cover`);
    }

    if (isCapacitorAndroid()) {
        initBackButton();
    }
}

// 系统返回键：先问应用内各层（utils/backDispatcher，弹窗、命令面板、历史后退都在那里登记），
// 有层接住就不出应用。都不要时才是退出：第一次提示，2 秒内再按一次才真退（标准安卓的双击退出）。
const BACK_EXIT_PRESS_WINDOW_MS = 2000;
let lastRootBackPressAt = 0;

function initBackButton(): void {
    // 应用存活期间一直有效，句柄不注销。
    App.addListener('backButton', () => {
        if (handleBackPress()) {
            // 中间夹着浮层的返回不算「连按两次」：退出提示只认接连两次根上的返回。
            lastRootBackPressAt = 0;
            return;
        }
        const now = Date.now();
        if (now - lastRootBackPressAt <= BACK_EXIT_PRESS_WINDOW_MS) {
            void App.exitApp();
            return;
        }
        lastRootBackPressAt = now;
        setStatusMessage({ type: 'info', text: i18n.t('status.backAgainToExit') });
    }).then(() => {
        console.info('[capacitorShell] backButton listener registered');
    }).catch(error => {
        console.warn('[capacitorShell] Failed to register backButton listener:', error);
    });
}
