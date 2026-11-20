/* Verified, resumable one-way mirror. No removal of user files. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MemoTalkMirror = factory();
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const INDEX = '.memotalk-file-index.json';
  const JOURNAL = '.memotalk-file-journal.json';
  const STATE = 'memotalk-sync-state.json';
  const MAX_METADATA_BYTES = 20 * 1024 * 1024;
  const encode = value => new TextEncoder().encode(JSON.stringify(value, null, 2));
  const same = (a, b) => a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]);
  function failure(code, path, operation) {
    return Object.assign(new Error(code), {code, relativePath:path, operation});
  }
  function validPath(path) {
    return typeof path === 'string' && path.length > 0 && path.split('/').every(part =>
      part && part !== '.' && part !== '..' && !/[\\\x00-\x1f<>:"|?*]/.test(part) && !/[. ]$/.test(part));
  }
  function checkFiles(files) {
    if (!files || Array.isArray(files) || typeof files !== 'object') throw failure('mirror_index', INDEX, 'parse');
    for (const [path, digest] of Object.entries(files)) {
      if (!validPath(path) || path.startsWith('.memotalk-') || typeof digest !== 'string') throw failure('mirror_index', path, 'parse');
    }
  }
  async function save({root, linkId, entries, read, write, digest, legacyDigest, transactionId}) {
    let currentPath = INDEX, operation = 'read';
    const load = async path => { currentPath = path; operation = 'read'; return read(root, path); };
    const parse = (data, path) => {
      if (data === null) return null;
      try {
        if (data.length > MAX_METADATA_BYTES) throw Error();
        return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(data));
      } catch (_) { throw failure('mirror_index', path, 'parse'); }
    };
    const put = async (path, data, expected) => {
      const current = await load(path);
      if (!same(current, expected)) throw failure('mirror_external', path, 'compare');
      currentPath = path; operation = 'write';
      await write(root, path, data, expected);
      const actual = await load(path);
      if (!same(actual, data)) throw failure('mirror_verify', path, 'verify');
    };
    try {
      const indexBytes = await load(INDEX), old = parse(indexBytes, INDEX);
      if (old) {
        if (old.format !== 'memotalk-file-mirror' || old.version !== 1 || old.linkId !== linkId) throw failure('mirror_other', INDEX, 'validate');
        checkFiles(old.files);
      }
      const journalBytes = await load(JOURNAL);
      let journal = parse(journalBytes, JOURNAL);
      if (journal) {
        if (journal.format !== 'memotalk-file-journal' || journal.version !== 1 || journal.linkId !== linkId) throw failure('mirror_other', JOURNAL, 'validate');
        checkFiles(journal.before); checkFiles(journal.after);
        if (old && Object.entries(journal.after).every(([path, hash]) => old.files[path] === hash)) journal = null;
      }
      if (!old && !journal) {
        for await (const entry of root.values()) throw failure('mirror_notempty', entry.name, 'preflight');
      }
      const wanted = new Map(entries);
      const names = new Set();
      for (const path of wanted.keys()) {
        const folded = path.toLowerCase();
        if (!validPath(path) || path.startsWith('.memotalk-') || folded === STATE || names.has(folded)) throw failure('mirror_path', path, 'preflight');
        names.add(folded);
      }
      const contentHashes = Object.fromEntries(await Promise.all([...wanted].sort(([a],[b])=>a<b?-1:a>b?1:0).map(async ([p, b]) => [p, await digest(b)])));
      // Dotfiles stay local in Obsidian Sync. This visible descriptor is a receiver
      // validation contract, never a claim that cloud upload has completed.
      const state = encode({format:'memotalk-sync-state',version:1,
        snapshotId:await digest(encode(contentHashes)),files:contentHashes});
      wanted.set(STATE,state);
      const after = {...contentHashes,[STATE]:await digest(state)};
      const before = {...(old?.files || {}), ...(journal?.before || {})};
      const observed = new Map();
      const watched = new Set([...Object.keys(before), ...Object.keys(journal?.after || {}), ...wanted.keys()]);
      // A missing file is never interpreted as an intentional deletion.
      for (const path of watched) {
        const data = await load(path), hash = data === null ? null : await digest(data);
        const previous = before[path], staged = journal?.after[path];
        const legacy = data !== null && legacyDigest ? legacyDigest(data) : null;
        if (data === null ? Boolean(previous) : hash !== previous && legacy !== previous && hash !== staged && hash !== after[path]) {
          throw failure('mirror_external', path, 'preflight');
        }
        observed.set(path, data);
        // Recovery may itself be interrupted after a new plan is journaled.
        // Record the bytes actually observed, including a prior plan's partial output.
        if (data !== null) before[path] = hash;
      }
      // Never silently abandon data from an interrupted transaction after local edits.
      for (const path of Object.keys(journal?.after || {})) {
        if (!wanted.has(path) && !before[path] && observed.get(path) !== null) before[path] = await digest(observed.get(path));
      }
      const nextJournal = {format:'memotalk-file-journal', version:1, linkId, transactionId, before, after};
      // Recheck index before beginning a transaction (other windows can be saving).
      if (!same(await load(INDEX), indexBytes)) throw failure('mirror_external', INDEX, 'compare');
      await put(JOURNAL, encode(nextJournal), journalBytes);
      let changed = 0;
      const rank = path => path === STATE ? 2 : path === 'manifest.json' ? 1 : 0;
      const ordered = [...wanted].sort((a,b) => rank(a[0]) - rank(b[0]));
      for (const [path, data] of ordered) {
        const previous = observed.get(path);
        if (same(previous, data)) continue;
        if (previous !== null) {
          const history = `.memotalk-history/${transactionId}/${path}`;
          await put(history, previous, null);
        }
        await put(path, data, previous);
        changed++;
      }
      // Read every output again, including unchanged files, before committing index.
      for (const [path, data] of wanted) {
        if (!same(await load(path), data)) throw failure('mirror_verify', path, 'verify');
      }
      // Keep obsolete paths in place and tracked; deletion requires a future explicit policy.
      const files = {...before, ...after};
      const index = {format:'memotalk-file-mirror', version:1, linkId, savedAt:new Date().toISOString(), files, activeFiles:[...wanted.keys()]};
      await put(INDEX, encode(index), indexBytes);
      // Keep the journal: it also permits recovery if the index write is interrupted.
      return {count:wanted.size, changed, retained:Object.keys(files).length-wanted.size};
    } catch (error) {
      error.relativePath ||= currentPath;
      error.operation ||= operation;
      error.code ||= error.name || 'UNKNOWN';
      throw error;
    }
  }
  async function verifySnapshot({root, read, digest}) {
    const initial = await read(root, STATE);
    let state;
    try {
      if (!initial || initial.length > MAX_METADATA_BYTES) throw Error();
      state = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(initial));
      if(state.format !== 'memotalk-sync-state' || state.version !== 1) throw Error();
      checkFiles(state.files);
      if(Object.hasOwn(state.files,STATE) || state.snapshotId !== await digest(encode(state.files))) throw Error();
    } catch (_) { throw failure('mirror_remote_pending', STATE, 'verify-snapshot'); }
    for(const [path, hash] of Object.entries(state.files)) {
      const data = await read(root,path);
      if(data === null || await digest(data) !== hash) throw failure('mirror_remote_pending', path, 'verify-snapshot');
    }
    if(!same(initial,await read(root,STATE))) throw failure('mirror_remote_pending', STATE, 'verify-snapshot');
    return {snapshotId:state.snapshotId,count:Object.keys(state.files).length};
  }
  return {save, verifySnapshot, same, validPath, INDEX, JOURNAL, STATE};
});
