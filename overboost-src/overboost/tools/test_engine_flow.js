'use strict';
/* test_engine_flow.js - Engine Config's logic against a simulated car: no head unit, nothing is sent anywhere.
 *   node tools/test_engine_flow.js
 * Covers: the flap jobs (plain 60FD, regulated 611E, MHD 2F 02), Max Cooling's engine-running gate, Sport Modes (per-group
 * mapping), hold, the Close rpm guard and its no-rpm fail-safe, and 2WD (test-mode gate, double press, the one write). */
const assert = require('assert');
const path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const { create } = require(path.join(SRC, 'engine.js'));
const { XDriveControl } = require(path.join(SRC, 'apps/engine/xdrive.js'));

const log = { info() {}, warn() {}, error(m) { console.log('LOG ERROR', m); } };
const hexs = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(' ');
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** a scripted diagnostic link: answers(ecu, sid, data) -> reply bytes | null */
function fakeDiag(answers) {
    const d = { available: true, sent: [], physical: async (ecu, sid, data) => { d.sent.push({ ecu, sid, data: Array.from(data) }); return answers(ecu, sid, Array.from(data)); } };
    return d;
}
const positive = (sid, data) => [sid + 0x40].concat(data);
const refuse = (sid, nrc) => [0x7F, sid, nrc];
function settingsOf(init) {
    const v = Object.assign({ driveLink: 'off', hold: 'on', closeLimit: '4000', modeSport: 'open', modeComfort: 'oem', modeEco: 'close', modeAdaptive: 'oem', xdrive: 'off' }, init);
    const ls = [];
    return { get: (k) => v[k], set: (k, x) => { v[k] = x; ls.forEach((f) => f(k, x)); }, onChange: (f) => ls.push(f), v };
}
function newEngine(opts) {
    opts = opts || {};
    const handlers = {};
    const signals = { watch: async (iface, inst, h) => { handlers[iface] = h; return { available: true }; } };
    const live = { at: {}, rpm: opts.rpm === undefined ? 3000 : opts.rpm, speed: 0 };
    live.at.rpm = Date.now(); live.at.speed = Date.now();
    const e = create(signals, log, { live });
    e.st.diag = fakeDiag(opts.answers || ((ecu, sid, data) => (sid === 0x2F ? positive(0x2F, data) : null)));
    e.st.armed = opts.armed !== false;
    e.st.platform = opts.platform || 'stock';
    return { e, live, handlers };
}

(async () => {
    // ---------------------------------------------------------------- the flap jobs
    {
        const { e } = newEngine();
        await e.setFlap('OPEN'); await e.setFlap('CLOSED'); await e.setFlap('OEM');
        eq(e.st.diag.sent.map((s) => hexs([s.sid].concat(s.data))), ['2f 60 fd 03 03 e8', '2f 60 fd 03 23 28', '2f 60 fd 00'], 'plain flap bytes');
    }
    {
        // a G80-style DME: 22 651E answers, so the regulated job is used
        const { e } = newEngine({ answers: (ecu, sid, d) => (sid === 0x22 && d[0] === 0x65 ? positive(0x22, [0x65, 0x1E, 0x1C, 0xCD, 0x1C, 0xCD]) : sid === 0x2F ? positive(0x2F, d) : null) });
        await e.probe();
        eq(e.st.kind, 'regulated', 'regulated detected'); ok(/regulated, CLOSED/.test(e.st.note), e.st.note);
        e.st.diag.sent.length = 0;
        await e.setFlap('OPEN'); await e.setFlap('CLOSED'); await e.setFlap('OEM');
        eq(e.st.diag.sent.map((s) => hexs([s.sid].concat(s.data))), ['2f 61 1e 03 03 33', '2f 61 1e 03 1c cd', '2f 61 1e 00'], 'regulated flap bytes');
    }
    {
        // 651E refused for good -> plain
        const { e } = newEngine({ answers: (ecu, sid, d) => (sid === 0x22 && d[0] === 0x65 ? refuse(0x22, 0x31) : sid === 0x22 && d[0] === 0x64 ? positive(0x22, [0x64, 0xFD, 0x03, 0xE8, 0x03, 0xE8]) : null) });
        await e.probe();
        eq(e.st.kind, 'plain', 'plain kept'); ok(e.st.probe.supported, 'found');
    }
    {
        // MHD: 2F 02 nn, echoed; held by MHD itself (no resend)
        const { e } = newEngine({ platform: 'mhd', answers: (ecu, sid, d) => (sid === 0x2F ? positive(0x2F, d) : null) });
        await e.setFlap('OPEN'); await e.setFlap('CLOSED'); await e.setFlap('OEM');
        eq(e.st.diag.sent.map((s) => hexs([s.sid].concat(s.data))), ['2f 02 01', '2f 02 02', '2f 02 00'], 'MHD flap bytes');
        ok(e.holdsItself(), 'MHD holds itself'); ok(e.st.flapOk === true, 'echo confirms');
        eq([(await (async () => { await e.setMap(3); return e.st.mapOk; })())], [true], 'map 3 accepted');
        ok(hexs([e.st.diag.sent.pop().data[0], e.st.diag.sent.length ? 0 : 0]).length > 0, 'ran');
    }
    {
        // MHD asked, the DME refuses the short request: BMW's job from then on
        const { e } = newEngine({ platform: 'mhd', answers: (ecu, sid, d) => (sid === 0x2F && d.length === 2 ? refuse(0x2F, 0x13) : sid === 0x2F ? positive(0x2F, d) : null) });
        await e.setFlap('OPEN');
        eq(e.st.diag.sent.map((s) => hexs([s.sid].concat(s.data))), ['2f 02 01', '2f 60 fd 03 03 e8'], 'MHD refused: BMW job');
        ok(e.st.mhdFlap === false && !e.holdsItself(), 'MHD flap dropped');
    }
    {
        // test mode: nothing is sent
        const { e } = newEngine({ armed: false });
        await e.setFlap('OPEN'); await e.setMap(2); await e.setCooling(true);
        eq(e.st.diag.sent.length, 0, 'test mode sends nothing');
    }

    // ---------------------------------------------------------------- Max Cooling needs the engine running
    {
        const a = newEngine({ platform: 'mhd', rpm: 0 });
        await a.e.setCooling(true);
        eq(a.e.st.diag.sent.length, 0, 'engine off: nothing sent'); ok(/Engine off/.test(a.e.st.note), a.e.st.note);
        const b = newEngine({ platform: 'mhd', rpm: null });
        b.live.rpm = undefined; await b.e.setCooling(true);
        eq(b.e.st.diag.sent.length, 0, 'unknown rpm: nothing sent'); ok(/unknown/.test(b.e.st.note), b.e.st.note);
        const c = newEngine({ platform: 'mhd', rpm: 2000 });
        await c.e.setCooling(true); await c.e.setCooling(false);
        eq(c.e.st.diag.sent.map((s) => hexs([s.sid].concat(s.data))), ['2f 03 01', '2f 03 00'], 'running: on and off sent');
        a.e.st.cooling = null; await a.e.setCooling(false);
        eq(a.e.st.diag.sent.map((s) => hexs([s.sid].concat(s.data))), ['2f 03 00'], 'off always goes');
    }

    // ---------------------------------------------------------------- Sport Modes
    {
        const { e, handlers } = newEngine();
        const set = settingsOf({ driveLink: 'on' });
        const auto = e.bind(set);
        const sent = () => e.st.diag.sent.map((s) => hexs([s.sid].concat(s.data)));
        const FESh = handlers['de.bmw.infotainment.drivingexcitement.FES'].statusFESVehicleDynamicSwitchHMI;
        FESh({ actualValueModeDrivingExperience: 1 }); await auto._q;            // Sport -> Open
        FESh({ actualValueModeDrivingExperience: 4 }); await auto._q;            // Comfort -> OEM
        FESh({ actualValueModeDrivingExperience: 7 }); await auto._q;            // Eco Pro -> Close
        FESh({ actualValueModeDrivingExperience: 10 }); await auto._q;           // Adaptive -> OEM
        eq(sent(), ['2f 60 fd 03 03 e8', '2f 60 fd 00', '2f 60 fd 03 23 28', '2f 60 fd 00'], 'default mapping per driving mode');
        // the mapping is the owner's: Comfort forced Closed, Eco Pro handed to the car
        e.st.diag.sent.length = 0;
        FESh({ actualValueModeDrivingExperience: 5 }); await auto._q;            // Comfort+ (OEM)
        set.set('modeComfort', 'close'); await auto.settingsChanged('modeComfort'); await auto._q;                          // the current mode takes the new mapping at once
        set.set('modeEco', 'oem'); await auto.settingsChanged('modeEco');
        eq(sent(), ['2f 60 fd 03 23 28'], 'changing the mapping of the mode in use is applied; others wait');
        e.st.diag.sent.length = 0;
        FESh({ actualValueModeDrivingExperience: 8 }); await auto._q;            // Eco Pro+ -> now OEM (it was Close before the change, Comfort Closed)
        eq(sent(), ['2f 60 fd 00'], 'Eco Pro now OEM');
        // names work too, invalid values are ignored
        e.st.diag.sent.length = 0;
        FESh({ actualValueModeDrivingExperience: 0 }); await auto._q;
        FESh({ actualValueModeDrivingExperience: 63 }); await auto._q;
        eq(sent(), [], 'initialising / invalid driving modes send nothing');
        FESh({ actualValueModeDrivingExperience: 'SPORT_DYNAMIC' }); await auto._q;
        eq(sent(), ['2f 60 fd 03 03 e8'], 'a name maps too');
        // off: it no longer follows
        set.set('driveLink', 'off'); await auto.settingsChanged('driveLink'); await auto._q; e.st.diag.sent.length = 0;
        FESh({ actualValueModeDrivingExperience: 7 }); await auto._q;
        eq(sent(), [], 'Sport Modes off: the driving mode is not followed');
    }

    // ---------------------------------------------------------------- hold, the rpm guard
    {
        const { e, live } = newEngine({ rpm: 2000 });
        const set = settingsOf();
        const auto = e.bind(set);
        auto.holdMs = 120;
        const sent = () => e.st.diag.sent.map((s) => hexs([s.sid].concat(s.data)));
        await auto.press('CLOSED');
        eq(sent(), ['2f 60 fd 03 23 28'], 'Close sent');
        await tick(330);
        ok(sent().length >= 3 && sent().every((x) => x === '2f 60 fd 03 23 28'), 'Close held (sent again): ' + sent().length);
        // over the limit: handed back, then resumed 500 rpm below it
        e.st.diag.sent.length = 0;
        live.rpm = 4600; live.at.rpm = Date.now(); await auto.tick(); await auto._q;
        eq(sent()[0], '2f 60 fd 00', 'over 4000 rpm: OEM'); ok(auto.paused, 'paused');
        live.rpm = 3800; live.at.rpm = Date.now(); await auto.tick(); await auto._q;
        ok(auto.paused, 'still paused above limit - 500');
        live.rpm = 3400; live.at.rpm = Date.now(); await auto.tick(); await auto._q;
        ok(!auto.paused && sent().pop() === '2f 60 fd 03 23 28', 'resumed below 3500');
        // a manual Close without an engine speed: OEM, latched
        live.at.rpm = Date.now() - 20000; await auto.tick(); await auto._q;
        ok(auto.rpmLost && auto.desired === 'OEM', 'no rpm: manual Close became OEM');
        live.rpm = 1500; live.at.rpm = Date.now(); await auto.tick(); await auto._q;
        eq(auto.desired, 'OEM', 'stays OEM when the signal returns (latched)');
        auto._stop();
    }
    {
        // Sport Modes' Close without rpm: paused, and back by itself
        const { e, live, handlers } = newEngine({ rpm: 2000 });
        const set = settingsOf({ driveLink: 'on' });
        const auto = e.bind(set);
        const FESh = handlers['de.bmw.infotainment.drivingexcitement.FES'].statusFESVehicleDynamicSwitchHMI;
        live.at.rpm = Date.now() - 20000;
        FESh({ actualValueModeDrivingExperience: 7 }); await auto._q;
        ok(auto.paused && auto.why === 'nosignal', 'Eco Pro Close paused without rpm');
        live.rpm = 1200; live.at.rpm = Date.now(); await auto.tick(); await auto._q;
        ok(!auto.paused && auto.effective() === 'CLOSED', 'back when the engine speed returns');
        auto._stop();
    }
    {
        // test mode: following only simulates
        const { e, handlers } = newEngine({ armed: false });
        const auto = e.bind(settingsOf({ driveLink: 'on' }));
        handlers['de.bmw.infotainment.drivingexcitement.FES'].statusFESVehicleDynamicSwitchHMI({ actualValueModeDrivingExperience: 1 }); await auto._q;
        eq(e.st.diag.sent.length, 0, 'test mode: nothing sent while following'); eq(e.st.flap, 'OPEN', 'the screen shows the simulated state');
    }

    // ---------------------------------------------------------------- 2WD
    function dsc(opts) {
        opts = opts || {};
        return (ecu, sid, d) => {
            if (sid === 0x22 && d[0] === 0xF1 && d[1] === 0x50) return ecu === 0x29 ? positive(0x22, [0xF1, 0x50, 0x00, 0x0F, 0x28, 0x50]) : positive(0x22, [0xF1, 0x50, 0x00, 0x0F, 0x29, 0xE0]);
            if (sid === 0x22 && d[0] === 0xDB && d[1] === 0xE1) return positive(0x22, [0xDB, 0xE1, 0x01]);
            if (sid === 0x22 && d[0] === 0xDB && d[1] === 0x32) return positive(0x22, [0xDB, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20]);
            if (sid === 0x2E) return opts.refuse ? refuse(0x2E, opts.refuse) : positive(0x2E, d);
            return null;
        };
    }
    function makeX(opts) {
        opts = opts || {};
        const { e } = newEngine({ answers: dsc(opts), armed: opts.armed !== false });
        const car = Object.assign({ demo: false, rpm: 0, speed: 0, stage: 'P', condition: 7 }, opts.car);
        const set = settingsOf({ xdrive: opts.enabled === false ? 'off' : 'on' });
        const x = new XDriveControl({ settings: set, log, armed: () => e.st.armed }, { data: () => car });
        x.start({ get available() { return true; }, get diag() { return e.st.diag; } });
        return { e, x, car };
    }
    const writes = (e) => e.st.diag.sent.filter((s) => s.sid === 0x2E).map((s) => hexs(s.data));
    {
        const { e, x } = makeX({ enabled: false });
        await x.refresh(); await x.requestOff(); await x.requestOff();
        eq(e.st.diag.sent.length, 0, '2WD off in Settings: nothing at all is sent (not even a read)');
        ok(/2WD Mode/.test(x.view().blocker), x.view().blocker);
    }
    {
        const { e, x } = makeX({ armed: false });
        await x.refresh();
        ok(e.st.diag.sent.every((s) => s.sid === 0x22), 'test mode: only reads');
        await x.requestOff(); await x.requestOff();
        eq(writes(e), [], 'test mode: no write, even on two presses'); ok(/Test mode/.test(x.view().note), x.view().note);
    }
    {
        const { e, x } = makeX();
        await x.refresh();
        eq(x.index, '0F2850', 'DSC variant read'); ok(x.engineMayRun(), 'G01 may run');
        await x.requestOff();
        eq(writes(e), [], 'the first press only asks'); ok(/Press again/.test(x.note), x.note);
        await x.requestOff();
        eq(writes(e), ['db e1 00'], 'the second press writes 2E DB E1 00 once');
        await x.requestOff();
        eq(writes(e), ['db e1 00'], 'a third press only asks again');
    }
    {
        // conditions not met: moving / not in P -> no write
        const a = makeX({ car: { speed: 30 } }); await a.x.refresh(); await a.x.requestOff(); await a.x.requestOff();
        eq(writes(a.e), [], 'moving: no write'); ok(/stationary/i.test(a.x.note), a.x.note);
        const b = makeX({ car: { stage: 'D' } }); await b.x.refresh(); await b.x.requestOff(); await b.x.requestOff();
        eq(writes(b.e), [], 'selector not in P: no write');
        const c = makeX({ car: { demo: true } }); await c.x.refresh(); await c.x.requestOff(); await c.x.requestOff();
        eq(writes(c.e), [], 'demo data never counts');
        // a DSC refusal is shown, nothing else is sent
        const d = makeX({ refuse: 0x22 }); await d.x.refresh(); await d.x.requestOff(); await d.x.requestOff();
        ok(/refused/.test(d.x.note), d.x.note); eq(writes(d.e), ['db e1 00'], 'one write, refused');
    }

    console.log('engine flow: ' + passed + ' checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
