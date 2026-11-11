'use strict';
/**
 * host8.js - runs the idrive7-apps screens (M Vitals, Drag Timer, Fault Scanner: the original, unchanged code, src/apps/)
 * on the iDrive 8 with the GPU renderer (mgu-render), and draws OVERBOOST's own menu / splash.
 *
 *   const host = require('./host8').create({ log, root, dataDir, signals, go: (screen) => ... });
 *   host.wanted()          the renderer is there and speaks mgu-render/1 with touch: draw with the GPU
 *   host.show('car_vitals' | 'draggy' | 'dtc_scanner' | 'menu', { splash })     bring that screen up
 *   host.hide()            nothing of ours on the GPU layer (the HMI's own rows show)
 *
 * Each app gets what the kit's runtime gave it (ctx: ui, settings, signals, canvas, loop, onTab, ... see the sessions
 * below) so its drawing code is not touched. The look is the kit's (kit/display.js: header with the page tabs, the page,
 * a slim bar), placed in the iDrive 8 app area (0,76,2880,764).
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const themes = require('./kit/themes');
const mgu = require('./kit/mgu');
const { Display } = require('./kit/display');
const { RenderClient } = require('./kit/renderd');
const { listSheet } = require('./kit/sheet');
const rec = require('./kit/record');

const SCREEN = { car_vitals: 'VITALS', draggy: 'DRAG', dtc_scanner: 'FAULTS', engine: 'ENGINE', update: 'UPDATE' };
const NAMES = { car_vitals: 'M Vitals', draggy: 'Drag Timer', dtc_scanner: 'Fault Scanner', menu: 'OVERBOOST' };

/* ---------------- settings: one file per app, as the kit's runtime keeps them ---------------- */
class Settings {
    constructor(schema, file, log) {
        this.schema = schema || []; this.file = file; this.log = log;
        this.values = {}; this.listeners = [];
        for (const s of this.schema) this.values[s.key] = s.default;
        try { Object.assign(this.values, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* defaults */ }
        // a setting with "reset": n goes back to its default once when n changes (a new default reaches cars that saved the old one)
        let changed = false;
        for (const it of this.schema) {
            const mark = '_reset_' + it.key;
            if (it.reset && this.values[mark] !== it.reset) { this.values[it.key] = it.default; this.values[mark] = it.reset; changed = true; }
        }
        if (changed) this._save();
    }
    _save() { try { fs.writeFileSync(this.file, JSON.stringify(this.values, null, 1)); } catch (e) { this.log.warn('settings save: ' + e); } }
    get(key) { return this.values[key]; }
    set(key, value) {
        this.values[key] = value; this._save();
        this.listeners.forEach((fn) => { try { fn(key, value); } catch (e) { this.log.error(e); } });
    }
    onChange(fn) { this.listeners.push(fn); }
    item(key) { return this.schema.find((s) => s.key === key); }
    display(key) {
        const s = this.item(key), v = this.values[key];
        if (!s) return String(v);
        if (s.type === 'choice') { const o = (s.options || []).find((x) => x[0] === v); return o ? o[1] : String(v); }
        if (s.type === 'number') return String(v) + (s.unit ? ' ' + s.unit : '') + (s.markDefault && v === s.default ? ' (default)' : '');
        if (s.type === 'bool') return v ? 'On' : 'Off';
        return String(v);
    }
    cycle(key) {
        const s = this.item(key);
        if (!s) return;
        if (s.type === 'bool') return this.set(key, !this.values[key]);
        const list = s.type === 'choice' ? s.options.map((o) => o[0]) : (s.steps || []);
        if (!list.length) return;
        const i = list.indexOf(this.values[key]);
        this.set(key, list[(i + 1) % list.length]);
    }
}

/* ---------------- the kit's "ui" (RHMI components) for a screen the GPU draws ---------------- */
class FakeRhmi {
    constructor() { this.comps = {}; }
    getByName(n) { return this.comps[n] || (this.comps[n] = new EventEmitter()); }
}
class GUi {
    constructor(log) {
        this.log = log; this.rhmi = new FakeRhmi(); this.display = null;
        this._visible = {}; this._visHandlers = []; this._focus = {}; this._focusHandlers = [];
        this.timing = { png: 0, push: 0 }; this.closeFn = null;
    }
    comp(n) { return this.rhmi.getByName(n); }
    text(name, t, row, cell) {
        if (this.display && !row && (!cell || cell === 'Text')) this.display.label(name, t);       // the slim bar mirrors it
        return Promise.resolve();
    }
    cells() { return Promise.resolve(); }
    selected() { return Promise.resolve(); }
    rows() { return Promise.resolve(); }
    visible() { return Promise.resolve(); }
    enabled() { return Promise.resolve(); }
    checked() { return Promise.resolve(); }
    onClick(name, fn) {
        this.comp(name).on('action', (ev) => Promise.resolve().then(() => fn(ev || {})).catch((e) => this.log.error('click ' + name, e)));
    }
    open() { return Promise.resolve(); }
    close() { return Promise.resolve(this.closeFn && this.closeFn()); }
    isVisible(n) { return !!this._visible[n]; }
    hasFocus(n) { return this._focus[n] !== false; }
    onFocus(fn) { this._focusHandlers.push(fn); }
    _setFocus(n, on) {
        if (this.hasFocus(n) === on) return;
        this._focus[n] = on;
        this._focusHandlers.forEach((fn) => { try { fn(n, on); } catch (e) { this.log.error(e); } });
    }
    _invalidate() { /* nothing is pushed to the HMI */ }
    onVisible(fn) { this._visHandlers.push(fn); }
    _setVisible(n, on) {
        if (this._visible[n] === on) return;
        this._visible[n] = on;
        if (on) this._focus[n] = true;
        this._visHandlers.forEach((fn) => { try { fn(n, on); } catch (e) { this.log.error(e); } });
    }
    image(name, img) {
        return this.display ? this.display.present(name, img, () => Promise.resolve()) : Promise.resolve();
    }
}

/* ---------------- one screen = one app ---------------- */
class Session {
    constructor(host, id) {
        this.host = host; this.id = id; this.started = false; this.failed = null;
        const dir = path.join(__dirname, 'apps', id);
        const spec = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
        // "Menu": back to OVERBOOST's menu (the HMI's back arrow leaves the app altogether)
        this.spec = spec;
        const data = path.join(host.dataDir, id);
        try { fs.mkdirSync(data); } catch (e) { /* exists */ }
        this.dataDir = data;
        const L = this.log = {};
        ['error', 'warn', 'info', 'debug'].forEach((lvl) => {
            L[lvl] = (...a) => {
                if (lvl === 'debug') return;
                host.log(lvl.toUpperCase() + ' [' + id + '] ' + a.map((x) => (x && x.stack) ? x.stack : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
            };
        });
        this.settings = new Settings(spec.settings, path.join(data, 'settings.json'), L);
        this.ui = new GUi(L);
        this.ui.closeFn = () => host.back();
        const theme = () => themes.theme(this.settings.get('theme'));
        if (id !== 'menu') spec.__chips = {
            items: () => [{ label: 'M Vitals', screen: 'VITALS' }, { label: 'Drag Timer', screen: 'DRAG' }, { label: 'Fault Scanner', screen: 'FAULTS' },
                { label: 'Engine Config', screen: 'ENGINE' }].concat(require('./kit/hmi').id7 ? [] : [{ label: 'Update', screen: 'UPDATE' }]),
            current: () => SCREEN[id],
            open: (k) => { const it = spec.__chips.items()[k]; if (it && it.screen !== SCREEN[id]) host.nav(it.screen); },
        };
        this.display = new Display(this.ui, L, spec, this.settings, theme, host.gpu);
        this.ui.display = this.display;
        // the apps' header: the logo and a button for each app, to switch without going back to the menu
        // graphics only: the layer stays wanted; the renderer shows it as soon as its gate has the app in front
        this.display.onBlocked = () => { host.log('WARN GPU layer not in front yet'); };
        this.ctx = this._ctx(theme);
        // the app: its start function (mgu.run in its main.js)
        require(path.join(dir, 'main.js'));
        this.impl = mgu.take();
        if (!this.impl || !this.impl.start) throw new Error(id + ': no start function');
        this._settings();
    }

    /** Settings: drawn over the page (kit/sheet.js) from the header's last tab. */
    _settings() {
        const { ui, settings, display } = this;
        if (!settings.schema.length) return;
        ui.onClick('BTN_SETTINGS', () => {
            if (display.sheet && display.sheet.settings) { display.closeSheet(); return null; }
            const sh = listSheet(settings, null, { version: this.host.version });
            sh.settings = true;
            display.openSheet(sh);
            return null;
        });
    }

    _ctx(theme) {
        const { ui, settings, log } = this, host = this.host, self = this;
        const display = this.display;
        return {
            ui, settings, log, spec: this.spec, dataDir: this.dataDir, display, host,
            signals: host.signals, theme,
            controller: { grab(on) { display.grab(on); }, onInput(fn) { display.onCcu = fn; } },
            onTab(fn) { display.onTab = fn; },
            onTap(fn) { display.onTap = fn; },
            sheet(sh) { return display.openSheet(sh); },
            hideButton(id) { display.hideButton(id); },
            onScroll(fn) { display.onScroll = fn; },
            onLayout(fn) { display.onLayout(fn); },
            canvas(w, h) { return display.canvas(w, h); },
            loop(stateName, fps, fn) {
                let timer = null, on = false, running = false;
                const gpuOn = () => display.active(stateName);
                const tick = async () => {
                    timer = null;
                    if (!on || running) return;
                    running = true;
                    const t0 = Date.now();
                    try { await fn(); } catch (e) { log.error('loop ' + stateName, e); }
                    running = false;
                    schedule(Date.now() - t0);
                };
                const schedule = (dt) => {
                    if (!on || timer !== null || running) return;
                    // the renderer sends a tick when it can take the next frame; 250 ms is the safety net if none comes
                    if (gpuOn()) timer = setTimeout(tick, display.gpu && display.gpu.waiting ? 250 : 16);
                    else timer = setTimeout(tick, Math.max(15, 1000 / fps - (dt || 0)));
                };
                display.onTick(() => {
                    if (!on || running) return;
                    if (timer !== null) { clearTimeout(timer); timer = null; }
                    if (gpuOn()) tick(); else schedule(0);
                });
                const set = (v) => {
                    on = v;
                    if (on && timer === null && !running) timer = setTimeout(tick, 0);
                    if (!on && timer !== null) { clearTimeout(timer); timer = null; }
                };
                ui.onVisible((name, v) => { if (name === stateName) set(v); });
                if (ui.isVisible(stateName)) set(true);
                return { stop: () => set(false), kick: () => { if (on && !running) { if (timer !== null) clearTimeout(timer); timer = setTimeout(tick, 0); } } };
            },
        };
    }

    /** Run the app's start function now (its loops only draw while its screen is visible). */
    async prestart() {
        if (this.started) return;
        this.started = true;
        try { await this.impl.start(this.ctx); } catch (e) { this.failed = e; this.log.error('start failed', e); }
    }

    async enter(arg) {
        this.arg = arg || {};
        this.ctx.arg = this.arg;
        this.display.attach();
        await this.prestart();
        this.ui._setVisible('MAIN', true);
        this.display.tickHandlers.forEach((fn) => fn());
    }

    leave(keep) {
        this.display.dispose(keep);          // (first: the visibility change must not hide the layer through the display)
        this.ui._setVisible('MAIN', false);
    }
}

/* ---------------- the host ---------------- */
function create(opts) {
    const host = {
        log: opts.log, dataDir: opts.dataDir, signals: opts.signals, version: opts.version || '', status: opts.status || (() => ({})),
        go: opts.go || (() => {}), sessions: {}, current: null, front: true, gpu: null, failed: {},
    };
    const gpu = host.gpu = opts.gpu || new RenderClient(opts.appId || 'overboost', {
        info: (m) => host.log('INFO ' + m), warn: (m) => host.log('WARN ' + m), error: (m) => host.log('ERROR ' + m), debug() {},
    }, { native: true });
    gpu.on('ready', () => {
        // the first screens are made ahead (the logo and M Vitals), so opening the app only has to draw
        setImmediate(async () => { for (const id of ['menu', 'car_vitals', 'engine']) { const s = host.session(id); if (s) { try { await s.prestart(); } catch (e) { /* logged */ } } } });
        host.log('GPU ready ' + JSON.stringify({ screen: gpu.screen, native: gpu.native, touch: gpu.touch, info: gpu.info })); host.changed(); });
    gpu.on('close', () => { host.log('GPU closed'); host.changed(); });
    gpu.on('state', (s) => {
        host.log('GPU state ' + JSON.stringify(s));
        // the renderer says the app is in front again: don't wait for the retry timer
        if (s.front && host.noGpuUntil > Date.now()) { host.noGpuUntil = 0; host.changed(); }
    });
    gpu.on('renderer-error', (m) => host.log('GPU error ' + m));
    /* The renderer says controller: false (the HMI's controller gate is not installed): read the iDrive controller
     * ourselves from FrontCCU and hand its events to the screens as the renderer would. */
    const FCCU = 'de.bmw.infotainment.controlelements.FrontCCU';
    const num = (v, fallback) => (typeof v === 'number' ? v : fallback);
    const pushNo = (v) => (typeof v === 'number' ? v : /LANG/.test(String(v)) ? 2 : /KURZ|GEDRUECKT/.test(String(v)) && !/KEINE/.test(String(v)) ? 1 : 0);
    const deflNo = (v) => {
        if (typeof v === 'number') return v;
        const s = String(v), base = /NORD/.test(s) ? 1 : /OST/.test(s) ? 4 : /SUED/.test(s) ? 7 : /WEST/.test(s) ? 10 : -1;
        return base < 0 ? 0 : base + (/LANG/.test(s) ? 1 : 0);
    };
    function bridgeCcu() {
        if (host.ccuBridge || !host.signals || !host.signals.watch) return;
        host.ccuBridge = true;
        Promise.resolve(host.signals.watch(FCCU, '1', {
            statusRotaryEncoderState: (v) => {
                if (!v) return;
                gpu.emit('ccu', {
                    frontSequenceNumberOperatingElement: num(v.frontSequenceNumberOperatingElement, 0),
                    frontRotaryEncoderOperation: num(v.frontRotaryEncoderOperation, 0),
                    frontRotaryEncoderPushButton: pushNo(v.frontRotaryEncoderPushButton),
                    frontRotaryEncoderDeflection: deflNo(v.frontRotaryEncoderDeflection),
                });
            },
        }, { warn: (m) => host.log('WARN ' + m), info: (m) => host.log('INFO ' + m) })).then((r) => host.log('INFO FrontCCU controller ' + (r && r.error ? 'unavailable: ' + r.error : 'read here (the renderer has no controller gate)'))).catch((e) => host.log('WARN FrontCCU ' + e));
    }
    gpu.on('ready', () => { if (gpu.info && !gpu.info.controller) bridgeCcu(); });
    host.changed = () => { try { if (opts.onChange) opts.onChange(); } catch (e) { host.log('ERROR onChange ' + e); } };

    function connect() {
        if (RenderClient.available()) { gpu.connect(); return; }
        host.poll = setTimeout(connect, 5000);
    }
    if (!opts.gpu) Promise.resolve(opts.connectAfter).then(connect);

    host.available = () => !!(gpu.ready && gpu.native && gpu.touch);
    /** draw with the GPU: the renderer is there, and the current screen is not kept off the screen by the gate */
    host.noGpuUntil = 0;
    host.wanted = () => host.available() && Date.now() >= host.noGpuUntil;

    host.session = (id) => {
        if (host.failed[id]) return null;
        if (!host.sessions[id]) {
            try { host.sessions[id] = new Session(host, id); } catch (e) { host.failed[id] = e; host.log('ERROR session ' + id + ' ' + (e.stack || e)); return null; }
        }
        return host.sessions[id];
    };

    host.show = async (id, arg) => {
        if (!host.available()) return false;
        const cur = host.sessions[host.current];
        if (cur && host.current === id) { cur.ctx.arg = arg || {}; return true; }
        if (cur) cur.leave(true);          // (the renderer keeps the last picture on screen until the next app draws: no flash of the HMI's blue)
        const s = host.session(id);
        if (!s) { host.current = null; return false; }
        host.current = id;
        await s.enter(arg);
        return true;
    };
    host.hide = () => {
        const cur = host.sessions[host.current];
        if (cur) cur.leave();
        host.current = null;
    };
    host.back = () => { host.go('VITALS'); };
    host.nav = (screen) => { host.go(screen); };
    host.name = (id) => NAMES[id] || id;
    host.setFront = (on) => { host.front = on; };
    return host;
}

module.exports = { create, Settings, NAMES };
