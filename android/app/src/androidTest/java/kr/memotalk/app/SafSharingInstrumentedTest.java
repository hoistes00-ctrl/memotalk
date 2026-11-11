package kr.memotalk.app;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.Until;
import java.util.regex.Pattern;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.InvocationTargetException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Actual emulator ExternalStorageProvider and WebView. Only new synthetic folders are used. */
@RunWith(AndroidJUnit4.class)
public class SafSharingInstrumentedTest {
    // Test wait bounds, not application interaction settings.
    private static final long WAIT_MS=30000,POLL_MS=100;
    private Instrumentation instrumentation;
    private MainActivity activity;
    private WebView web;
    private String token;
    private Method perform;
    @Before public void setUp() throws Exception {
        instrumentation=InstrumentationRegistry.getInstrumentation();
        instrumentation.getUiAutomation().adoptShellPermissionIdentity(
            "android.permission.MANAGE_DOCUMENTS","android.permission.MANAGE_EXTERNAL_STORAGE",
            "android.permission.READ_EXTERNAL_STORAGE","android.permission.WRITE_EXTERNAL_STORAGE");
        String leaf="MemoTalkNativeTest-"+UUID.randomUUID();
        try(InputStream shell=new FileInputStream(instrumentation.getUiAutomation().executeShellCommand("mkdir -p /sdcard/Documents/"+leaf).getFileDescriptor())){
            while(shell.read()!=-1){}
        }
        Context target=instrumentation.getTargetContext();
        target.getSharedPreferences("memotalk-native",Context.MODE_PRIVATE).edit().clear().commit();
        activity=(MainActivity)instrumentation.startActivitySync(new Intent(target,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Field root=MainActivity.class.getDeclaredField("rootTree");root.setAccessible(true);
        root.set(activity,DocumentsContract.buildTreeDocumentUri("com.android.externalstorage.documents","primary:Documents/"+leaf));
        Field nonce=MainActivity.class.getDeclaredField("folderToken");nonce.setAccessible(true);
        Field view=MainActivity.class.getDeclaredField("web");view.setAccessible(true);web=(WebView)view.get(activity);
        perform=MainActivity.class.getDeclaredMethod("perform",String.class,JSONObject.class);perform.setAccessible(true);
        waitJavaScript("typeof window.MemoTalkPeer==='object' && typeof window.MemoTalkFS==='object'");
        js("localStorage.clear()");
        // Use the exact system-picker grant path used by a real user. Shell identity
        // cannot grant arbitrary document-tree access and is dropped before choosing.
        instrumentation.getUiAutomation().dropShellPermissionIdentity();
        final String oldToken=(String)nonce.get(activity);
        Method choose=MainActivity.class.getDeclaredMethod("chooseDirectory",int.class,String.class);choose.setAccessible(true);
        instrumentation.runOnMainSync(()->{try{choose.invoke(activity,999,"instrumentation-session");}catch(Exception e){throw new RuntimeException(e);}});
        UiDevice device=UiDevice.getInstance(instrumentation);
        UiObject2 select=device.wait(Until.findObject(By.text(Pattern.compile("(?i)use this folder"))),WAIT_MS);
        if(select==null)select=device.wait(Until.findObject(By.res(Pattern.compile(".*:id/action_menu_select"))),WAIT_MS);
        assertNotNull("System folder picker did not expose selection in "+device.getCurrentPackageName(),select);
        assertTrue("Test folder is not selectable",select.isEnabled());select.click();
        UiObject2 allow=device.wait(Until.findObject(By.text(Pattern.compile("(?i)allow"))),5000);
        if(allow!=null)allow.click();
        long until=System.currentTimeMillis()+WAIT_MS;
        while(oldToken.equals(nonce.get(activity))&&System.currentTimeMillis()<until)Thread.sleep(POLL_MS);
        assertNotEquals("Folder picker did not grant access",oldToken,nonce.get(activity));
        token=(String)nonce.get(activity);
        assertEquals("System picker must select only the new synthetic test directory","primary:Documents/"+leaf,DocumentsContract.getTreeDocumentId((Uri)root.get(activity)));
        assertTrue("Persistent tree permission must be held",target.getContentResolver().getPersistedUriPermissions().stream().anyMatch(p->p.isReadPermission()&&p.isWritePermission()&&p.getUri().equals(rootUri(activity))));
    }
    private Uri rootUri(MainActivity owner){try{Field field=MainActivity.class.getDeclaredField("rootTree");field.setAccessible(true);return (Uri)field.get(owner);}catch(Exception e){throw new RuntimeException(e);}}
    @After public void tearDown(){
        if(activity!=null)instrumentation.runOnMainSync(()->activity.finish());
        if(instrumentation!=null)instrumentation.getUiAutomation().dropShellPermissionIdentity();
    }
    private Object command(String command,JSONObject args)throws Exception{
        args.put("folderToken",token);
        try{return perform.invoke(activity,command,args);}catch(InvocationTargetException e){throw (Exception)e.getCause();}
    }
    private JSONObject args(String...parts)throws Exception{return new JSONObject().put("path",new JSONArray(parts));}
    private void write(String filename,byte[] bytes)throws Exception{
        String[] parts=filename.split("/");
        for(int i=1;i<parts.length;i++){
            String[] parents=new String[i];System.arraycopy(parts,0,parents,0,i);command("mkdir",args(parents));
        }
        command("write",args(parts).put("base64",Base64.encodeToString(bytes,Base64.NO_WRAP)).put("expectedBase64",JSONObject.NULL));
    }
    private String js(String source)throws Exception{
        CountDownLatch latch=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>();
        instrumentation.runOnMainSync(()->web.evaluateJavascript(source,result->{value.set(result);latch.countDown();}));
        assertTrue("WebView evaluation timed out",latch.await(WAIT_MS,TimeUnit.MILLISECONDS));return value.get();
    }
    private void waitJavaScript(String predicate)throws Exception{
        long until=System.currentTimeMillis()+WAIT_MS;String last="";
        while(System.currentTimeMillis()<until){last=js("Boolean("+predicate+")");if("true".equals(last))return;Thread.sleep(POLL_MS);}
        fail("WebView predicate timed out: "+predicate+"; "+last+"; page="+js("document.body.innerText"));
    }
    @Test public void safWritesVerifiedDocumentAndRefusesOverwrite()throws Exception{
        write("operations/first.json","synthetic".getBytes(StandardCharsets.UTF_8));
        JSONObject data=(JSONObject)command("read",args("operations","first.json"));
        assertEquals("synthetic",new String(Base64.decode(data.getString("base64"),Base64.DEFAULT),StandardCharsets.UTF_8));
        try{command("write",args("operations","first.json").put("base64",Base64.encodeToString("changed".getBytes(StandardCharsets.UTF_8),Base64.NO_WRAP)).put("expectedBase64",data.getString("base64")));fail("must not replace");}
        catch(VerifiedDocumentWriter.Failure expected){assertEquals("EOPNOTSUPP",expected.code);}
        JSONArray list=(JSONArray)command("list",args("operations"));assertEquals(1,list.length());assertEquals("first.json",list.getJSONObject(0).getString("name"));
    }
    @Test public void actualAndroidBridgeCryptoAndFolderLeaseWork()throws Exception{
        js("localStorage.setItem('memotalk.nativeFolder.linkId','test-native-link');window.__nativeResult=null;(async()=>{const linked=await MemoTalkFS.restore();await MemoTalkFS.beginMirror(linked.handle);try{const dir=await linked.handle.getDirectoryHandle('bridge',{create:true});const file=await dir.getFileHandle('bridge.json',{create:true});const writer=await file.createWritable({expectedBytes:null});await writer.write('actual Android WebView');await writer.close();return {text:await (await file.getFile()).text(),hash:await MemoTalkPeer.hash({actual:true})};}finally{await MemoTalkFS.endMirror(linked.handle);}})().then(result=>window.__nativeResult={ok:true,result}).catch(error=>window.__nativeResult={ok:false,error:error.message,code:error.code})");
        waitJavaScript("window.__nativeResult!==null");JSONObject result=new JSONObject(js("window.__nativeResult"));
        assertTrue(result.toString(),result.getBoolean("ok"));assertEquals("actual Android WebView",result.getJSONObject("result").getString("text"));assertEquals(64,result.getJSONObject("result").getString("hash").length());
    }
    @Test public void oldFolderTokenRejected()throws Exception{
        Field field=MainActivity.class.getDeclaredField("folderToken");field.setAccessible(true);field.set(activity,UUID.randomUUID().toString());
        try{command("stat",args());fail("old token accepted");}catch(VerifiedDocumentWriter.Failure expected){assertEquals("ESTALE",expected.code);}
    }
    @Test public void windowsRevisionsReachAndroidAndAndroidReplyIsPublished()throws Exception{
        String fixture;
        try(InputStream in=instrumentation.getContext().getAssets().open("peer-windows.json")){
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int count;while((count=in.read(buffer))!=-1)bytes.write(buffer,0,count);fixture=bytes.toString("UTF-8");
        }
        JSONObject data=new JSONObject(fixture),group=data.getJSONObject("group");
        write("memotalk-peer-group.json",group.toString().getBytes(StandardCharsets.UTF_8));
        JSONArray operations=data.getJSONArray("operations");
        for(int i=0;i<operations.length();i++){
            JSONObject op=operations.getJSONObject(i);write("memotalk-peer-v1/operations/"+op.getString("id")+".json",op.toString().getBytes(StandardCharsets.UTF_8));
        }
        String initial="{seeded:true,rooms:{pairedroom:{id:'pairedroom',name:'기기 간 실제 테스트',createdAt:1}},msgs:{pairedroom:[{id:'androidmemo',ts:2,text:'Android initial'}]}}";
        js("localStorage.setItem('memotalk.v1',JSON.stringify("+initial+"));localStorage.setItem('memotalk.nativeFolder.linkId','"+group.getString("id")+"');localStorage.setItem('memotalk.peer.config',JSON.stringify({enabled:true,groupId:'"+group.getString("id")+"'}));localStorage.setItem('memotalk.peer.poll','200');localStorage.setItem('memotalk.peer.debounce','50');location.reload();");
        waitJavaScript("JSON.parse(localStorage.getItem('memotalk.v1')).msgs.pairedroom.some(m=>m.text==='Windows fixture edit')");
        js("document.querySelector('.room[data-id=pairedroom]').click();document.querySelector('#input').value='Android real WebView reply';document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#btn-send').click();");
        waitJavaScript("JSON.parse(localStorage.getItem('memotalk.v1')).msgs.pairedroom.some(m=>m.text==='Android real WebView reply')");
        // Native I/O is owned by the JS lease while it polls. Inspect the immutable files
        // only after the tick reports completion and before the next poll.
        waitJavaScript("document.querySelector('#file-sync-state').textContent.includes('양방향 주기 처리')");
        js("window.__testReload=true;localStorage.setItem('memotalk.peer.poll','2147483647');location.reload();");
        waitJavaScript("window.__testReload===undefined && typeof window.MemoTalkPeer==='object'");
        waitJavaScript("document.querySelector('#file-sync-state').textContent.includes('양방향 주기 처리')");
        JSONArray listing=(JSONArray)command("list",args("memotalk-peer-v1","operations"));
        File export=new File(activity.getFilesDir(),"peer-return");assertTrue(export.exists()||export.mkdirs());
        boolean found=false;
        for(int i=0;i<listing.length();i++){
            String name=listing.getJSONObject(i).getString("name");
            JSONObject file=(JSONObject)command("read",args("memotalk-peer-v1","operations",name));
            byte[] content=Base64.decode(file.getString("base64"),Base64.DEFAULT);
            JSONObject revision=new JSONObject(new String(content,StandardCharsets.UTF_8));
            JSONObject value=revision.optJSONObject("value");if(value!=null&&"Android real WebView reply".equals(value.optString("text")))found=true;
            try(FileOutputStream out=new FileOutputStream(new File(export,name))){out.write(content);}
        }
        assertTrue("Android reply operation was not published",found);
    }
}
