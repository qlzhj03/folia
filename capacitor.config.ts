import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor 安卓壳的配置：webDir 指向 vite 构建产物，由 npm run cap:sync 同步进 android 工程。
const config: CapacitorConfig = {
    appId: 'com.qlzhj03.folia',
    appName: 'Folia',
    webDir: 'dist',
    plugins: {
        // 运行时内置的 SystemBars 插件：启动即隐藏系统栏（状态栏和手势条，从边缘划出后保持显示），
        // 图标固定浅色；配合壳内注入的 viewport-fit=cover，WebView 铺满整屏、无原生垫边。
        SystemBars: {
            hidden: true,
            style: 'DARK',
            initialViewportFitValueHint: 'cover',
        },
    },
};

export default config;
