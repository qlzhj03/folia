package com.qlzhj03.folia;

import android.util.Base64;
import android.webkit.CookieManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 本地登录的原生底座（当前只服务网易云；后续平台接入时在这里加各自的方法即可）。
 *
 * 内置在 App 里的那份接口代码（src/nativeBridge/api/*.js）需要两件 WebView 给不了的东西：
 * 读改写音乐平台的 Cookie，以及不受 CORS 限制的跨域请求。这里把它们分别接到
 * Android CookieManager 与 OkHttp 上，于是扫码登录、取曲库全流程都在设备本地完成 ——
 * 不需要任何外部自建服务器。对应上游 folia-sonnet 的同名插件。
 */
@CapacitorPlugin(name = "FoliaNative")
public class FoliaNativePlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .build();

    @PluginMethod
    public void cookiesGetAll(PluginCall call) {
        String url = call.getString("url", "");
        String domain = call.getString("domain", "");
        if (url == null || url.isEmpty()) {
            if (domain == null || domain.isEmpty()) {
                url = "https://localhost/";
            } else {
                url = domain.startsWith("http") ? domain : "https://" + domain;
            }
        }

        JSArray cookies = new JSArray();
        for (JSObject cookie : parseCookieHeader(CookieManager.getInstance().getCookie(url), domain)) {
            cookies.put(cookie);
        }
        JSObject result = new JSObject();
        result.put("cookies", cookies);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesGet(PluginCall call) {
        String url = call.getString("url", "https://localhost/");
        String name = call.getString("name", "");
        if (name == null || name.isEmpty()) {
            call.reject("Missing cookie name");
            return;
        }
        for (JSObject cookie : parseCookieHeader(CookieManager.getInstance().getCookie(url), "")) {
            if (name.equals(cookie.optString("name"))) {
                JSObject result = new JSObject();
                result.put("cookie", cookie);
                call.resolve(result);
                return;
            }
        }
        JSObject result = new JSObject();
        result.put("cookie", null);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesSet(PluginCall call) {
        String url = call.getString("url", "");
        String name = call.getString("name", "");
        String value = call.getString("value", "");
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            call.reject("Cookie url and name are required");
            return;
        }

        StringBuilder cookie = new StringBuilder();
        cookie.append(name).append('=').append(value == null ? "" : value);
        String domain = call.getString("domain", "");
        String path = call.getString("path", "/");
        if (domain != null && !domain.isEmpty()) cookie.append("; domain=").append(domain);
        if (path != null && !path.isEmpty()) cookie.append("; path=").append(path);
        if (Boolean.TRUE.equals(call.getBoolean("secure", false))) cookie.append("; Secure");
        Double expirationDate = call.getDouble("expirationDate");
        if (expirationDate != null) {
            cookie.append("; Max-Age=").append((int) Math.max(0, expirationDate - System.currentTimeMillis() / 1000.0));
        }

        CookieManager.getInstance().setCookie(url, cookie.toString());
        CookieManager.getInstance().flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesRemove(PluginCall call) {
        String url = call.getString("url", "");
        String name = call.getString("name", "");
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            call.reject("Cookie url and name are required");
            return;
        }
        CookieManager.getInstance().setCookie(url, name + "=; Max-Age=0; path=/");
        CookieManager.getInstance().flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    /**
     * 批量删除 cookie：entries 是 [{url, name}, ...]。
     *
     * 逐条删除每条都要过一次桥并在原生侧 flush 一次，切换登录通道要清几十条，
     * 累加起来会超过调用方的截止时间，结果只清掉一半 —— 剩下一半旧凭据会把新登录
     * 拼成一个用不了的会话。所以这里在原生侧一次做完。
     */
    @PluginMethod
    public void cookiesRemoveBatch(PluginCall call) {
        JSArray entries = call.getArray("entries");
        if (entries == null || entries.length() == 0) {
            JSObject empty = new JSObject();
            empty.put("ok", true);
            empty.put("removed", 0);
            call.resolve(empty);
            return;
        }
        CookieManager manager = CookieManager.getInstance();
        int removed = 0;
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index);
            if (entry == null) continue;
            String url = entry.optString("url", "");
            String name = entry.optString("name", "");
            if (url == null || url.isEmpty() || name == null || name.isEmpty()) continue;
            manager.setCookie(url, name + "=; Max-Age=0; path=/");
            removed++;
        }
        if (removed > 0) manager.flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("removed", removed);
        call.resolve(result);
    }

    /** OkHttp 要求这些方法必须带 body（见 httpRequest 里的说明）。 */
    private static boolean requiresRequestBody(String method) {
        return "POST".equalsIgnoreCase(method)
            || "PUT".equalsIgnoreCase(method)
            || "PATCH".equalsIgnoreCase(method);
    }

    /**
     * 按名字取一个请求头，**不区分大小写**。
     *
     * HTTP 头的名字本来就大小写不敏感（`Content-Type` 与 `content-type` 是同一个头），
     * 而 JSONObject 的键是敏感的 —— 只按小写问一次，来自别处的 `Content-Type` 就取不到。
     * JS 侧现在是 `new Headers(...)` 给的（都是小写），所以看起来没问题；但桥是公开的，
     * 手写一个头名字就能让它悄悄落空。缺了就返回 null（不是空串）：调用方一律按 null 判。
     */
    private static String optHeader(JSObject headers, String name) {
        if (headers == null) return null;
        Object direct = headers.opt(name);
        if (direct != null) {
            String value = String.valueOf(direct);
            return value.isEmpty() ? null : value;
        }
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (key != null && key.equalsIgnoreCase(name)) {
                Object value = headers.opt(key);
                if (value == null) return null;
                String text = String.valueOf(value);
                return text.isEmpty() ? null : text;
            }
        }
        return null;
    }

    private static final char[] HEADER_HEX = "0123456789ABCDEF".toCharArray();

    /**
     * 把请求头的值压回 HTTP 允许的范围（0x20–0x7E 的可见 ASCII）。
     *
     * OkHttp 建请求时会逐个检查头的值，范围外的字符直接抛
     * `Unexpected char 0x4e1c at 414 in Cookie value` —— Cookie 里带中文（昵称之类）时
     * **每一个**走桥的请求都会在建头这一步就炸，连发出去的机会都没有。
     *
     * 范围外的字符按 UTF-8 做百分号编码：本来就是 ASCII 的部分一个字节都不动，
     * token、签名、分隔符（`;` `=` `&`）照旧，只有那些本就不该出现在头里的字符换个写法。
     * 只在这里（发送前）改、不写回 cookie 库：库里留原样，界面拿到的还是原文。
     */
    private static String sanitizeHeaderValue(String value) {
        if (value == null || value.isEmpty()) return value;
        StringBuilder out = null;
        int i = 0;
        while (i < value.length()) {
            int codePoint = value.codePointAt(i);
            int width = Character.charCount(codePoint);
            if (codePoint >= 0x20 && codePoint <= 0x7E) {
                if (out != null) out.append((char) codePoint);
            } else {
                if (out == null) {
                    out = new StringBuilder(value.length() + 16);
                    out.append(value, 0, i);
                }
                // 代理对（emoji 之类）要整块编码，拆成两个 char 各编一半是错的。
                byte[] bytes = new String(Character.toChars(codePoint)).getBytes(StandardCharsets.UTF_8);
                for (byte raw : bytes) {
                    out.append('%')
                        .append(HEADER_HEX[(raw >> 4) & 0xF])
                        .append(HEADER_HEX[raw & 0xF]);
                }
            }
            i += width;
        }
        return out == null ? value : out.toString();
    }

    @PluginMethod
    public void httpRequest(PluginCall call) {
        String url = call.getString("url", "");
        String method = call.getString("method", "GET");
        String bodyText = call.getString("bodyText", "");
        String bodyBase64 = call.getString("bodyBase64", "");
        String redirect = call.getString("redirect", "follow");
        if (url == null || url.isEmpty()) {
            call.reject("Missing request url");
            return;
        }

        try {
            Request.Builder builder = new Request.Builder().url(url);
            JSObject headers = call.getObject("headers");
            if (headers != null) {
                Iterator<String> headerNames = headers.keys();
                while (headerNames.hasNext()) {
                    String headerName = headerNames.next();
                    Object headerValue = headers.opt(headerName);
                    if (headerValue != null) {
                        // 头的值必须是可见 ASCII，否则 OkHttp 当场抛（见 sanitizeHeaderValue 的说明）。
                        builder.header(headerName, sanitizeHeaderValue(String.valueOf(headerValue)));
                    }
                }
            }
            // OkHttp 这里没有 cookie jar，所以要把 WebView 的 cookie 库自己带上，
            // 除非调用方已经显式塞了 Cookie 头。
            if (headers == null || optHeader(headers, "cookie") == null) {
                String storedCookies = CookieManager.getInstance().getCookie(url);
                if (storedCookies != null && !storedCookies.isEmpty()) {
                    builder.header("Cookie", sanitizeHeaderValue(storedCookies));
                }
            }

            RequestBody body = null;
            if (bodyBase64 != null && !bodyBase64.isEmpty()) {
                body = RequestBody.create(MediaType.parse("application/octet-stream"), Base64.decode(bodyBase64, Base64.DEFAULT));
            } else if (bodyText != null && !bodyText.isEmpty()) {
                /*
                 * Content-Type 取不到时**不许传 null 给 MediaType.parse**：OkHttp 4 是 Kotlin 写的，
                 * 那个方法的参数是「非空接收者」，传 null 当场 NPE，
                 * 整条请求连发出去的机会都没有。
                 *
                 * 退回 `text/plain;charset=UTF-8` —— 这正是 fetch 对「字符串 body + 没指定类型」
                 * 的处理（浏览器就是这么发的）。
                 */
                String contentType = headers == null ? null : optHeader(headers, "content-type");
                MediaType mediaType = MediaType.parse(
                    contentType == null || contentType.isEmpty()
                        ? "text/plain;charset=UTF-8"
                        : contentType);
                body = RequestBody.create(mediaType, bodyText);
            }
            String requestMethod = method == null ? "GET" : method;
            /*
             * OkHttp 不给 POST/PUT/PATCH 发空 body：`HttpMethod.requiresRequestBody` 会直接抛
             * `method POST must have a request body.` —— 整条请求根本出不去。
             *
             * 而「参数全走 query」的 POST 接口就是这么写的；这里补一个长度为 0 的 body：
             * 线上看到的就是 Content-Length: 0，与上游完全一致。
             */
            if (body == null && requiresRequestBody(requestMethod)) {
                body = RequestBody.create(null, new byte[0]);
            }
            if (body != null && "GET".equalsIgnoreCase(requestMethod)) {
                // 有接口的播放地址是「GET + JSON body」，OkHttp 公开的 method() 不接受这种组合，
                // 只能先选好 GET 再用它自己的 setter 把校验过的 body 塞进去。
                builder.method("GET", null);
                try {
                    Method setBody = Request.Builder.class.getMethod("setBody$okhttp", RequestBody.class);
                    setBody.invoke(builder, body);
                } catch (ReflectiveOperationException error) {
                    call.reject("GET request body is unsupported by this runtime", error);
                    return;
                }
            } else {
                builder.method(requestMethod, body);
            }

            OkHttpClient requestClient = client;
            if ("manual".equals(redirect)) {
                requestClient = client.newBuilder()
                    .followRedirects(false)
                    .followSslRedirects(false)
                    .build();
            }
            // 慢接口可以按需放宽读超时。
            Integer timeoutMs = call.getInt("timeoutMs");
            if (timeoutMs != null && timeoutMs > 0) {
                requestClient = requestClient.newBuilder()
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build();
            }

            // 回调里要用，必须是 final：上面这两段按条件重建过 client。
            final OkHttpClient executeClient = requestClient;
            String requestUrl = url;
            /*
             * 必须用 enqueue 而不是 execute。
             *
             * execute() 是在**插件所在的桥线程**上同步阻塞的：一个请求从发出到拿到响应
             * （最坏要等满读超时）会一直占着那个线程。桥线程就那么几条，占满之后其它
             * 插件方法全部排队 —— cookie 调用本身只是毫秒级的事，跟着遭殃之后
             * 登录态读不到 cookie 就判成超时，二维码也取不出来。
             *
             * enqueue 把等待交给 OkHttp 自己的线程池，桥线程立刻空出来。
             */
            call.setKeepAlive(true);
            executeClient.newCall(builder.build()).enqueue(new Callback() {
                @Override
                public void onFailure(Call httpCall, IOException error) {
                    call.reject(error.getMessage(), error);
                }

                @Override
                public void onResponse(Call httpCall, Response response) {
                    try (Response body = response) {
                        // 重复出现的响应头（Set-Cookie）要给 JS 一个数组，用对象会把重复的折叠掉。
                        JSArray responseHeaders = new JSArray();
                        for (String name : response.headers().names()) {
                            for (String value : response.headers().values(name)) {
                                JSObject headerEntry = new JSObject();
                                headerEntry.put("name", name);
                                headerEntry.put("value", value);
                                responseHeaders.put(headerEntry);
                            }
                        }
                        storeResponseCookies(requestUrl, response);
                        ResponseBody responseBody = response.body();
                        byte[] bytes = responseBody == null ? new byte[0] : responseBody.bytes();
                        JSObject result = new JSObject();
                        result.put("status", response.code());
                        result.put("headers", responseHeaders);
                        result.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                        call.resolve(result);
                    } catch (IOException | IllegalArgumentException error) {
                        call.reject(error.getMessage(), error);
                    }
                }
            });
        } catch (IllegalArgumentException error) {
            // 拼 URL / 建请求这一步才会抛（响应相关的 IOException 在回调里各自处理）。
            call.reject(error.getMessage(), error);
        }
    }

    /**
     * 把响应里的 Set-Cookie 存回 WebView 的 cookie 库。
     *
     * 登录能不能保持住全靠这一步：登录接口下发的 MUSIC_U 之类的凭据，
     * 之后每次请求都要由 {@link #httpRequest} 从这里读出来带上。
     */
    private void storeResponseCookies(String requestUrl, Response response) {
        List<String> setCookies = response.headers().values("Set-Cookie");
        if (setCookies.isEmpty()) return;
        CookieManager manager = CookieManager.getInstance();
        boolean changed = false;
        for (String rawCookie : setCookies) {
            String cookie = normalizeCookieForUrl(requestUrl, rawCookie);
            if (cookie == null || cookie.isEmpty()) continue;
            manager.setCookie(requestUrl, cookie);
            changed = true;
        }
        if (changed) manager.flush();
    }

    // 真实响应几乎都带 Path/Domain，但个别平台会整个省略 Path；CookieManager 遇到没有
    // Path 的 Set-Cookie 会直接忽略，这里补一个默认的，免得登录态存不下来。
    private static String normalizeCookieForUrl(String requestUrl, String rawCookie) {
        if (rawCookie == null || rawCookie.isEmpty()) return null;
        boolean hasPath = false;
        for (String attribute : rawCookie.split(";")) {
            if (attribute.trim().toLowerCase().startsWith("path=")) {
                hasPath = true;
                break;
            }
        }
        if (hasPath) return rawCookie;
        return rawCookie + "; Path=/";
    }

    private List<JSObject> parseCookieHeader(String header, String domain) {
        List<JSObject> cookies = new ArrayList<>();
        if (header == null || header.isEmpty()) return cookies;
        String[] pairs = header.split(";");
        for (String pair : pairs) {
            int separator = pair.indexOf('=');
            if (separator <= 0) continue;
            String name = pair.substring(0, separator).trim();
            String value = pair.substring(separator + 1).trim();
            if (name.isEmpty()) continue;
            JSObject cookie = new JSObject();
            cookie.put("name", name);
            cookie.put("value", value);
            cookie.put("domain", domain == null ? "" : domain);
            cookie.put("path", "/");
            cookie.put("secure", true);
            cookie.put("httpOnly", false);
            cookies.add(cookie);
        }
        return cookies;
    }
}
