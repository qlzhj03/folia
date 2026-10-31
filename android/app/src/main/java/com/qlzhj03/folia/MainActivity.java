package com.qlzhj03.folia;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * Folia 的主 Activity。
 *
 * 在 Capacitor 默认实现之上做三件事：
 *   · 注册 FoliaNativePlugin —— 本地登录（内置接口代码 + CookieManager/OkHttp）的原生底座；
 *   · WebView 的播放设置：网易云的播放地址是 http（m7*.music.126.net 这类），
 *     https 页面里不放行混合内容就是一句静默的播放失败；
 *   · 每次启动清一次 WebView 缓存。
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
        // 每次启动清掉 WebView 的 HTTP 缓存：页面从 https://localhost 加载，那个源头的
        // index.html 没有内容指纹，装了新包后缓存仍会把旧 index.html（连同它引用的旧
        // chunk）供回来，表现成「重装了还是旧行为」。全部资源都在 APK 里，缓存清掉只是
        // 换成直接读文件，没有网络代价。
        webView.clearCache(true);
    }
}
