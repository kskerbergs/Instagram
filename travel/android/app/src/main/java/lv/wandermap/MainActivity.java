package lv.wandermap;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * The offline Wandermap web app (bundled in assets) in a WebView, plus a small bridge for
 * sharing images and files, the clipboard, the back button and wandermap:// links.
 */
public class MainActivity extends Activity {

    // Assets are served from a fixed https origin so localStorage is a normal, persistent origin.
    private static final String HOST = "wandermap.local";
    private static final String HOME = "https://" + HOST + "/index.html";
    private static final int PICK_FILE = 1;

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("png", "image/png");
        MIME.put("svg", "image/svg+xml");
    }

    private WebView web;
    private ValueCallback<Uri[]> pendingUpload;
    private String pendingLink;
    private boolean pageReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // Follow the system font size, like Dynamic Type; the layout is in rem and scales with it.
        s.setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
        web.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "WandermapNative");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!HOST.equals(uri.getHost())) return null;
                String path = uri.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                try {
                    InputStream in = getAssets().open(path.substring(1));
                    String ext = path.substring(path.lastIndexOf('.') + 1);
                    String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
                    return new WebResourceResponse(mime, "utf-8", in);
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, null);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) return false;
                if ("wandermap".equals(uri.getScheme())) {
                    openLink(uri.toString());
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    // Nothing can open it.
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingUpload != null) pendingUpload.onReceiveValue(null);
                pendingUpload = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                try {
                    startActivityForResult(pick, PICK_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    pendingUpload = null;
                    return false;
                }
            }
        });

        pendingLink = linkFrom(getIntent());
        web.loadUrl(HOME);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String link = linkFrom(intent);
        if (link != null) openLink(link);
    }

    private static String linkFrom(Intent intent) {
        if (intent == null || intent.getData() == null) return null;
        return intent.getData().toString();
    }

    private void openLink(String link) {
        if (!pageReady) {
            pendingLink = link;
            return;
        }
        web.evaluateJavascript("window.wandermap && window.wandermap.openLink(" + jsString(link) + ")", null);
    }

    private static String jsString(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20 || c == 0x2028 || c == 0x2029) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("!!(window.wandermap && window.wandermap.onBack())", handled -> {
            if (!"true".equals(handled)) finish();
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == PICK_FILE && pendingUpload != null) {
            Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
            pendingUpload.onReceiveValue(uri == null ? null : new Uri[]{uri});
            pendingUpload = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ---- Sharing -----------------------------------------------------------------------

    private File writeShared(String name, byte[] bytes) throws IOException {
        File dir = new File(getCacheDir(), SharedFileProvider.DIR);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Cannot create " + dir);
        File f = new File(dir, new File(name).getName());
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(bytes);
        }
        return f;
    }

    private void shareBytes(String name, String mime, byte[] bytes, String text) {
        try {
            File f = writeShared(name, bytes);
            Uri uri = SharedFileProvider.uriFor(this, f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            if (text != null) send.putExtra(Intent.EXTRA_TEXT, text);
            send.setClipData(ClipData.newRawUri(name, uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(send, null));
        } catch (IOException | ActivityNotFoundException e) {
            toast("Could not share: " + e.getMessage());
        }
    }

    private void saveImage(String name, byte[] png) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Older Android needs a storage permission to write to Pictures; use the share sheet instead.
            shareBytes(name, "image/png", png, null);
            return;
        }
        ContentValues v = new ContentValues();
        v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        v.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Wandermap");
        Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
        if (uri == null) {
            toast("Could not save the image");
            return;
        }
        try (OutputStream out = getContentResolver().openOutputStream(uri)) {
            if (out == null) throw new IOException("no output stream");
            out.write(png);
            toast("Saved to Pictures/Wandermap");
        } catch (IOException e) {
            toast("Could not save: " + e.getMessage());
        }
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }

    /** Methods the page calls as window.WandermapNative.*. They run on a binder thread. */
    private class Bridge {
        @JavascriptInterface
        public void ready() {
            runOnUiThread(() -> {
                pageReady = true;
                if (pendingLink != null) {
                    String link = pendingLink;
                    pendingLink = null;
                    openLink(link);
                }
            });
        }

        @JavascriptInterface
        public void shareImage(String base64, String name, String text) {
            byte[] png = Base64.decode(base64, Base64.DEFAULT);
            runOnUiThread(() -> shareBytes(name, "image/png", png, text));
        }

        @JavascriptInterface
        public void saveImage(String base64, String name) {
            byte[] png = Base64.decode(base64, Base64.DEFAULT);
            runOnUiThread(() -> MainActivity.this.saveImage(name, png));
        }

        @JavascriptInterface
        public void shareFile(String name, String mime, String content) {
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            runOnUiThread(() -> shareBytes(name, mime, bytes, null));
        }

        @JavascriptInterface
        public void shareText(String text) {
            runOnUiThread(() -> {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_TEXT, text);
                try {
                    startActivity(Intent.createChooser(send, null));
                } catch (ActivityNotFoundException e) {
                    toast("Nothing to share with");
                }
            });
        }

        @JavascriptInterface
        public void copyText(String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("Wandermap", text));
            });
        }
    }
}
