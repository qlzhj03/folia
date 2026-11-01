import { useEffect, useRef } from 'react';
import { addBackHandler, type BackHandler } from '../utils/backDispatcher';

// src/hooks/useBackHandler.ts
// 组件版本的返回登记：active 为 true 的期间把 handler 挂到全局返回派发器上（utils/backDispatcher），
// 最近登记的最先被问。handler 每次渲染换成最新的（同 useExclusiveKeyLayer 的做法），注册只随 active 装卸。

export const useBackHandler = (active: boolean, handler: BackHandler): void => {
    const latest = useRef(handler);
    latest.current = handler;

    useEffect(() => {
        if (!active) return undefined;
        return addBackHandler(() => latest.current());
    }, [active]);
};
