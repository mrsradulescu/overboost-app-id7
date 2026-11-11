'use strict';
/**
 * drag.js - Drag Timer (idrive7-apps "Drag Timer": same RunTimer, speed from Vehicle2.statusCarSpeed2).
 * Stop -> READY, launch -> the clock runs, splits are interpolated, bests are kept in data/.
 */
const fs = require('fs');
const path = require('path');
const { RunTimer } = require('./timer');

const SPLITS = [
    { key: '0-100', label: '0-100 km/h', from: 0, to: 100 },
    { key: '100-200', label: '100-200 km/h', from: 100, to: 200 },
    { key: '0-200', label: '0-200 km/h', from: 0, to: 200 },
    { key: 'qm', label: '1/4 mile', dist: 402.336 },
];

function create(dataDir, log) {
    const file = path.join(dataDir, 'overboost-drag.json');
    let saved = { best: {}, last: null, runs: 0 };
    try { saved = Object.assign(saved, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* first start */ }
    const save = () => { try { fs.writeFileSync(file, JSON.stringify(saved)); } catch (e) { log.warn('drag save: ' + e); } };
    const timer = new RunTimer(SPLITS, {
        rollout: false,
        onDone: (run) => {
            saved.runs++;
            saved.last = { result: run.result, trap: run.trap, vmax: run.vmax, at: run.at };
            Object.keys(run.result).forEach((k) => { if (saved.best[k] === undefined || run.result[k] < saved.best[k]) saved.best[k] = run.result[k]; });
            save();
            log.info('drag run: ' + JSON.stringify(run.result) + ' vmax ' + Math.round(run.vmax));
        },
    });
    return {
        timer, saved, splits: SPLITS,
        feed: (t, kmh) => timer.feed(t, kmh),
        tick: () => timer.idle(Date.now()),
        reset: () => timer.reset(),
        clearBest: () => { saved.best = {}; saved.last = null; saved.runs = 0; save(); },
    };
}

module.exports = { create, SPLITS };
