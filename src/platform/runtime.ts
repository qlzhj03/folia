import { Capacitor } from '@capacitor/core';

// 当前文件：统一描述 Web、Electron 与 Capacitor Android 的运行时（对应上游 folia-sonnet
// 的 src/platform/runtime.ts，这里只先带本步用到的部分，其余随各平台接入补上）。

export const isCapacitorAndroid = (): boolean => (
  typeof window !== 'undefined'
  && Capacitor.isNativePlatform()
  && Capacitor.getPlatform() === 'android'
);
