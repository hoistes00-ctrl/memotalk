package kr.memotalk.app;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import android.content.ActivityNotFoundException;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.FileOutputStream;
import android.os.ParcelFileDescriptor;
import java.util.Arrays;
import java.util.UUID;
import java.io.FileNotFoundException;
import android.system.ErrnoException;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** MemoTalk's bundled offline HTML, with SAF-based directory access.
 *  Data in this WebView does NOT automatically share a browser's localStorage.
 */
public class MainActivity extends Activity {
    private static final int REQUEST_TREE = 8201;
    private static final int REQUEST_EXPORT = 8202;
    private static final int REQUEST_FILE = 8203;
    private static final int MAX_FILE = 64 * 1024 * 1024;
    private WebView web;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;
    private volatile Uri rootTree;
    private volatile String folderToken=UUID.randomUUID().toString();
    private volatile String mirrorLease;
    private int waitingRequestId = -1;
    private String waitingExportBase64;
    private ValueCallback<Uri[]> fileChooserCallback;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        // Keep the message history scrollable above the on-screen keyboard.
        getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        prefs = getSharedPreferences("memotalk-native", MODE_PRIVATE);
        String saved = prefs.getString("rootTree", null);
        if (saved != null) rootTree = Uri.parse(saved);
        web = new WebView(this);
        // Android 15 (targetSdk 35) draws edge-to-edge. Explicitly reserve
        // the IME and navigation-bar area instead of letting the keyboard
        // cover the HTML composer. Older Android keeps adjustResize.
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            FrameLayout root = new FrameLayout(this);
            root.setClipToPadding(true);
            root.setFitsSystemWindows(false);
            root.addView(web, new FrameLayout.LayoutParams(-1, -1));
            // One inset owner: native container pads for status/navigation/IME;
            // WebView receives already safe dimensions and must not apply them
            // again in CSS (important on Samsung keyboard / Android 15).
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                int bottom = Math.max(bars.bottom, ime.bottom);
                if (root.getPaddingLeft() != bars.left || root.getPaddingTop() != bars.top ||
                        root.getPaddingRight() != bars.right || root.getPaddingBottom() != bottom) {
                    root.setPadding(bars.left, bars.top, bars.right, bottom);
                }
                // These insets are applied above; do not dispatch them to
                // the nested WebView where they can cause a second adjustment.
                return WindowInsets.CONSUMED;
            });
            setContentView(root);
            root.requestApplyInsets();
        } else {
            setContentView(web);
        }
        // The document's .msgs is the vertical scroller, not the entire WebView.
        web.setVerticalScrollBarEnabled(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.addJavascriptInterface(new NativeBridge(), "AndroidMemoTalk");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                                      FileChooserParams params) {
                if(fileChooserCallback!=null)fileChooserCallback.onReceiveValue(null);
                fileChooserCallback=callback;
                try {
                    Intent chooser=params.createIntent();
                    chooser.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(chooser,REQUEST_FILE);
                    return true;
                } catch(Exception error) {
                    fileChooserCallback=null;
                    callback.onReceiveValue(null);
                    return false;
                }
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!"appassets.androidplatform.net".equals(url.getHost())) return null;
                String pathname = url.getPath();
                if(pathname == null) return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, null);
                String name = pathname.startsWith("/") ? pathname.substring(1) : pathname;
                if(!name.equals("index.html") && !name.equals("platform-bridge.js") && !name.equals("mirror-engine.js") && !name.equals("peer-sync-engine.js") && !name.equals("peer-sync-client.js"))
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, null);
                try {
                    InputStream file = getAssets().open(name);
                    return new WebResourceResponse(name.endsWith(".js")?"application/javascript":"text/html", "utf-8", file);
                } catch (Exception error) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, null);
                }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("appassets.androidplatform.net".equals(url.getHost())) return false;
                // Open user-tapped external links in the device browser.
                if (request.isForMainFrame()) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, url)); } catch (Exception ignored) {}
                    return true;
                }
                return false;
            }
        });
        web.loadUrl("https://appassets.androidplatform.net/index.html");
    }

    final class NativeBridge {
        @JavascriptInterface public void postMessage(String payload) {
            io.execute(() -> {
                int id = -1;
                String command="request";JSONObject args=null;
                try {
                    JSONObject req = new JSONObject(payload);
                    id = req.getInt("id");
                    command = req.getString("command");
                    args = req.optJSONObject("args");
                    if(args==null) args = new JSONObject();
                    if (command.equals("pickFolder")) {
                        final int callbackId=id;
                        runOnUiThread(() -> chooseDirectory(callbackId));
                        return;
                    }
                    if (command.equals("download")) {
                        final int callbackId=id;
                        final JSONObject data=args;
                        runOnUiThread(() -> exportFile(callbackId, data));
                        return;
                    }
                    respond(id, perform(command,args), null);
                } catch (Exception error) { respond(id, null, describeFailure(error,command,args)); }
            });
        }
    }
    private void respond(int id, Object result, Object failure) {
        try {
            JSONObject response = new JSONObject();
            response.put("id", id);
            if(failure != null) response.put("error", failure);
            else response.put("result", result == null ? JSONObject.NULL : result);
            String script = "window.__memoNativeResolve && window.__memoNativeResolve(" + response.toString() + ")";
            runOnUiThread(() -> { if (web != null) web.evaluateJavascript(script,null); });
        } catch (JSONException ignored) {}
    }
    private JSONObject describeFailure(Exception error,String command,JSONObject args) {
        JSONObject out=new JSONObject();
        try {
            String code=error instanceof VerifiedDocumentWriter.Failure?((VerifiedDocumentWriter.Failure)error).code:
                error instanceof SecurityException?"EACCES":error instanceof FileNotFoundException?"ENOENT":
                "NotFoundError".equals(error.getMessage())?"ENOENT":"EIO";
            out.put("message",String.valueOf(error.getMessage()));out.put("code",code);
            out.put("operation",error instanceof VerifiedDocumentWriter.Failure?((VerifiedDocumentWriter.Failure)error).operation:command);
            JSONArray path=args==null?null:args.optJSONArray("path");StringBuilder relative=new StringBuilder();
            if(path!=null)for(int i=0;i<path.length();i++){if(i>0)relative.append('/');relative.append(path.optString(i));}
            out.put("relativePath",relative.toString());
            Throwable cause=error;while(cause!=null){if(cause instanceof ErrnoException){out.put("errno",((ErrnoException)cause).errno);String detail=cause.getMessage();int cut=detail==null?-1:detail.indexOf(" failed:");out.put("syscall",cut>0?detail.substring(0,cut):command);out.put("nativeMessage",detail);break;}cause=cause.getCause();}
        }catch(Exception ignored){}
        return out;
    }
    private Exception nativeFailure(String code,String operation){return new VerifiedDocumentWriter.Failure(code,operation);}
    private JSONObject folderStatus() throws Exception {
        JSONObject obj=new JSONObject();obj.put("connected",rootTree!=null);obj.put("name",getTreeName());
        obj.put("folderToken",folderToken);obj.put("atomicWrites",true);return obj;
    }
    private void chooseDirectory(int id) {
        if(mirrorLease!=null||waitingRequestId!=-1){respond(id,null,describeFailure((Exception)nativeFailure("EBUSY","pickFolder"),"pickFolder",null));return;}
        waitingRequestId = id;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.putExtra(Intent.EXTRA_LOCAL_ONLY,true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {startActivityForResult(intent, REQUEST_TREE);}
        catch (Exception e) {waitingRequestId=-1; respond(id,null,e.getMessage());}
    }
    private void exportFile(int id, JSONObject args) {
        if(waitingRequestId!=-1){respond(id,null,describeFailure((Exception)nativeFailure("EBUSY","download"),"download",args));return;}
        waitingRequestId=id;
        waitingExportBase64=args.optString("base64", "");
        String name=args.optString("name", "MemoTalk.zip").replaceAll("[\\\\/\\p{Cntrl}]", "_");
        String mime = name.endsWith(".zip") ? "application/zip" : name.endsWith(".json") ? "application/json" :
                name.endsWith(".pdf") ? "application/pdf" : name.endsWith(".html") ? "text/html" : "application/octet-stream";
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE,name);
        try {startActivityForResult(intent, REQUEST_EXPORT);}
        catch (Exception e) { waitingRequestId=-1;waitingExportBase64=null;respond(id,null,e.getMessage()); }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent intent) {
        super.onActivityResult(requestCode,resultCode,intent);
        if(requestCode==REQUEST_FILE) {
            if(fileChooserCallback!=null) {
                Uri[] files=WebChromeClient.FileChooserParams.parseResult(resultCode,intent);
                fileChooserCallback.onReceiveValue(files);
                fileChooserCallback=null;
            }
            return;
        }
        if (requestCode != REQUEST_TREE && requestCode != REQUEST_EXPORT) return;
        int id=waitingRequestId; waitingRequestId=-1;
        if(resultCode!=RESULT_OK || intent==null || intent.getData()==null) {
            waitingExportBase64=null;respond(id,null,"cancelled");return;
        }
        Uri uri=intent.getData();
        if(requestCode==REQUEST_TREE) {
            try {
                if(mirrorLease!=null)throw nativeFailure("EBUSY","pickFolder");
                int granted=intent.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                if(granted!=(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION))throw nativeFailure("EACCES","pickFolder");
                getContentResolver().takePersistableUriPermission(uri,granted);
                rootTree=uri;folderToken=UUID.randomUUID().toString();prefs.edit().putString("rootTree",uri.toString()).apply();
                try { respond(id,folderStatus(),null); }
                catch(Exception e) {respond(id,null,e.getMessage());}
            } catch (Exception e) {respond(id,null,e.getMessage());}
        } else {
            String content=waitingExportBase64;waitingExportBase64=null;
            io.execute(() -> {
                try {
                    byte[] data=Base64.decode(content,Base64.DEFAULT);
                    if(data.length>MAX_FILE)throw new Exception("64MB 이상의 파일은 현재 앱에서 내보낼 수 없습니다");
                    try (OutputStream stream=getContentResolver().openOutputStream(uri,"wt")) {
                        if(stream==null)throw new Exception("파일 쓰기 실패");
                        stream.write(data);
                    }
                    respond(id,true,null);
                } catch(Exception e) { respond(id,null,e.getMessage()); }
            });
        }
    }
    private String getTreeName() {
        if(rootTree==null) return "";
        String id=DocumentsContract.getTreeDocumentId(rootTree);
        int slash=id.lastIndexOf(':');
        return slash>=0 ? id.substring(slash+1) : "선택한 폴더";
    }
    private Uri getRootDoc() throws Exception {
        if(rootTree==null) throw new Exception("저장 폴더 연결이 필요합니다");
        return DocumentsContract.buildDocumentUriUsingTree(rootTree,DocumentsContract.getTreeDocumentId(rootTree));
    }
    private String[] checkedParts(JSONArray path, boolean allowRoot) throws Exception {
        if(path==null || path.length()>32 || (!allowRoot && path.length()==0))throw new Exception("잘못된 경로");
        String[] parts=new String[path.length()];
        for(int i=0;i<parts.length;i++) {
            String name=path.getString(i);
            if(name.length()==0 || name.equals(".") || name.equals("..") || name.contains("/") || name.contains("\\") || name.indexOf('\0')>=0)
                throw new Exception("허용되지 않는 파일 이름");
            parts[i]=name;
        }
        return parts;
    }
    private String kindOf(String mime) {return DocumentsContract.Document.MIME_TYPE_DIR.equals(mime) ? "directory" : "file";}
    private JSONObject nodeInfo(boolean exists, String mime) throws Exception {
        JSONObject result=new JSONObject();result.put("exists",exists);
        if(exists)result.put("kind",kindOf(mime));
        return result;
    }
    private static final class Child {Uri uri;String mime;Child(Uri u,String m){uri=u;mime=m;}}
    private Child findChild(Uri dir,String name) throws Exception {
        Uri listing=DocumentsContract.buildChildDocumentsUriUsingTree(rootTree,DocumentsContract.getDocumentId(dir));
        try(Cursor cursor=getContentResolver().query(listing,
            new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE}, null,null,null)) {
            if(cursor==null)throw new Exception("폴더를 읽을 수 없습니다");
            while(cursor.moveToNext()) {
                if(name.equals(cursor.getString(1))) {
                    Uri uri=DocumentsContract.buildDocumentUriUsingTree(rootTree,cursor.getString(0));
                    return new Child(uri,cursor.getString(2));
                }
            }
        }
        return null;
    }
    private Child traverse(String[] segments, boolean createFile, boolean createDirectory) throws Exception {
        Uri dir=getRootDoc();
        if(segments.length==0)return new Child(dir,DocumentsContract.Document.MIME_TYPE_DIR);
        for(int i=0;i<segments.length;i++) {
            String name=segments[i];
            Child child=findChild(dir,name);
            if(child==null && (i<segments.length-1 || createDirectory || createFile)) {
                if(i<segments.length-1)throw new Exception("상위 폴더 없음");
                String mime=createDirectory ? DocumentsContract.Document.MIME_TYPE_DIR : "application/octet-stream";
                Uri created=DocumentsContract.createDocument(getContentResolver(),dir,mime,name);
                if(created==null)throw new Exception("파일 생성에 실패했습니다");
                child=new Child(created,mime);
            }
            if(child==null)return null;
            if(i<segments.length-1 && !DocumentsContract.Document.MIME_TYPE_DIR.equals(child.mime))
                throw new Exception("폴더가 아닌 경로입니다");
            dir=child.uri;
            if(i==segments.length-1)return child;
        }
        return null;
    }
    private Object perform(String command,JSONObject args) throws Exception {
        if(command.equals("hasFolder"))return folderStatus();
        if(command.equals("disconnect")){
            if(mirrorLease!=null)throw nativeFailure("EBUSY",command);
            rootTree=null;folderToken=UUID.randomUUID().toString();prefs.edit().remove("rootTree").apply();return true;
        }
        if(!folderToken.equals(args.optString("folderToken")))throw nativeFailure("ESTALE",command);
        if(command.equals("beginMirror")){
            if(mirrorLease!=null)throw nativeFailure("EBUSY",command);
            mirrorLease=UUID.randomUUID().toString();JSONObject result=new JSONObject();result.put("leaseId",mirrorLease);return result;
        }
        if(mirrorLease!=null&&!mirrorLease.equals(args.optString("leaseId")))throw nativeFailure("EBUSY",command);
        if(command.equals("endMirror")){mirrorLease=null;return true;}
        String[] path=checkedParts(args.optJSONArray("path"),command.equals("list")||command.equals("stat"));
        Child child=traverse(path,false,command.equals("mkdir"));
        if(command.equals("stat")) return child==null?nodeInfo(false,null):nodeInfo(true,child.mime);
        if(command.equals("touch"))throw nativeFailure("EOPNOTSUPP",command);
        if(command.equals("mkdir")) {
            if(child==null)throw new Exception("파일 생성 오류");
            return nodeInfo(true,child.mime);
        }
        if(command.equals("write"))return verifiedWrite(path,args);
        if(child==null)throw new Exception("NotFoundError");
        if(command.equals("list")) {
            if(!"directory".equals(kindOf(child.mime)))throw new Exception("폴더가 아닙니다");
            Uri listing=DocumentsContract.buildChildDocumentsUriUsingTree(rootTree,DocumentsContract.getDocumentId(child.uri));
            JSONArray result=new JSONArray();
            try(Cursor c=getContentResolver().query(listing,
                new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE},null,null,null)) {
                if(c==null)throw new Exception("폴더 조회 실패");
                while(c.moveToNext()) {
                    JSONObject entry=new JSONObject();entry.put("name",c.getString(0));entry.put("kind",kindOf(c.getString(1)));
                    result.put(entry);
                }
            }
            return result;
        }
        if(command.equals("read")) {
            ByteArrayOutputStream out=new ByteArrayOutputStream();
            try(InputStream in=getContentResolver().openInputStream(child.uri)) {
                if(in==null)throw new Exception("파일 읽기 실패");
                byte[] buffer=new byte[8192];int n;
                while((n=in.read(buffer))!=-1) {out.write(buffer,0,n);if(out.size()>MAX_FILE)throw new Exception("64MB 제한 초과");}
            }
            JSONObject result=new JSONObject();result.put("base64",Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP));return result;
        }
        if(command.equals("remove")) {
            if(DocumentsContract.Document.MIME_TYPE_DIR.equals(child.mime)) {
                Uri listing=DocumentsContract.buildChildDocumentsUriUsingTree(rootTree,DocumentsContract.getDocumentId(child.uri));
                try(Cursor c=getContentResolver().query(listing,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID},null,null,null)) {
                    if(c==null || c.moveToFirst())throw new Exception("비어있지 않은 폴더는 삭제할 수 없습니다");
                }
            }
            if(!DocumentsContract.deleteDocument(getContentResolver(),child.uri))throw new Exception("삭제 실패");
            return true;
        }
        throw new Exception("알 수 없는 작업입니다: " + command);
    }
    private byte[] readDocument(Uri uri) throws Exception {
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        try(InputStream stream=getContentResolver().openInputStream(uri)){
            if(stream==null)throw new FileNotFoundException("document unavailable");
            byte[] buffer=new byte[8192];int count;
            while((count=stream.read(buffer))!=-1){bytes.write(buffer,0,count);if(bytes.size()>MAX_FILE)throw nativeFailure("EFBIG","read");}
        }
        return bytes.toByteArray();
    }
    private Object verifiedWrite(String[] path,JSONObject args) throws Exception {
        if(!args.has("expectedBase64"))throw nativeFailure("EINVAL","write");
        byte[] content=Base64.decode(args.getString("base64"),Base64.DEFAULT);
        byte[] expected=args.isNull("expectedBase64")?null:Base64.decode(args.getString("expectedBase64"),Base64.DEFAULT);
        if(content.length>MAX_FILE)throw nativeFailure("EFBIG","write");
        final String token=folderToken;
        String[] parents=Arrays.copyOf(path,path.length-1);
        Child parent=traverse(parents,false,false);
        if(parent==null||!DocumentsContract.Document.MIME_TYPE_DIR.equals(parent.mime))throw new FileNotFoundException("parent directory missing");
        final Uri directory=parent.uri;final String name=path[path.length-1];
        VerifiedDocumentWriter.write(new VerifiedDocumentWriter.Store(){
            private void check() throws Exception {if(!folderToken.equals(token))throw nativeFailure("ESTALE","write");}
            public byte[] readTarget() throws Exception {check();Child found=findChild(directory,name);return found==null?null:readDocument(found.uri);}
            public String createTemporary() throws Exception {
                check();Uri created=DocumentsContract.createDocument(getContentResolver(),directory,"application/octet-stream",".memotalk-"+UUID.randomUUID()+".tmp");
                if(created==null)throw new FileNotFoundException("temporary document unavailable");return created.toString();
            }
            public void writeAndSync(String temporary,byte[] bytes) throws Exception {
                check();try(ParcelFileDescriptor descriptor=getContentResolver().openFileDescriptor(Uri.parse(temporary),"rwt")){
                    if(descriptor==null)throw new FileNotFoundException("temporary descriptor unavailable");
                    try(ParcelFileDescriptor.AutoCloseOutputStream stream=new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)){
                        stream.write(bytes);stream.flush();stream.getFD().sync();
                    }
                }
            }
            public byte[] readTemporary(String temporary) throws Exception {check();return readDocument(Uri.parse(temporary));}
            public void publish(String temporary) throws Exception {
                check();if(findChild(directory,name)!=null)throw nativeFailure("ESTALE","publish");
                Uri published=DocumentsContract.renameDocument(getContentResolver(),Uri.parse(temporary),name);
                if(published==null)throw new UnsupportedOperationException("provider does not support verified rename");
                Child found=findChild(directory,name);
                if(found==null||!found.uri.equals(published))throw nativeFailure("EIO","verify-name");
            }
            public void cleanupTemporary(String temporary) throws Exception {DocumentsContract.deleteDocument(getContentResolver(),Uri.parse(temporary));}
        },content,expected);
        return true;
    }
    @Override public void onBackPressed() {
        if(web==null){super.onBackPressed();return;}
        web.evaluateJavascript("document.querySelector('#app')?.dataset.view === 'room'", result -> {
            if("true".equals(result))web.evaluateJavascript("document.querySelector('#btn-back')?.click()",null);
            else moveTaskToBack(true);
        });
    }
    @Override protected void onDestroy() {
        if(web!=null) {web.destroy();web=null;}
        io.shutdown(); super.onDestroy();
    }
}
