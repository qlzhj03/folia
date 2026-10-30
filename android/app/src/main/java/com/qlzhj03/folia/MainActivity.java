package com.qlzhj03.folia;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * Folia 的主 Activity。
 *
 * 在 Capacitor 默认实现之上做两件事：
 *   · 注册 FoliaNativePlugin —— 本地登录（内置接口代码 + CookieManager/OkHttp）的原生底座；
 *   · WebView 的播放设置：网易云的播放地址是 http（m7*.music.126.net 这类），
 *     https 页面里不放行混合内容就是一句静默的播放失败。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate() **之前**注册。
        //
        // registerPlugin 只是往 bridgeBuilder 里登记类，而真正创建 Bridge
        // （bridgeBuilder.create()）是在 BridgeActivity.onCreate() 内部完成的。
        // 放在 super 之后就太晚了：Bridge 已经建好，这个插件永远不会被实例化，
        // JS 侧调用会静默失败。
        registerPlugin(FoliaNativePlugin.class);
        super.onCreate(savedInstanceState);
        applyWebViewPlaybackSettings();
    }

    private void applyWebViewPlaybackSettings() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        WebSettings settings = webView.getSettings();
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
    }
}
