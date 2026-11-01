import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor 安卓壳的配置：webDir 指向 vite 构建产物，由 npm run cap:sync 同步进 android 工程。
const config: CapacitorConfig = {
    appId: 'com.qlzhj03.folia',
    appName: 'Folia',
    webDir: 'dist',
    plugins: {
        // 运行时内置的 SystemBars 插件：系统栏常显、透明叠加在全屏内容上（图标固定浅色），
        // 并把状态栏/手势条高度注入为 CSS 变量 --safe-area-inset-*（页面的 viewport-fit=cover
        // 由 capacitorShell.ts 注入，两者共同决定 passthrough 模式，WebView 铺满整屏）。
        // 顶部操作区（首页头部、播放页返回、状态提示条）用 --safe-area-inset-top 让位。
        // 不要改回 hidden: true：系统栏隐藏时，系统的第一次返回手势会被拿去唤出状态栏、
        // 不派发给应用（要再划一次才能返回，真机实测过），这是全屏沉浸的系统行为，应用内拦不住。
        SystemBars: {
            hidden: false,
            style: 'DARK',
            initialViewportFitValueHint: 'cover',
        },
    },
};

export default config;
