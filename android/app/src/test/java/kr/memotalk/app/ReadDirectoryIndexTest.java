package kr.memotalk.app;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.HashMap;
import java.util.Map;

public class ReadDirectoryIndexTest {
    @Test public void sixHundredReadsEnumerateDirectoryOnce() throws Exception {
        ReadDirectoryIndex<String> index=new ReadDirectoryIndex<>();
        Map<String,String> files=new HashMap<>();
        for(int i=0;i<600;i++)files.put("op"+i,"uri"+i);
        int[] queries={0};
        for(int i=0;i<600;i++)assertEquals("uri"+i,index.find("operations","op"+i,()->{queries[0]++;return files;}));
        assertEquals(1,queries[0]);
        index.clear();
        index.find("operations","op0",()->{queries[0]++;return files;});
        assertEquals("A new lease must refresh document addresses",2,queries[0]);
    }
    @Test public void lateArrivalAndReplacedAddressAreRefreshed() throws Exception {
        ReadDirectoryIndex<String> index=new ReadDirectoryIndex<>();
        Map<String,String> files=new HashMap<>();files.put("old","first");
        assertEquals("first",index.find("dir","old",()->files));
        assertNull(index.find("dir","incoming",()->files));
        files.put("incoming","new");
        assertEquals("new",index.find("dir","incoming",()->files));
        files.put("old","replacement");index.clear();
        assertEquals("replacement",index.find("dir","old",()->files));
        assertNull(index.find("other-root","old",HashMap::new));
    }
    @Test public void failedQueriesDoNotPoisonCache() throws Exception {
        ReadDirectoryIndex<String> index=new ReadDirectoryIndex<>();
        try{index.find("dir","file",()->{throw new SecurityException("revoked");});fail();}
        catch(SecurityException expected){}
        assertEquals("fresh",index.find("dir","file",()->Map.of("file","fresh")));
    }
}
