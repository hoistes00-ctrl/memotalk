package kr.memotalk.app;

import java.io.IOException;
import java.util.Arrays;

/** Append-only SAF writer. Replacement of existing different data is deliberately unsupported. */
public final class VerifiedDocumentWriter {
    public interface Store {
        byte[] readTarget() throws Exception;
        String createTemporary() throws Exception;
        void writeAndSync(String temporary, byte[] content) throws Exception;
        byte[] readTemporary(String temporary) throws Exception;
        void publish(String temporary) throws Exception;
        void cleanupTemporary(String temporary) throws Exception;
    }
    public static final class Failure extends IOException {
        public final String code;
        public final String operation;
        Failure(String code, String operation) {super(code);this.code=code;this.operation=operation;}
        Failure(String code, String operation, Exception cause) {super(code,cause);this.code=code;this.operation=operation;}
    }
    public static void write(Store store, byte[] content, byte[] expected) throws Exception {
        String temporary=null, operation="compare";
        try {
            byte[] current=store.readTarget();
            if(!Arrays.equals(current,expected))throw new Failure("ESTALE",operation);
            if(Arrays.equals(current,content))return;
            if(current!=null)throw new Failure("EOPNOTSUPP","replace-existing");
            operation="create-temp";temporary=store.createTemporary();
            operation="write-and-sync-temp";store.writeAndSync(temporary,content);
            operation="verify-temp";
            if(!Arrays.equals(store.readTemporary(temporary),content))throw new Failure("EIO",operation);
            operation="compare-before-publish";
            if(store.readTarget()!=null)throw new Failure("ESTALE",operation);
            operation="publish";store.publish(temporary);temporary=null;
            operation="verify-target";
            if(!Arrays.equals(store.readTarget(),content))throw new Failure("EIO",operation);
        } catch(Failure error) {throw error;}
        catch(Exception error) {
            String code=error instanceof SecurityException?"EACCES":error instanceof UnsupportedOperationException?"EOPNOTSUPP":"EIO";
            throw new Failure(code,operation,error);
        } finally {
            if(temporary!=null)try{store.cleanupTemporary(temporary);}catch(Exception ignored){}
        }
    }
}
