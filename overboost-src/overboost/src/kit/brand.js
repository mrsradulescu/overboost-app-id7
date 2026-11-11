'use strict';
/** OVERBOOST: the logo (src/logo.rgba: 8-byte header w,h LE + RGBA) as pixel image 7001, shared by the menu and every app's header. */
const fs = require('fs');
const path = require('path');
const rec = require('./record');
const ID = 7001;
let brand = null;
try {
    // (an update lives in data/; the logo stays with the install: OVERBOOST_SRC)
    const b = fs.readFileSync(path.join(process.env.OVERBOOST_SRC || path.join(__dirname, '..'), 'logo.rgba'));
    const w = b.readUInt32LE(0), h = b.readUInt32LE(4);
    rec.setImage(ID, w, h, new Uint8Array(b.buffer, b.byteOffset + 8, w * h * 4));
    brand = { id: ID, w, h };
} catch (e) { /* no logo file: the name is written instead */ }
module.exports = brand;
