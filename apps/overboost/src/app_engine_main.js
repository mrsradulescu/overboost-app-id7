'use strict';
/**
 * OVERBOOST Engine Config: the idrive7-apps "Live Adjustments" screen (ui.js: twin tailpipes with the butterfly valves,
 * the state word, OEM / Open / Close / Sport Modes) on OVERBOOST's engine.js (DME over the diagnostic link).
 *   Exhaust Flap: always.   2WD: xDrive off until the ignition is switched off (xdrive.js); its page appears only with "2WD Mode: On (non-M car)" in Settings.
 *   Sport Modes: the flap forced to a state per driving mode (auto.js).
 *   Engine Map, Max Cooling: with "Tuning software: MHD" in Settings.
 *   Ethanol: always - the ethanol % of the fuel, read only (nothing is ever sent that changes the car).
 * Safety as before: "Exhaust Flap: Disarmed" (simulated, nothing is sent) is the setting at every start and when
 * the app is left; the commands leave only on a button press.
 */
const mgu = require('./kit_mgu.js');
const G = require('./kit_gauges.js');
const UI = require('./app_engine_ui.js');
const { XDriveControl } = require('./app_engine_xdrive.js');
const { modeName, groupOf, GROUPS } = require('./app_engine_auto.js');

mgu.run({
    async start(ctx) {
        const { ui, settings, host } = ctx;
        const engine = host.svc && host.svc.engine;
        const st = engine ? engine.st : null;
        let page = 'Exhaust Flap', angle = 0.18;
        let probed = false;
        // the flap logic (hold, the Close rpm guard, Sport Modes) lives in engine.js and runs from here on, also off screen
        const auto = engine ? engine.bind(settings) : null;
        // 2WD (experimental): reads on its page only; the one write needs 2WD on in Settings, the live version and two presses
        const link = { get available() { return !!(st && st.diag && st.diag.available); }, get diag() { return st && st.diag; } };
        const xdrive = engine ? new XDriveControl({ settings, log: ctx.log, spec: ctx.spec, armed: () => !!st.armed }, { data: () => engine.carData() }) : null;
        let linkWas = false;
        const repaint = () => render().catch((e) => ctx.log.error('repaint', e));

        const sync = () => {
            if (!st) return;
            st.armed = settings.get('arm') === 'on';
            st.platform = settings.get('tuner') === 'mhd' ? 'mhd' : 'stock';
        };
        const pages = () => ['Exhaust Flap'].concat(xdrive && xdrive.enabled ? ['2WD'] : [], ['Sport Modes'], st && st.platform === 'mhd' ? ['Engine Map', 'Max Cooling'] : [], ['Ethanol']);
        const okOf = (v) => (v === true ? 'confirmed' : null);
        // a press: repaint at once ("Sending ..."), again with the DME's answer
        const act = (fn) => () => { const p = fn(); repaint(); return Promise.resolve(p).then(repaint).catch((e) => ctx.log.error('action', e)); };
        const acts = {
            oem: act(() => auto.press('OEM')), open: act(() => auto.press('OPEN')), close: act(() => auto.press('CLOSED')),
            sport: act(() => auto.press('SPORT')),
            map: (n) => () => engine.setMap(n),
            cooling: (on) => () => engine.setCooling(on),
            xdriveOff: act(() => xdrive.requestOff()), xdriveOn: act(() => xdrive.requestOn()),
            sportFollow: (on) => act(() => (on ? auto.press('SPORT') : settings.set('driveLink', 'off'))),
            sportMap: (group, value) => act(() => settings.set(GROUPS.find((g) => g.key === group).setting, value)),
        };
        const target = (v) => {
            const s = v.confirmed !== 'UNKNOWN' ? v.confirmed : v.requested;
            return s === 'OPEN' ? 1 : s === 'CLOSED' ? 0 : s === 'OEM' ? 0.18 : 0.5;
        };

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(UI.W, UI.H);
            if (!st) { cv.clear(t.bg); cv.text('Diagnostics unavailable (no SOME/IP module)', 800, 260, 30, t.dim, { align: 'center' }); await ui.image('MAIN_GFX', cv); return; }
            sync();
            if (link.available !== linkWas) { linkWas = link.available; if (linkWas) xdrive.refresh().then(repaint, () => {}); }
            if (page === 'Ethanol' && st.platform === 'mhd') engine.readEthanol().catch(() => {});      // read only, once a second, only while this page is shown
            if (!probed && st.diag && st.diag.available && st.platform !== 'mhd') { probed = true; engine.probe().catch(() => {}); }
            const list = pages();
            if (list.indexOf(page) < 0) page = list[0];
            const v = {
                requested: st.flap, confirmed: st.flapOk === true ? st.flap : 'UNKNOWN', simulated: !st.armed,
                error: null,
                status: st.busy ? { text: 'Sending the command to the DME...', kind: 'busy' }
                    : !st.armed ? { text: 'Test mode: nothing is sent to the car', kind: 'dim' }
                    : st.flapOk === true ? { text: (st.note || 'DME confirmed'), kind: 'ok' }
                    : st.flapOk === false ? { text: 'Not accepted - ' + (st.note || 'no reason given'), kind: 'bad' }
                    : { text: '', kind: '' },
                pages: list, page,
                ethanol: st.platform === 'mhd' ? { pct: engine.ethanol(), status: st.ethStatus }
                    : { pct: null, status: 'Needs "Tuning software: MHD" (flex-fuel) in Settings' },
                selected: auto.selected(), note: auto.note(),
                sport: {
                    follow: auto.linkOn, armed: st.armed, drive: auto.drive != null && groupOf(auto.drive) ? modeName(auto.drive) : null, group: groupOf(auto.drive),
                    mapping: { sport: settings.get('modeSport'), comfort: settings.get('modeComfort'), eco: settings.get('modeEco'), adaptive: settings.get('modeAdaptive') },
                    note: auto.note() && auto.note().warn ? auto.note().text : null,
                },
                tune: {
                    armed: st.armed, tuner: st.platform, features: { map: true, cooling: true },
                    map: st.map, mapConfirmed: st.mapOk === true, readback: false,
                    cooling: st.cooling === null ? null : st.cooling ? 'ON' : 'OFF', rpm: engine.rpm(), minCoolingRpm: 500,
                    busy: !!st.busy, note: st.note || '', noteType: st.mapOk === false || st.coolingOk === false ? 'warn' : '',
                },
            };
            if (page === '2WD') {
                const r = xdrive.tick();             // DBE1 read now and then, only on this page
                if (r) r.then(repaint, (e) => ctx.log.error('xdrive', e));
                v.xdrive = xdrive.view();
            }
            const tg = target(v);
            angle += (tg - angle) * 0.25;
            if (Math.abs(tg - angle) < 0.003) angle = tg;
            v.angle = angle;
            UI.draw(cv, G, t, v, acts);
            await ui.image('MAIN_GFX', cv);
        }

        // settings: the flap logic and 2WD look again when theirs change (nothing is sent by a setting)
        if (engine) {
            settings.onChange((key) => Promise.resolve(key === 'xdrive' ? xdrive.refresh() : null)
                .then(() => auto.settingsChanged(key)).then(repaint).catch((e) => ctx.log.error('settings', e)));
            xdrive.start(link).catch((e) => ctx.log.error('xdrive start', e));
        }
        ctx.onTab((i) => { const l = pages(); if (l[i]) page = l[i]; return render(); });
        ctx.loop('MAIN', 20, render);
    },
});
