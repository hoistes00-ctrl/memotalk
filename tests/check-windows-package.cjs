'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('../windows/node_modules/@electron/asar');
const packaged = path.resolve('windows/dist/win-unpacked/resources');
const archive = path.join(packaged, 'app.asar');
for (const name of ['main.js', 'preload.js', 'verified-write.js']) {
  assert.deepEqual(asar.extractFile(archive, name), fs.readFileSync(path.join('windows', name)), name + ' must match tested source');
}
for (const name of ['index.html', 'platform-bridge.js', 'mirror-engine.js']) {
  assert.deepEqual(fs.readFileSync(path.join(packaged, 'web', name)), fs.readFileSync(path.join('shared', name)), name + ' must match tested UI');
}
const builtPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
const sourcePackage = JSON.parse(fs.readFileSync('windows/package.json', 'utf8'));
assert.equal(builtPackage.version, sourcePackage.version, 'Packaged version must match preview');
console.log('Verified packaged native writer, UI, snapshot engine and preview version.');
