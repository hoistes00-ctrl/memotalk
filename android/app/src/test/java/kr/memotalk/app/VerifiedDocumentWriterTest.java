package kr.memotalk.app;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Arrays;

public class VerifiedDocumentWriterTest {
    static final byte[] CONTENT=new byte[]{1,2,3,4};
    static class FakeStore implements VerifiedDocumentWriter.Store {
        byte[] target,temp;
        String failAt;
        boolean cleaned,published;
        void fail(String operation) throws Exception {if(operation.equals(failAt))throw new SecurityException("permission revoked");}
        public byte[] readTarget(){return target;}
        public String createTemporary() throws Exception {fail("create");temp=new byte[0];return "own-temp";}
        public void writeAndSync(String name,byte[] bytes)throws Exception{fail("write");temp=Arrays.copyOf(bytes,bytes.length);}
        public byte[] readTemporary(String name){return "truncate".equals(failAt)?new byte[]{1}:temp;}
        public void publish(String name)throws Exception{fail("publish");target=temp;temp=null;published=true;}
        public void cleanupTemporary(String name){cleaned=true;temp=null;}
    }
    @Test public void newFileVerifiedBeforePublication() throws Exception {
        FakeStore s=new FakeStore();VerifiedDocumentWriter.write(s,CONTENT,null);
        assertTrue(s.published);assertArrayEquals(CONTENT,s.target);assertNull(s.temp);
    }
    @Test public void differentExistingDataNeverReplaced() throws Exception {
        FakeStore s=new FakeStore();s.target=new byte[]{9};
        try{VerifiedDocumentWriter.write(s,CONTENT,s.target);fail();}
        catch(VerifiedDocumentWriter.Failure e){assertEquals("EOPNOTSUPP",e.code);}
        assertArrayEquals(new byte[]{9},s.target);assertNull(s.temp);assertFalse(s.published);
    }
    @Test public void staleExpectationRejected() throws Exception {
        FakeStore s=new FakeStore();s.target=new byte[]{9};
        try{VerifiedDocumentWriter.write(s,CONTENT,null);fail();}
        catch(VerifiedDocumentWriter.Failure e){assertEquals("ESTALE",e.code);}
        assertArrayEquals(new byte[]{9},s.target);
    }
    @Test public void sameContentIdempotent() throws Exception {
        FakeStore s=new FakeStore();s.target=CONTENT;
        VerifiedDocumentWriter.write(s,CONTENT,CONTENT);assertFalse(s.published);assertNull(s.temp);
    }
    @Test public void failureNeverLeavesFinalPlaceholder() throws Exception {
        for(String point:new String[]{"create","write","publish","truncate"}){
            FakeStore s=new FakeStore();s.failAt=point;
            try{VerifiedDocumentWriter.write(s,CONTENT,null);fail(point);}
            catch(VerifiedDocumentWriter.Failure e){assertNotNull(e.operation);}
            assertNull(point,s.target);assertNull(point,s.temp);assertFalse(s.published);
        }
    }
    @Test public void concurrentCreatorProtected() throws Exception {
        FakeStore s=new FakeStore(){int reads;@Override public byte[] readTarget(){if(++reads==2)target=new byte[]{9};return target;}};
        try{VerifiedDocumentWriter.write(s,CONTENT,null);fail();}
        catch(VerifiedDocumentWriter.Failure e){assertEquals("ESTALE",e.code);}
        assertArrayEquals(new byte[]{9},s.target);assertTrue(s.cleaned);
    }
}
