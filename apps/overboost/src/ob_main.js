'use strict';
/**
 * OVERBOOST - one app for the MGU21 (iDrive 8) that holds M Vitals, Drag Timer, Fault Scanner and Engine Config.
 *
 *   splash (logo in the middle) -> main menu (logo + the four apps) -> each app's own pages / sub-menus.
 *
 * The apps' logic comes from the open-source idrive7-apps project (same signals, same UDS, same safety gates);
 * the screens are plain HMI rows (labels + buttons), the part that is proven on the iDrive 8 unit.
 */
const fs = require('fs');
const path = require('path');
const ROOT = process.env.OVERBOOST_ROOT || path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const LOG = path.join(DATA, 'bench.log');
try { fs.mkdirSync(DATA); } catch (e) { /* exists */ }
function log(message) {
    const line = new Date().toISOString() + ' ' + message;
    try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
    console.log(line);
}
process.on('uncaughtException', (e) => { log('FATAL ' + (e.stack || e)); process.exit(1); });
process.on('unhandledRejection', (e) => log('REJECTION ' + (e.stack || e)));
// Do not log argv: the launcher includes the vehicle's VIN there.
log('PROCESS_START uid=' + process.getuid());
const OnlineApp = (function (m) { return m.OnlineApp || m; })(require('oap-sdk/src/core/OnlineApp.js'));
const { Ui } = require('./ob_ui.js');
const ID7 = require('./kit_hmi.js').id7;
const app = new OnlineApp();
const description = JSON.parse(fs.readFileSync(path.join(ROOT, 'rhmiData', 'application.json')));
const entry = description.application.entryPoints[0].uuid;
let opening = null;
let openCount = 0;
const L = { info: (m) => log('INFO ' + m), warn: (m) => log('WARN ' + m), error: (m) => log('ERROR ' + m) };

async function showScreen(uuid, source) {
    if (opening) return opening;
    opening = (async () => {
        const state = app.rhmiApplication.getByName('MAIN');
        await app.rhmiApplication.mapEntryState(uuid, state);
        await Promise.resolve(state.updateResources()).catch(() => {});      // (a canvas screen may refuse it before its first image)
        await app.rhmiApplication.openEntryState(uuid);
        openCount++;
        log('OPEN_OK source=' + source + ' entry=' + uuid + ' count=' + openCount);
        return true;
    })().catch((e) => { log('OPEN_FAILED ' + (e.stack || e)); return false; }).then((ok) => { opening = null; return ok; });
    return opening;
}

/* ---------------- formatting ---------------- */
const num = (x) => typeof x === 'number' && isFinite(x);
const f = (v, d, unit) => (num(v) ? v.toFixed(d) + (unit ? ' ' + unit : '') : '-');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '~' : s);
const sec = (v) => (num(v) ? v.toFixed(2) + ' s' : '-');

/* ---------------- the app ---------------- */
// the renderer (GPU) connects only once the HMI's screen has been opened (or after 5 s): the first frames of the
// app block this process for about two seconds, and a screen opened after that is refused (INVALID_UUID)
let openGate = null;
const gate = new Promise((r) => { openGate = r; });
setTimeout(() => openGate(), 6000).unref();

async function startApp(rhmi) {
    const ui = new Ui(app, log, ROOT);
    let signals = null;
    try { signals = require('./ob_signals.js'); } catch (e) { log('WARN signals unavailable: ' + e); }
    const drag = require('./ob_drag.js').create(DATA, L);
    const live = signals ? require('./ob_vitals.js').start(signals, L, { onSpeed: (t, v) => drag.feed(t, v) }) : { at: {}, present: () => false };
    const faults = signals ? require('./ob_faults.js').create(signals, DATA, L) : null;
    const upd = require('./ob_update.js').create(L);
    const engine = signals ? require('./ob_engine.js').create(signals, L, { live }) : null;
    // ONE diagnostic link shared by Fault Scanner and Engine Config (a second proxy on the same transport is avoided)
    if (signals) {
        new (require('./kit_diag.js').Diag)(signals, L).init().then((d) => {
            d.quiet = false;
            if (faults) faults.init(d);
            if (engine) engine.init(d);
            d.on('available', () => { refresh(); if (engine) { const p = engine.onLink(); if (p) p.catch(() => {}); } });
            refresh();
        }).catch((e) => log('ERROR diag init ' + e));
    }

    let screen = 'SPLASH', vpage = 'engine', flash = null, clearArm = null, armTimer = null, hiddenAt = 0, first = true;
    // GPU screens (the idrive7-apps designs on mgu-render); without the renderer every screen is the plain rows below
    const APPS = { VITALS: 'car_vitals', DRAG: 'draggy', FAULTS: 'dtc_scanner', ENGINE: 'engine', FLAP: 'engine', MAP: 'engine' };
    let host = null, mode = 'text';
    try {
        host = require('./ob_host8.js').create({
            connectAfter: gate, log, dataDir: DATA, signals, version: upd.base.version, appId: 'overboost',
            go: (s) => go(s), onChange: () => refresh(),
            status: () => ({
                car: link(), carLive: live.present(), update: upd.st.found,
                diag: faults && faults.st.diag && faults.st.diag.available ? 'Diagnostics: ready' : 'Diagnostics: waiting',
                diagReady: !!(faults && faults.st.diag && faults.st.diag.available),
            }),
        });
        host.svc = { engine, upd, restart: () => { log('INFO restart requested'); setTimeout(() => process.exit(0), 800); } };
    } catch (e) { log('WARN GPU screens unavailable: ' + (e.stack || e)); host = null; }
    const say = (t) => { flash = { t, until: Date.now() + 5000 }; refresh(); };
    const go = (s) => {
        if (s === 'MENU') s = 'VITALS';      // no menu page: the apps' header switches between them
        screen = s; refresh();
    };
    const back = (to) => ({ t: '<  Back', f: () => go(to || 'MENU') });
    const link = () => (live.present() ? 'Car data: live' : 'Car data: waiting for the car');

    /* ---- screens ---- */
    const S = {
        SPLASH: () => ({ title: 'OVERBOOST', logo: true, lines: [], buttons: [] }),
        MENU: () => ({
            title: 'OVERBOOST', logo: true,
            lines: ['Choose an app', link() + (faults && faults.st.diag && faults.st.diag.available ? '   |   Diagnostics: ready' : '   |   Diagnostics: waiting')],
            buttons: [
                { t: 'M Vitals', f: () => go('VITALS') },
                { t: 'Drag Timer', f: () => go('DRAG') },
                { t: 'Fault Scanner', f: () => go('FAULTS') },
                { t: 'Engine Config', f: () => go('ENGINE') },
                { t: upd.st.found && upd.st.found.newer ? 'Update   (new version ' + upd.st.found.tag + ')' : 'Update', f: () => go('UPDATE') },
            ],
        }),
        UPDATE: () => {
            const st = upd.st, cur = upd.cur();
            return { title: 'Update', lines: ['Installed: OVERBOOST ' + upd.base.version + (cur ? '   |   downloaded: ' + cur.version : ''),
                st.msg || 'Press "Check for updates". The car needs an internet connection.',
                st.pending ? 'Restart OVERBOOST to use ' + st.pending + ' (button below).' : ''],
                buttons: [back(), { t: st.busy ? 'Working...' : 'Check for updates', f: () => { upd.check().then(refresh); refresh(); } },
                    { t: st.found && st.found.newer ? 'Update now  (' + st.found.tag + ')' : 'Update now', f: () => { upd.install().then(refresh); refresh(); } },
                    { t: 'Restart OVERBOOST', f: () => { log('INFO restart requested'); say('Restarting... open OVERBOOST again from the menu'); setTimeout(() => process.exit(0), 800); } },
                    { t: 'Go back to the installed version', f: () => { upd.remove(); refresh(); } }] };
        },
        VITALS: () => {
            const mk = (id, t) => ({ t: (vpage === id ? '>  ' : '') + t, f: () => { vpage = id; refresh(); } });
            let lines;
            if (vpage === 'engine') {
                const kw = num(live.torque) && num(live.rpm) ? Math.max(0, live.torque * live.rpm / 9549) : null;
                lines = ['Engine speed   ' + f(live.rpm, 0, 'rpm') + '      Speed   ' + f(live.speed, 0, 'km/h'),
                    'Boost (sport display)   ' + f(live.boost, 2, 'bar'),
                    'Torque   ' + f(live.torque, 0, 'Nm') + '      Power (calc.)   ' + f(kw, 0, 'kW') + (num(kw) ? '  /  ' + (kw * 1.341).toFixed(0) + ' hp' : ''),
                    'Coolant   ' + f(live.coolant, 0, '°C') + '      Oil   ' + f(live.oil, 0, '°C'),
                    'Gearbox oil   ' + f(live.gearbox, 0, '°C') + '      Outside   ' + f(live.ambient, 1, '°C')];
            } else if (vpage === 'chassis') {
                lines = ['Speed   ' + f(live.speed, 0, 'km/h'),
                    'Longitudinal   ' + f(live.gLong, 2, 'g') + '      Lateral   ' + f(live.gLat, 2, 'g'),
                    'Torque to the rear axle   ' + f(live.splitRear, 0, '%')];
            } else {
                lines = ['Front   left ' + f(live.pFL, 1, 'bar') + ' ' + f(live.tFL, 0, '°C') + '      right ' + f(live.pFR, 1, 'bar') + ' ' + f(live.tFR, 0, '°C'),
                    'Rear    left ' + f(live.pRL, 1, 'bar') + ' ' + f(live.tRL, 0, '°C') + '      right ' + f(live.pRR, 1, 'bar') + ' ' + f(live.tRR, 0, '°C'),
                    'Tyre values arrive from the car every few seconds'];
            }
            if (!live.present()) lines.push('No data from the car yet (ignition on?)');
            return { title: 'M Vitals', lines, buttons: [back(), mk('engine', 'Engine'), mk('chassis', 'Chassis and g-force'), mk('tyres', 'Tyres')] };
        },
        DRAG: () => {
            const T = drag.timer, now = Date.now(), best = drag.saved.best, res = T.result;
            const stateTxt = T.state === 'run' ? 'RUNNING' : T.state === 'ready' ? 'READY - launch when you like' : 'Stop the car to arm the timer';
            const lines = [stateTxt + '      Speed   ' + f(live.speed, 0, 'km/h'),
                'Time   ' + sec(T.elapsed(now)) + (num(T.vmax) && T.vmax > 0 ? '      Top speed   ' + T.vmax.toFixed(0) + ' km/h' : '')];
            drag.splits.forEach((s) => {
                const extra = s.dist && T.trapSpeed[s.key] ? '  @ ' + T.trapSpeed[s.key].toFixed(0) + ' km/h' : '';
                lines.push(s.label + '    this run ' + sec(res[s.key]) + extra + '    best ' + sec(best[s.key]));
            });
            lines.push('Runs saved: ' + drag.saved.runs);
            return { title: 'Drag Timer', lines, buttons: [back(), { t: 'Reset run', f: () => { drag.reset(); refresh(); } },
                { t: 'Clear best times', f: () => { drag.clearBest(); say('Best times cleared'); } }] };
        },
        FAULTS: () => {
            if (!faults) return { title: 'Fault Scanner', lines: ['Diagnostics unavailable (no SOME/IP module)'], buttons: [back()] };
            const st = faults.st, units = faults.withFaults();
            if (faults.q.unit >= units.length) faults.q.unit = 0;
            const lines = [];
            if (st.busy) lines.push((st.phase === 'scanning' ? 'Scanning... ' + st.replies + ' units answered' : st.msg || 'Working...') + '  (do not switch the ignition off)');
            else if (!st.scan) lines.push('Press "Scan all units". Reading changes nothing in the car.');
            else {
                const n = st.scan.ecus.reduce((s, e) => s + e.dtcs.length, 0);
                lines.push(st.scan.ecus.length + ' units answered, ' + n + ' fault' + (n === 1 ? '' : 's') + ' in ' + units.length + ' unit' + (units.length === 1 ? '' : 's'));
            }
            if (st.msg && !st.busy) lines.push(st.msg);
            if (!st.busy && st.scan && units.length) {
                const e = units[faults.q.unit], per = 5, pages = Math.max(1, Math.ceil(e.dtcs.length / per));
                if (faults.q.codes >= pages) faults.q.codes = 0;
                lines.push('Unit ' + (faults.q.unit + 1) + '/' + units.length + ':  ' + faults.ecuName(e.addr) + '  (' + e.dtcs.length + ')' + (pages > 1 ? '   codes page ' + (faults.q.codes + 1) + '/' + pages : ''));
                e.dtcs.slice(faults.q.codes * per, faults.q.codes * per + per).forEach((d) => {
                    const t = faults.describe(e.addr, d.code);
                    lines.push(clip(d.code + '  ' + faults.statusLabel(d.status) + (t ? '  ' + t : ''), 110));
                });
            } else if (!st.busy && st.scan) lines.push('No faults stored. ');
            const btn = [back(),
                { t: st.busy ? 'Working...' : (st.scan ? 'Scan again' : 'Scan all units'), f: () => { if (!st.busy) { faults.scan().then(refresh); refresh(); } } },
                { t: 'Previous unit', f: () => { faults.q.unit = (faults.q.unit - 1 + Math.max(1, units.length)) % Math.max(1, units.length); faults.q.codes = 0; refresh(); } },
                { t: 'Next unit', f: () => { faults.q.unit = (faults.q.unit + 1) % Math.max(1, units.length); faults.q.codes = 0; refresh(); } },
                { t: 'More codes of this unit', f: () => { faults.q.codes = (faults.q.codes || 0) + 1; refresh(); } },
                { t: clearArm ? 'YES - clear all fault memories now' : 'Clear all fault memories', f: () => {
                    if (st.busy) return;
                    if (!clearArm) { clearArm = setTimeout(() => { clearArm = null; refresh(); }, 6000); say('Press again within 6 s to clear every unit'); return; }
                    clearTimeout(clearArm); clearArm = null;
                    faults.clearAll().then(refresh); refresh();
                } }];
            return { title: 'Fault Scanner', lines, buttons: btn };
        },
        ENGINE: () => {
            if (!engine) return { title: 'Engine Config', lines: ['Diagnostics unavailable (no SOME/IP module)'], buttons: [back()] };
            const st = engine.st;
            const lines = ['Control: ' + (st.armed ? 'ARMED - buttons act on the real car' : 'DISARMED - simulated, nothing is sent'),
                'Platform: ' + (st.platform === 'mhd' ? 'MHD-flashed DME' : 'Factory DME (BMW flap)') + '      Link: ' + (engine.st.diag && engine.st.diag.available ? 'ready' : 'waiting'),
                'Flap ' + st.flap + '   |   Map ' + (st.map || '-') + '   |   Max Cooling ' + (st.cooling === null ? '-' : st.cooling ? 'on' : 'off'),
                flash && Date.now() < flash.until ? flash.t : (st.note || 'Arm only with the car parked. OEM hands the flap back to the engine control.')];
            return { title: 'Engine Config', lines, buttons: [
                back(),
                { t: st.armed ? 'Disarm (simulate only)' : (armTimer ? 'PRESS AGAIN to ARM - commands will go to the car' : 'Arm control (send to the car)'), f: () => {
                    if (st.armed) { st.armed = false; refresh(); return; }
                    if (!armTimer) { armTimer = setTimeout(() => { armTimer = null; refresh(); }, 6000); say('Press again within 6 s to arm. Parked car, ignition on.'); return; }
                    clearTimeout(armTimer); armTimer = null; st.armed = true; log('INFO Engine Config ARMED'); say('Armed'); } },
                { t: 'Platform: ' + (st.platform === 'mhd' ? 'MHD' : 'Factory') + '  (press to change)', f: () => { st.platform = st.platform === 'mhd' ? 'stock' : 'mhd'; refresh(); } },
                { t: 'Exhaust flap  >', f: () => go('FLAP') },
                { t: 'Engine map and Max Cooling  >', f: () => go('MAP') },
                { t: 'Detect the factory flap (read only)', f: () => { engine.probe().then(refresh); refresh(); } },
            ] };
        },
        FLAP: () => {
            const st = engine.st, mk = (m, t) => ({ t: (st.flap === m ? '>  ' : '') + t, f: () => { engine.setFlap(m).then(refresh); refresh(); } });
            const ok = st.flapOk === true ? 'confirmed by the DME' : st.flapOk === 'sim' ? 'simulated' : st.flapOk === false ? 'NOT accepted' : '';
            return { title: 'Exhaust flap', lines: ['Control: ' + (st.armed ? 'ARMED' : 'DISARMED (simulated)') + '      Platform: ' + (st.platform === 'mhd' ? 'MHD' : 'Factory'),
                'Requested: ' + st.flap + (ok ? '   (' + ok + ')' : ''), st.note || ''],
                buttons: [back('ENGINE'), mk('OEM', 'OEM - hand back to the engine control'), mk('OPEN', 'Open'), mk('CLOSED', 'Closed')] };
        },
        MAP: () => {
            const st = engine.st, mk = (n) => ({ t: (st.map === n ? '>  ' : '') + 'Engine map ' + n, f: () => { engine.setMap(n).then(refresh); refresh(); } });
            const ok = (v) => (v === true ? 'confirmed (DME echo)' : v === 'sim' ? 'simulated' : v === false ? 'NOT accepted' : '');
            return { title: 'Engine map / Max Cooling', lines: ['Control: ' + (st.armed ? 'ARMED' : 'DISARMED (simulated)') + '      Platform: ' + (st.platform === 'mhd' ? 'MHD' : 'Factory') + (st.platform === 'mhd' ? '' : '   - the map needs MHD'),
                'Map: ' + (st.map || '-') + (st.map ? '  ' + ok(st.mapOk) : '') + '      Max Cooling: ' + (st.cooling === null ? '-' : st.cooling ? 'on' : 'off') + (st.cooling !== null ? '  ' + ok(st.coolingOk) : ''),
                st.note || 'MHD answers by echoing the command; there is no read-back of the active map.'],
                buttons: [back('ENGINE'), mk(1), mk(2), mk(3), mk(4),
                    { t: 'Max Cooling on', f: () => { engine.setCooling(true).then(refresh); refresh(); } },
                    { t: 'Max Cooling off', f: () => { engine.setCooling(false).then(refresh); refresh(); } }] };
        },
    };

    let rendering = false, again = false;
    async function refresh() {
        if (!ui.visible) return;
        if (rendering) { again = true; return; }
        rendering = true;
        try {
            let gpu = false;
            if (host && host.wanted()) {
                const app = APPS[screen];
                if (screen === 'SPLASH') gpu = await host.show('menu', { splash: true });
                else if (app) gpu = await host.show(app);
            }
            if (gpu) {
                // the HMI's own rows stay empty while the GPU draws
                if (mode !== 'gpu') { mode = 'gpu'; log('INFO screen: GPU (' + screen + ')'); await ui.render({ title: 'OVERBOOST', logo: false, lines: [], buttons: [] }); }
            } else {
                if (host) host.hide();
                // graphics only: until the renderer shows the app, the HMI keeps just the title
                if (mode !== 'text') { mode = 'text'; ui.reset(); }
                await ui.render({ title: 'OVERBOOST', logo: false, lines: [], buttons: [] });
            }
        } catch (e) { log('RENDER_FAILED ' + (e.stack || e)); }
        rendering = false;
        if (again) { again = false; refresh(); }
    }
    setInterval(() => { drag.tick(); if (ui.visible && mode !== 'gpu') refresh(); }, 500);
    ui.bind();
    // look for an update once, a little after the start (silently: only the Update button changes)
    if (!ID7) setTimeout(() => upd.check().then(refresh), 25000);

    // the screen is open (or was closed): the splash first time and after a pause, else where the user was
    ui.onVisible = (on) => {
        ui.visible = on;
        if (!on) { hiddenAt = Date.now(); if (host) host.hide(); mode = 'text'; return; }
        ui.reset();
        if (first || Date.now() - hiddenAt > 60000) {
            first = false; screen = 'SPLASH'; refresh();
            setTimeout(() => { if (screen === 'SPLASH') go('VITALS'); }, 3000);
        } else refresh();
    };
    return { refresh, ui };
}

async function main() {
    app.on('appStatusProxyReady', () => app.registerActive().then(() => log('ACTIVE')).catch((e) => log('ACTIVE_FAILED ' + e)));
    app.on('shutdown', () => { log('SHUTDOWN'); setTimeout(() => process.exit(0), 100); });
    app.on('entryPointExecute', (uuid, reason, name) => {
        log('ENTRY_EXECUTE uuid=' + uuid + ' reason=' + reason + ' name=' + name);
        if (app.rhmiApplication) showScreen(uuid, 'event');
    });
    await app.start();
    log('SDK_STARTED reason=' + app.startReason);
    const rhmi = app.rhmiApplication || await app.getRhmiApplication();
    if (!rhmi) throw Error('SDK returned without RHMI application');
    const state = rhmi.getByName('MAIN');
    await rhmi.mapEntryState(entry, state);
    log('MAP_OK entry=' + entry + ' state=' + state.getId());
    // like the Store: take the tile the manager handed over, init it, map it and enable it before the first open
    async function registerEntry() {
        if (ID7) return true;          // the iDrive 7 platform shows the tile from the app's own rhmiData: nothing to register
        try {
            const raw = (app.getEntryPoints && await app.getEntryPoints()) || [];     // (a promise on this SDK)
            if (!registerEntry.logged) { registerEntry.logged = true; log('ENTRY_POINTS type=' + Object.prototype.toString.call(raw) + ' keys=' + Object.keys(raw).slice(0, 6).join(',')); }
            // an array, a Map / Set, or an object keyed by uuid, whichever the SDK hands over
            const eps = Array.isArray(raw) ? raw : typeof raw.values === 'function' && raw.values !== Object.prototype.values ? Array.from(raw.values()) : Object.keys(raw).map((k) => raw[k]);
            const ours = eps.find((ep) => ep && ep.getDescription && ep.getDescription().uuid === entry);
            if (!ours) { log('ENTRY_MISSING (' + eps.length + ' handed over)'); return false; }
            await ours.init();
            await rhmi.mapEntryState(entry, state);
            await ours.setAvailability('ENABLED');
            log('ENTRY_ENABLED ' + entry);
            return true;
        } catch (e) { log('ENTRY_REGISTER_FAILED ' + e); return false; }
    }
    const ctlPromise = startApp(rhmi);
    state.on('visible', (event) => log('STATE_VISIBLE ' + JSON.stringify(event)));
    rhmi.on('applicationStackChanged', (stack) => {
        const shown = stack && Object.keys(stack).length > 0 && ('ROOT_APP' in stack);
        // iDrive 7: our screen counts as visible while its state is on the HMI's stack
        const open = [].concat.apply([], Object.keys(stack || {}).map((k) => stack[k] || []));
        const visible = ID7 ? !!(shown && open.indexOf(state.getId()) >= 0) : shown;
        log('STACK ' + JSON.stringify(stack));
        ctlPromise.then((c) => { if (c.ui.visible !== visible) c.ui.onVisible(visible); });
        const p = shown ? app.registerHmiVisible() : app.unregisterHmiVisible();
        Promise.resolve(p).catch((e) => log('VISIBILITY_FAILED ' + e));
    });
    await registerEntry();
    await app.registerActive();
    await app.initialized();
    log('INITIALIZED');
    try { if (process.env.OVERBOOST_TRIES) fs.unlinkSync(process.env.OVERBOOST_TRIES); } catch (e) { /* none */ }
    // (open the screen first: the app's own start-up goes on beside it)
    const initial = app.getLastExecutedEntryPointUuid();
    if (initial && ['ENTRY_POINT', 'BOOKMARK', 'LUM'].indexOf(String(app.startReason)) >= 0) {
        // the HMI may not know this app's screen yet (INVALID_UUID right after an install or a restart): keep trying, for about 40 s
        // as the Store before it opens its screen: this app is the active one and the HMI shows it
        try { await app.registerActive(); await app.registerHmiVisible(); } catch (e) { log('VISIBILITY_FAILED ' + e); }
        for (let i = 0; i < 27; i++) {
            if (await showScreen(initial, 'cold-start')) break;
            await registerEntry();
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    openGate();
    await ctlPromise;
}
main().catch((e) => { log('START_FAILED ' + (e.stack || e)); process.exit(1); });
