'use strict';
/**
 * engine.js - Engine Config (ported from idrive7-apps "Engine Config", the parts that are consistent there).
 *
 *   Exhaust flap, factory DME (Bosch MG1, DID 0x60FD):   open  2F 60FD 03 03E8   close 2F 60FD 03 2328   OEM 2F 60FD 00
 *   Exhaust flap, MHD-flashed DME:                       2F 02 nn   (00 OEM, 01 open, 02 closed)
 *   Engine map 1-4 (MHD):                                2F 01 nn   (nn = map - 1)
 *   Max Cooling (MHD):                                   2F 03 nn   (00 off, 01 on)
 * The MHD DME takes a command by echoing 6F <fn> <nn>; that echo is the only confirmation there is (MHD offers no
 * read-back of the map). The factory flap is read back with 22 62FD / 22 64FD.
 *
 * SAFETY, as in the original: DISARMED by default - then the buttons only simulate and nothing is sent to the car.
 * Arming is a separate, confirmed button, and is forgotten at every start. OEM always hands control back.
 *
 * On top (apps/engine/auto.js): hold (Open / Close sent again every 15 s), the Close rpm guard, and Sport Modes - the flap
 * forced to a state per driving mode. 2WD (apps/engine/xdrive.js, experimental) uses the same link. Max Cooling On needs the
 * engine running (over 500 rpm). Flap jobs: apps/engine/flap.js.
 */
const { Diag, hex, NRC } = require('./diag');
const flap = require('./apps/engine/flap');
const { AutoFlap } = require('./apps/engine/auto');
const Car = require('./kit/car');

const DME = 0x12;
const MHD = { MAP: 0x01, FLAP: 0x02, COOLING: 0x03 };
const FLAP_DID = [0x60, 0xFD];
// Ethanol content (read only): UDS 23 (ReadMemoryByAddress) 14 B0 00 60 D2 01 -> 63 xx, xx = ethanol %.
// From the TurnKey E Blend project (verified there on an S58 / MHD flex-fuel DME): the address is calibration-specific,
// so a DME that does not know it answers with a refusal and the screen shows "--" instead of a guess.
const ETH_MEM = [0x14, 0xB0, 0x00, 0x60, 0xD2, 0x01];
const ETH_EVERY = 1000, ETH_FAIL_EVERY = 10000, ETH_MAX_AGE = 15000;
const tv = (pct) => { const r = Math.round(pct * 100) & 0xFFFF; return [(r >> 8) & 0xFF, r & 0xFF]; };

const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const RPM_STALE_MS = 5000, SPEED_STALE_MS = 10000, MIN_COOLING_RPM = 500;
const CONDITIONS = { PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
    PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12 };
const conditionOf = (x) => { const n = typeof x === 'number' ? x : CONDITIONS[x]; return n >= 1 && n <= 12 ? n : undefined; };
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };

/** opts.live = vitals.js's live values (rpm, speed and when they arrived) */
function create(signals, log, opts) {
    const live = (opts && opts.live) || { at: {} };
    const st = {
        diag: null, error: null, armed: false, platform: 'stock',      // 'stock' (BMW flap) | 'mhd'
        flap: 'OEM', flapOk: null, map: null, mapOk: null, cooling: null, coolingOk: null,
        kind: 'plain', mhdFlap: null,                                   // the BMW flap job this car has; false once MHD's flap control refused for good
        car: { stage: undefined, condition: undefined }, drive: null,   // selector, vehicle state, driving mode (raw)
        note: '', busy: false, probe: null,
        eth: null, ethAt: 0, ethStatus: 'Waiting for the first reading', ethBusy: false, ethNext: 0,
    };
    async function init(diag) {
        try { st.diag = diag || await new Diag(signals, log).init(); } catch (e) { st.error = String(e); }
        return st;
    }
    const link = () => !!(st.diag && st.diag.available);

    async function send(sid, data) {
        // only the reply to this very request: a positive one (sid + 0x40) or a refusal of the same service
        const mine = (u) => u[0] === sid + 0x40 || (u[0] === 0x7F && u[1] === sid);
        const r = await st.diag.physical(DME, sid, data, 4000, mine);
        if (!r || !r.length) return { ok: false, reason: 'no answer', raw: null };
        if (r[0] === 0x7F) return { ok: false, reason: NRC[r[2]] || ('NRC ' + hex(r[2])), raw: r };
        return { ok: true, sid: r[0], data: r.slice(1), raw: r };
    }
    async function mhd(fn, value) {
        const r = await send(0x2F, [fn, value]);
        const ok = !!r.ok && r.sid === 0x6F && r.data[0] === fn && r.data[1] === value;
        return { ok, detail: ok ? 'DME confirmed' : (r.reason || 'unexpected reply') };
    }
    async function guarded(label, fn) {
        if (st.busy) return;
        st.busy = true; st.note = 'Sending ' + label + '...';
        try { await fn(); } catch (e) { st.note = label + ': ' + String(e && e.message || e); log.warn(st.note); }
        st.busy = false;
    }

    /** read-only: which flap job does this DME have? (22 651E regulated, else 22 62FD / 22 64FD plain) */
    async function probe() {
        if (!link()) { st.note = 'Diagnostic link not ready (ignition on?)'; return; }
        await guarded('probe', async () => {
            const a = await send(0x22, [0x65, 0x1E]);
            const ar = flap.onRead('regulated', a.raw);
            if (ar.pct !== undefined) {
                st.kind = 'regulated';
                st.probe = { supported: true, kind: 'regulated', pct: ar.pct };
                st.note = 'Factory flap found (regulated, ' + flap.state(ar.pct) + ')';
                return;
            }
            const c = await send(0x22, [0x62, 0xFD]), b = await send(0x22, [0x64, 0xFD]);
            const br = flap.onRead('plain', b.raw);
            st.kind = 'plain';
            st.probe = { supported: !!(c.ok || b.ok), kind: 'plain', pct: c.ok && c.data.length >= 4 ? ((c.data[2] << 8) | c.data[3]) / 100 : null };
            st.note = st.probe.supported ? 'Factory flap found' + (st.probe.pct !== null ? ' (commanded ' + st.probe.pct + ' %)' : br.pct !== undefined ? ' (' + flap.state(br.pct) + ')' : '') : 'No factory flap answer';
        });
    }

    /** MHD holds its flap itself (2F 02 nn); BMW's job is a diagnostic override the DME lets go after ~20 s */
    const holdsItself = () => st.platform === 'mhd' && st.mhdFlap !== false;

    async function setFlap(mode) {          // OEM | OPEN | CLOSED
        st.flap = mode; st.flapOk = null;
        if (!st.armed) { st.flapOk = 'sim'; st.note = 'Test mode: nothing sent to the car'; return; }
        if (!link()) { st.flapOk = false; st.note = 'Diagnostic link not ready'; return; }
        await guarded('flap ' + mode, async () => {
            let ok = false, detail = '', done = false;
            if (st.platform === 'mhd' && st.mhdFlap !== false) {
                const r = await send(0x2F, flap.mhdCommand(mode));
                const v = flap.onMhd(mode, r.raw);
                if (v === 'held') { ok = true; detail = 'DME confirmed (MHD holds it)'; done = true; }
                else if (v === 'busy') { detail = r.raw ? 'DME busy: ' + r.reason : 'no answer'; done = true; }
                else { st.mhdFlap = false; log.info('MHD flap control refused for good: BMW job'); }
            }
            if (!done) {
                const r = await send(0x2F, flap.command(st.kind, mode));
                ok = !!r.ok && r.sid === 0x6F; detail = ok ? 'DME confirmed' : (r.reason || 'rejected');
            }
            st.flapOk = ok; st.note = 'Flap ' + mode + ': ' + detail;
            log.info(st.note);
        });
    }
    /** the auto module's way in: a press or a hold waits for a command in flight instead of being dropped */
    async function setMode(mode) {
        const t0 = Date.now();
        while (st.busy && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 50));
        return setFlap(mode);
    }
    async function setMap(n) {
        st.map = n; st.mapOk = null;
        if (!st.armed) { st.mapOk = 'sim'; st.note = 'Test mode: nothing sent to the car'; return; }
        if (st.platform !== 'mhd') { st.mapOk = false; st.note = 'Engine map needs the MHD platform'; return; }
        if (!link()) { st.mapOk = false; st.note = 'Diagnostic link not ready'; return; }
        await guarded('map ' + n, async () => { const r = await mhd(MHD.MAP, n - 1); st.mapOk = r.ok; st.note = 'Map ' + n + ': ' + r.detail; log.info(st.note); });
    }
    async function setCooling(on) {
        st.cooling = on; st.coolingOk = null;
        if (!st.armed) { st.coolingOk = 'sim'; st.note = 'Test mode: nothing sent to the car'; return; }
        if (st.platform !== 'mhd') { st.coolingOk = false; st.note = 'Max Cooling needs the MHD platform'; return; }
        if (!link()) { st.coolingOk = false; st.note = 'Diagnostic link not ready'; return; }
        if (on) {       // Max Cooling On needs the engine running: a live engine speed over 500 rpm, never the demo drive
            const r = rpm();
            if (r === null) { st.coolingOk = false; st.note = 'Engine speed unknown · nothing sent'; return; }
            if (r <= MIN_COOLING_RPM) { st.coolingOk = false; st.note = 'Engine off · Max Cooling On needs over ' + MIN_COOLING_RPM + ' rpm'; return; }
        }
        await guarded('cooling', async () => { const r = await mhd(MHD.COOLING, on ? 1 : 0); st.coolingOk = r.ok; st.note = 'Max Cooling ' + (on ? 'on' : 'off') + ': ' + r.detail; log.info(st.note); });
    }
    /** read-only ethanol % of the fuel (see ETH_MEM); at most one request in flight, one per second, slower after a failure */
    async function readEthanol() {
        const now = Date.now();
        if (st.ethBusy || now < st.ethNext) return;
        if (!link()) { st.ethStatus = 'Diagnostic link not ready (ignition on?)'; st.ethNext = now + 2000; return; }
        st.ethBusy = true;
        let bad = false;
        try {
            const mine = (u) => u[0] === 0x63 || (u[0] === 0x7F && u[1] === 0x23);
            const r = await st.diag.physical(DME, 0x23, ETH_MEM, 6000, mine);
            if (!r || !r.length) throw new Error('no answer from the DME');
            if (r[0] === 0x7F) throw new Error(NRC[r[2]] || ('NRC ' + hex(r[2])));
            if (r.length !== 2 || r[0] !== 0x63 || r[1] > 100) throw new Error('unexpected answer');
            st.eth = r[1]; st.ethAt = Date.now(); st.ethStatus = 'E' + r[1];
        } catch (e) {
            bad = true; st.ethStatus = String(e && e.message || e).slice(0, 70);
            log.warn('ethanol read: ' + st.ethStatus);
        }
        st.ethNext = Date.now() + (bad ? ETH_FAIL_EVERY : ETH_EVERY);
        st.ethBusy = false;
    }
    /** the percentage if it is fresh, else null */
    const ethanol = () => (st.eth !== null && Date.now() - st.ethAt < ETH_MAX_AGE ? st.eth : null);

    /* ---------------- live values the flap logic and 2WD look at ---------------- */
    const fresh = (k, ms) => (typeof live[k] === 'number' && isFinite(live[k]) && live.at && Date.now() - (live.at[k] || 0) <= ms ? live[k] : null);
    /** the engine speed: live and fresh only */
    const rpm = () => fresh('rpm', RPM_STALE_MS);
    /** what 2WD (xdrive.js) reads as the car's data: live only, never the demo drive */
    /** the speed for 2WD's "Stationary": a parked car sends no speed signal (the value is read once and does not change), so after
     *  SPEED_STALE_MS "fresh" would call a standing car "no speed" and refuse. An old value still counts when it was standing
     *  (< 0.5 km/h): a car that had been moving sends the changed value as it slows. An old moving value never counts. */
    const speedNow = () => {
        const f = fresh('speed', SPEED_STALE_MS);
        if (f !== null) return f;
        return typeof live.speed === 'number' && isFinite(live.speed) && live.speed < 0.5 && live.at && live.at.speed ? live.speed : null;
    };
    const carData = () => ({ demo: false, rpm: rpm(), speed: speedNow(), stage: st.car.stage, condition: st.car.condition });

    let auto = null;
    const watched = [];
    function watchSignals() {
        if (!signals || !signals.watch) return;
        const w = (iface, handlers) => { try { watched.push(signals.watch(iface, '1', handlers, log).catch((e) => log.warn('signals ' + iface + ': ' + e))); } catch (e) { log.warn('signals ' + iface + ': ' + e); } };
        w(FES, { statusFESVehicleDynamicSwitchHMI: (v) => {
            const raw = v && v.actualValueModeDrivingExperience;
            st.drive = raw === undefined ? null : raw;
            if (auto) { const p = auto.driveMode(raw); if (p) p.catch(() => {}); }
        } });
        w('de.bmw.infrastructure.VehicleCondition', { VehicleCondition: (v) => { const c = conditionOf(v && v.statusConditionVehicle); if (c !== undefined) st.car.condition = c; } });
        w('de.bmw.infrastructure.VehicleInformation', {
            statusGearboxDrive: (v) => { const s = STAGES[v && v.statusActualStageDrive]; if (s !== undefined) st.car.stage = s; },
            DataPowerTrain2: (v) => { const sel = Car.selectionOf(v && v.statusGearSelectionDrive); if (sel && sel.stage !== undefined) st.car.stage = sel.stage; },
        });
    }

    /** settings = the Engine Config app's settings (get / set / onChange): from here on the flap logic runs, also while the app is not on screen */
    function bind(settings) {
        if (auto) return auto;
        auto = new AutoFlap({ controller: { setMode, st, holdsItself }, get: (k) => settings.get(k), set: (k, v) => settings.set(k, v), rpm, log, onChange: () => {} });
        if (st.drive != null) auto.drive = st.drive;
        const t = setInterval(() => { auto.tick().catch((e) => log.error('rpm ' + e)); }, 250);
        if (t.unref) t.unref();
        engine.auto = auto;
        return auto;
    }
    /** the diagnostic link came up: what is wanted goes again */
    function onLink() { return auto ? auto.linkUp() : null; }
    watchSignals();

    const engine = { st, init, probe, setFlap, setMode, setMap, setCooling, readEthanol, ethanol, bind, onLink, holdsItself, rpm, carData, auto: null };
    return engine;
}

module.exports = { create };
