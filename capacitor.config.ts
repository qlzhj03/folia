import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor 安卓壳的配置：webDir 指向 vite 构建产物，由 npm run cap:sync 同步进 android 工程。
const config: CapacitorConfig = {
    appId: 'com.qlzhj03.folia',
    appName: 'Folia',
    webDir: 'dist',
};

export default config;
