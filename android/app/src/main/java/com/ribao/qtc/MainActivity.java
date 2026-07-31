package com.ribao.qtc;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

/**
 * 车间大屏看板宿主。
 *
 * 存在的理由：MAXHUB 自带的「HTML 查看程序」关掉了 JavaScript，页面渲染不出来；
 * 而自带浏览器又有地址栏、标签页，还会被人误触。这个壳只做三件事 ——
 * 全屏、常亮、把 quality-maxhub.html 用一个开了 JS 的 WebView 显示出来。
 *
 * 两条兜底：
 *   1. 服务器地址存在 SharedPreferences 里，长按屏幕就能改。车间的 IP 会变
 *      （DHCP、换网、换机器），不能每次都重新打包。
 *   2. 连不上就退到 assets 里的离线快照，之后每 60 秒重试一次。看板宁可显示
 *      过期数据也不能白屏 —— 白屏在车间会被当成设备坏了。
 */
public class MainActivity extends Activity {

    private static final String PREFS       = "qtc";
    private static final String KEY_URL     = "server_url";
    // 默认地址跟着开发机的内网 IP 走。这台机器保存了十几个自动连接的 WiFi，
    // 会在 ribao_sale_5g(192.168.30.153) 和 RBzongjingban(192.168.10.50) 之间漫游，
    // 漫游一次这里就失效一次 —— 所以地址必须能在设备上长按改，不能只靠这个常量。
    private static final String DEFAULT_URL = "http://192.168.30.153:3200/quality-maxhub.html";
    private static final String OFFLINE_URL = "file:///android_asset/quality-static.html";

    /** 降级后重试联网的间隔。比页面自身 60 秒的刷新节奏略长，避免两者打架。 */
    private static final long RETRY_MS = 90_000L;

    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());

    /** 当前是否处于离线快照状态。只有它为 true 时重试才有意义。 */
    private boolean showingOffline = false;

    /**
     * 本次启动是否已经弹过地址设置框。
     *
     * 连不上时要弹一次让人填地址，否则换台机器部署时，装完只看到一屏离线快照，
     * 不知道还能长按改地址 —— 这个手势是藏起来的，不主动提示等于没有。
     * 但只弹第一次：看板平时无人值守，每 90 秒重试失败就弹一个框会没法看。
     */
    private boolean promptedThisSession = false;

    private final Runnable retryOnline = new Runnable() {
        @Override public void run() {
            if (showingOffline) {
                showingOffline = false;      // 先复位，失败时 onReceivedError 会再置回来
                web.loadUrl(serverUrl());
            }
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 看板长期通电显示，息屏就失去意义了
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);   // 加载间隙别闪白，大屏上很刺眼

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);          // 整个 App 存在的意义就是这一行
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // 不缓存：看板要的是最新数字，宁可多走一次网络
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient() {

            // API 23+：能区分主文档和子资源。子资源失败（比如某个图标 404）
            // 不该把整个页面降级成离线快照，所以必须判 isForMainFrame。
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && req.isForMainFrame()) {
                    fallbackOffline();
                }
            }

            // API 23 以下只有这个旧签名，它本身就只在主文档失败时回调
            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int code, String desc, String failingUrl) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                    fallbackOffline();
                }
            }
        });

        // 长按打开设置。没有地址栏、没有菜单键，这是唯一的入口 ——
        // 既然要藏起来不让人误触，就得留个自己知道的手势。
        web.setOnLongClickListener(v -> { showSettings(); return true; });

        setContentView(web);
        goImmersive();

        // 全新安装（还没存过地址）时先问一次。转接给别的机器时，装完第一眼就是
        // 填地址，不用去猜打包时写死的是谁的 IP。
        if (!prefs().contains(KEY_URL)) {
            promptedThisSession = true;
            showSettings();
        } else {
            web.loadUrl(serverUrl());
        }
    }

    private String serverUrl() {
        return prefs().getString(KEY_URL, DEFAULT_URL);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void fallbackOffline() {
        showingOffline = true;
        web.loadUrl(OFFLINE_URL);
        Toast.makeText(this, "连不上服务器，显示离线快照（数据不会更新）", Toast.LENGTH_LONG).show();
        handler.removeCallbacks(retryOnline);
        handler.postDelayed(retryOnline, RETRY_MS);

        if (!promptedThisSession) {
            promptedThisSession = true;
            showSettings();
        }
    }

    private void showSettings() {
        final EditText input = new EditText(this);
        input.setText(serverUrl());
        input.setSelectAllOnFocus(true);

        new AlertDialog.Builder(this)
                .setTitle("服务器地址")
                .setMessage("电脑上运行 server.js 后，启动日志里会打印一行内网地址，照抄到这里。\n"
                        + "换电脑、换网络、IP 变了都在这里改，不用重装 App。\n\n"
                        + "当前：" + serverUrl())
                .setView(input)
                .setPositiveButton("保存并重新加载", (d, w) -> {
                    String url = input.getText().toString().trim();
                    if (url.isEmpty()) return;
                    prefs().edit().putString(KEY_URL, url).apply();
                    showingOffline = false;
                    handler.removeCallbacks(retryOnline);
                    web.loadUrl(url);
                })
                .setNeutralButton("看离线快照", (d, w) -> {
                    showingOffline = false;                 // 手动选的，别自动跳回联网
                    handler.removeCallbacks(retryOnline);
                    web.loadUrl(OFFLINE_URL);
                })
                .setNegativeButton("取消", null)
                // 首次安装时如果直接取消，WebView 还没 load 过任何东西，会是一片纯黑，
                // 看着就像 App 崩了。这种情况下退到离线快照，至少屏上有内容。
                .setOnDismissListener(d -> {
                    if (web != null && web.getUrl() == null) {
                        web.loadUrl(OFFLINE_URL);
                    }
                })
                .show();
    }

    /** 沉浸式全屏：藏掉状态栏和导航栏，看板要占满整块屏。 */
    private void goImmersive() {
        web.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();   // 系统弹过通知栏之后要重新藏回去
    }

    /**
     * 返回键：能回退就回退，回不动了才刷新。
     *
     * 早先这里无条件 reload()，结果从看板点进 OA 配置页后按返回是原地重新加载
     * 同一页，现场反馈是「按了没反应、卡住了」。看板场景下确实不该退出 App
     * （只会留个桌面在那儿），但也不能把 WebView 的历史栈一起废掉。
     */
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            web.reload();
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(retryOnline);
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
