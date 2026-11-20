'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Fixed-size sibling name avoids appending a suffix to an already long memo filename.
const TEMP_RANDOM_BYTES = 12;
function error(code, operation) { return Object.assign(new Error(code), {code, operation}); }
async function readOrNull(target, io) {
  try { return await io.readFile(target); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
async function verifiedWrite(target, data, expected, io = fs) {
  const tmp = path.join(path.dirname(target), `.mt-${crypto.randomBytes(TEMP_RANDOM_BYTES).toString('hex')}.tmp`);
  let stage = 'compare', created = false;
  const same = (a,b) => a === null || b === null ? a === b : a.equals(b);
  try {
    if (!same(await readOrNull(target, io), expected)) throw error('ESTALE', stage);
    stage = 'create-temp';
    const handle = await io.open(tmp, 'wx'); created = true;
    try { stage = 'write-temp'; await handle.writeFile(data); stage = 'flush-temp'; await handle.sync(); }
    finally { await handle.close(); }
    stage = 'verify-temp';
    if (!data.equals(await io.readFile(tmp))) throw error('EIO', stage);
    stage = 'compare';
    if (!same(await readOrNull(target, io), expected)) throw error('ESTALE', stage);
    stage = 'commit';
    if (expected === null) {
      // Atomic no-replace publication. A concurrent creator is never overwritten.
      await io.link(tmp, target);
    } else {
      // The mirror layer has verified a history copy before requesting replacement.
      await io.rename(tmp, target);
      created = false;
    }
    stage = 'verify-target';
    if (!data.equals(await io.readFile(target))) throw error('EIO', stage);
    return true;
  } catch (err) {
    err.operation ||= stage;
    throw err;
  } finally {
    if (created) await io.rm(tmp, {force:true}).catch(() => {});
  }
}
module.exports = {verifiedWrite};
