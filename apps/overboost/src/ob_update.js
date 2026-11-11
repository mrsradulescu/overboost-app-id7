'use strict';
/* the iDrive 7 build has no updater: the car has no internet; updates are installed with mgu-deploy */
const VERSION = "1.7.2";
exports.create = () => ({
    base: { version: VERSION, base: 3 }, st: { found: null, msg: '', busy: false },
    cur: () => null, check: () => Promise.resolve(), install: () => Promise.resolve(), remove: () => {},
});
