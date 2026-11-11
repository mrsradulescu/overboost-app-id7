'use strict';
/**
 * mgu.js (OVERBOOST) - stands in for the idrive7-apps kit's runtime for the apps run by host8.js.
 *
 * The apps (M Vitals, Drag Timer, Fault Scanner) are the original, unchanged idrive7-apps code and end with
 * `mgu.run({ async start(ctx) { ... } })`. Here run() only hands the app's start function to the host, which
 * builds ctx (host8.js) and calls it when the app is opened.
 */
let taken = null;
function run(impl) { taken = impl; return Promise.resolve(); }
function take() { const t = taken; taken = null; return t; }
module.exports = { run, take };
