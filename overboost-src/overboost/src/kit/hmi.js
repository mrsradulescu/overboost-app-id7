'use strict';
/**
 * Which head unit this build is for: flavor.json next to the app's code ({"hmi":"ID7"}) is written by the iDrive 7 package;
 * without it this is the iDrive 8 (MGU21) build.
 */
const fs = require('fs');
const path = require('path');
let id = 'ID8';
try { id = String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flavor.json'), 'utf8')).hmi || 'ID8').toUpperCase(); } catch (e) { /* ID8 */ }
module.exports = { id, id7: id === 'ID7', id8: id !== 'ID7' };
