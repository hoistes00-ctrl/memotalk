package kr.memotalk.app;

import java.util.HashMap;
import java.util.Map;

/** Lease-local document addresses only; never caches file contents or write checks. */
final class ReadDirectoryIndex<T> {
    interface Loader<T> { Map<String,T> load() throws Exception; }
    private final Map<String,Map<String,T>> directories=new HashMap<>();
    void clear(){directories.clear();}
    T find(String directory,String name,Loader<T> loader) throws Exception {
        Map<String,T> entries=directories.get(directory);
        if(entries!=null&&entries.containsKey(name))return entries.get(name);
        // Misses always query again: Obsidian can deliver new files during a cycle.
        Map<String,T> fresh=new HashMap<>(loader.load());
        directories.put(directory,fresh);
        return fresh.get(name);
    }
}
