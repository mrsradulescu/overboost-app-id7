'use strict';
/**
 * auto.js - what the exhaust flap should be doing, on top of engine.js (which sends it). Follows idrive7-apps' Engine Config
 * (cauliflowermossgrape, MIT): hold, the Close rpm guard, the no-rpm fail-safe - and "Sport Modes": the flap forced to a state
 * per driving mode, each of the four groups chosen on the Sport Modes page.
 *
 *   buttons     OPEN / CLOSE / OEM: that mode, the driving mode is not followed.
 *   Sport Modes the flap follows the driving mode on every change, per group (settings modeSport .. modeAdaptive):
 *                 Sport / Sport+ / Sport Individual            (default Open)
 *                 Comfort / Comfort+ / Comfort Individual      (default OEM, the car's own strategy)
 *                 Eco Pro / Eco Pro+ / Eco Pro Individual      (default Closed)
 *                 Adaptive                                     (default OEM)
 *   rpm guard   Close is paused (OEM sent, the DME opens the flap as it needs) while the live engine speed is above the
 *               "Close: hand back above" setting, and resumes 500 rpm below it.
 *   no rpm      Armed with a limit set, Close is not held without a live engine speed (none yet, or none for 5 s):
 *               a manual CLOSE becomes OEM, latched (press CLOSE again); a Sport Modes Close becomes OEM, paused, and comes
 *               back by itself once a live engine speed below the limit - 500 rpm is back.
 *   hold        the DME lets a tester's command go after ~20 s, so OPEN / CLOSED is sent again every 15 s (BMW's job only;
 *               MHD holds its own).
 *
 * Disarmed (test mode): engine.js simulates, nothing reaches the car. Nothing here talks to the car itself: every command
 * goes through c.setMode().
 */

const HYST = 500;
const GROUPS = [
    { key: 'sport', setting: 'modeSport', label: 'Sport', modes: 'Sport · Sport+ · Sport Individual', dflt: 'open' },
    { key: 'comfort', setting: 'modeComfort', label: 'Comfort', modes: 'Comfort · Comfort+ · Comfort Individual', dflt: 'oem' },
    { key: 'eco', setting: 'modeEco', label: 'Eco Pro', modes: 'Eco Pro · Eco Pro+ · Eco Pro Individual', dflt: 'close' },
    { key: 'adaptive', setting: 'modeAdaptive', label: 'Adaptive', modes: 'Adaptive', dflt: 'oem' },
];
const TO_FLAP = { open: 'OPEN', close: 'CLOSED', oem: 'OEM' };

/** the driving mode (FES statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience, name or number) -> group key, or null */
function groupOf(raw) {
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    if (!isNaN(n) && String(raw).trim() !== '') {
        if (n >= 1 && n <= 3) return 'sport';
        if (n >= 4 && n <= 6) return 'comfort';
        if (n >= 7 && n <= 9) return 'eco';
        if (n === 10) return 'adaptive';
        return null;                               // 0, 61-63: initialising / invalid
    }
    const s = String(raw).toUpperCase();
    if (/SPORT/.test(s)) return 'sport';
    if (/ECO/.test(s)) return 'eco';
    if (/ADAPTIVE|TRAFFIC/.test(s)) return 'adaptive';
    if (/COMFORT/.test(s)) return 'comfort';
    return null;
}

/** a readable name for the screen */
function modeName(raw) {
    const N = { 1: 'Sport', 2: 'Sport+', 3: 'Sport Individual', 4: 'Comfort', 5: 'Comfort+', 6: 'Comfort Individual',
        7: 'Eco Pro', 8: 'Eco Pro+', 9: 'Eco Pro Individual', 10: 'Adaptive', SPORT_DYNAMIC: 'Sport', SPORT_EXPERT: 'Sport+',
        ECO_PRO_EFFICIENT: 'Eco Pro' };
    return N[raw] || (raw == null ? null : String(raw).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()));
}

class AutoFlap {
    /**
     * o.controller  engine.js's controller ({ setMode(mode), st, holdsItself() })
     * o.get(key) / o.set(key, v)  the app's settings;  o.rpm()  live engine speed or null;  o.log;  o.holdMs (15000);  o.onChange()
     */
    constructor(o) {
        this.c = o.controller;
        this.get = o.get;
        this.set = o.set || (() => {});
        this.rpm = o.rpm || (() => null);
        this.log = o.log;
        this.holdMs = o.holdMs || 15000;
        this.onChange = o.onChange || (() => {});
        this.desired = 'OEM';
        this.source = 'start';        // start | press | drive
        this.drive = null;            // last driving mode (raw)
        this.paused = false;          // Close paused by the rpm guard
        this.why = null;              // 'rpm' (over the limit) | 'nosignal' (Sport Modes, no engine speed)
        this.sent = 'OEM';            // the mode last sent (or simulated)
        this.nextAt = 0;
        this._timer = null;
        this._q = Promise.resolve();
        this._link = this.linkOn ? 'on' : 'off';
        this.rpmLost = false;         // latched after a manual CLOSE loses its engine speed
    }

    get linkOn() { return this.get('driveLink') === 'on'; }
    get holdOn() { return this.get('hold') !== 'off' && !(this.c.holdsItself && this.c.holdsItself()); }
    get limit() { const v = Number(this.get('closeLimit')); return v > 0 ? v : null; }
    get armed() { return !!(this.c.st && this.c.st.armed); }

    /** what flap state a driving mode asks for under the chosen mapping, or null */
    flapFor(raw) {
        const g = groupOf(raw);
        if (!g) return null;
        const grp = GROUPS.find((x) => x.key === g);
        const v = this.get(grp.setting);
        return TO_FLAP[v] || TO_FLAP[grp.dflt];
    }

    /** what goes to the car now */
    effective() { return this.desired === 'CLOSED' && this.paused ? 'OEM' : this.desired; }

    /** 'SPORT' while the driving mode is followed, else the mode asked for */
    selected() { return this.linkOn ? 'SPORT' : this.desired; }

    /** a button: 'OPEN' | 'CLOSED' | 'OEM' (manual, stops following the driving mode) or 'SPORT' (follow it) */
    press(mode) {
        if (mode === 'SPORT') {
            if (!this.linkOn) { this._link = 'on'; this.set('driveLink', 'on'); }
            this.desired = this.flapFor(this.drive) || 'OEM'; this.source = 'drive';
        } else {
            if (this.linkOn) { this._link = 'off'; this.set('driveLink', 'off'); }
            this.desired = mode; this.source = 'press';
        }
        this.rpmLost = false;
        if (this.desired === 'CLOSED' && this.source === 'press' && this._blind()) {
            this.desired = 'OEM';
            this.rpmLost = true;
            this.log.warn('manual CLOSE blocked: no valid RPM; requesting OEM');
        }
        this._pauseFor(this.desired);
        return this.apply(true);
    }

    /** the driving mode changed (or arrived): with Sport Modes on, the flap follows it */
    driveMode(raw) {
        const prev = this.drive;
        this.drive = raw;
        if (!this.linkOn || String(prev) === String(raw)) return null;
        const m = this.flapFor(raw);
        if (!m) return null;
        this.desired = m; this.source = 'drive';
        this._pauseFor(m);
        this.log.info('drive mode ' + modeName(raw) + ' -> ' + m);
        return this.apply(false);
    }

    /** a group's mapping was changed on the Sport Modes page: the current driving mode takes it at once */
    mappingChanged() {
        if (!this.linkOn || this.drive == null) return Promise.resolve();
        const m = this.flapFor(this.drive);
        if (!m || (m === this.desired && this.source === 'drive')) return Promise.resolve();
        this.desired = m; this.source = 'drive';
        this._pauseFor(m);
        return this.apply(false);
    }

    /** Close wanted right now: paused if over the limit, or (Sport Modes) with no engine speed */
    _pauseFor(m) {
        this.why = m !== 'CLOSED' ? null : this._over() ? 'rpm' : this.source === 'drive' && this._blind() ? 'nosignal' : null;
        this.paused = !!this.why;
    }

    /** the car came up (ignition on): the DME starts on its own strategy, send what is wanted again */
    linkUp() {
        this.sent = 'OEM';
        if (this.linkOn && this.drive != null) { const m = this.flapFor(this.drive); if (m) { this.desired = m; this.source = 'drive'; } }
        return this.apply(false);
    }

    settingsChanged(key) {
        if (key === 'driveLink') {
            const v = this.linkOn ? 'on' : 'off';
            if (v === this._link) return Promise.resolve();     // set by a button press: already applied
            this._link = v;
            if (this.linkOn && this.drive != null) {
                const m = this.flapFor(this.drive);
                if (m) { this.desired = m; this.source = 'drive'; this._pauseFor(m); return this.apply(false); }
            }
            if (!this.linkOn && this.source === 'drive') { this.desired = 'OEM'; this.source = 'press'; return this.apply(false); }
        }
        if (GROUPS.some((g) => g.setting === key)) return this.mappingChanged();
        if (key === 'hold' || key === 'arm') { this._stop(); if (this.armed && this.holdOn && this.sent !== 'OEM') this._schedule(); }
        if (key === 'closeLimit') return this.tick();
        return Promise.resolve();
    }

    _over() { const r = this.rpm(), l = this.limit; return !!(l && r !== null && r > l); }
    /** armed, a limit set, and no live engine speed: the guard can't see, so Close is not held */
    _blind() { return !!(this.armed && this.limit && this.rpm() === null); }

    /** a few times a second: the Close rpm guard and the no-rpm fail-safe */
    tick() {
        if (this.source === 'press' && this.desired === 'CLOSED' && this._blind()) {
            this.rpmLost = true;
            this.desired = 'OEM';
            this.paused = false; this.why = null;
            this._stop();
            this.log.warn('manual CLOSE lost RPM: requesting OEM; manual reselect required');
            return this.apply(true);
        }
        if (this.desired !== 'CLOSED') { this.paused = false; this.why = null; return Promise.resolve(); }
        const r = this.rpm(), l = this.limit;
        if (!l) { if (this.paused) { this.paused = false; this.why = null; return this.apply(false); } return Promise.resolve(); }
        if (r === null) {
            if (this.armed && this.why !== 'nosignal') {
                this.paused = true; this.why = 'nosignal';
                this.log.warn('Sport Modes CLOSE paused: no valid RPM; requesting OEM');
                return this.apply(false);
            }
            return Promise.resolve();
        }
        if (this.paused && this.why === 'nosignal' && r >= l - HYST) { this.why = 'rpm'; return Promise.resolve(); }
        if (!this.paused && r > l) { this.paused = true; this.why = 'rpm'; this.log.info('close paused at ' + Math.round(r) + ' rpm'); return this.apply(false); }
        if (this.paused && r < l - HYST) { this.paused = false; this.why = null; this.log.info('close resumed at ' + Math.round(r) + ' rpm'); return this.apply(false); }
        return Promise.resolve();
    }

    /** send the effective mode if it changed (force: a press always sends) */
    apply(force) {
        this._q = this._q.then(async () => {
            const eff = this.effective();
            if (!force && eff === this.sent) return;
            this._stop();
            await this.c.setMode(eff);
            this.sent = eff;
            if (eff !== 'OEM' && this.armed && this.holdOn) this._schedule();
        }).catch((e) => this.log.error('auto ' + (e && e.message || e))).then(() => this.onChange());
        return this._q;
    }

    _schedule() {
        this._stop();
        this.nextAt = Date.now() + this.holdMs;
        this._timer = setTimeout(() => {
            this._q = this._q.then(async () => {
                const eff = this.effective();
                if (eff === 'OEM' || eff !== this.sent || !this.armed || !this.holdOn) return;
                await this.c.setMode(eff);
                this._schedule();
            }).catch((e) => this.log.error('hold ' + (e && e.message || e))).then(() => this.onChange());
        }, this.holdMs);
        if (this._timer.unref) this._timer.unref();
    }

    _stop() { clearTimeout(this._timer); this._timer = null; this.nextAt = 0; }

    /** a line for the screen under the state word */
    note() {
        const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        if (this.rpmLost) return { text: 'RPM signal lost · OEM requested · select CLOSE again', warn: true };
        if (this.desired === 'CLOSED' && this.paused && this.why === 'nosignal') return { text: 'RPM signal lost · Close paused · the car has the flap', warn: true };
        if (this.desired === 'CLOSED' && this.paused) return { text: 'Close paused above ' + fmt(this.limit) + ' rpm · the car has the flap', warn: true };
        const parts = [];
        if (this.linkOn) parts.push(this.drive != null && this.flapFor(this.drive) ? modeName(this.drive) : 'Waiting for the driving mode');
        if (!this.linkOn && this.sent !== 'OEM' && this.armed && this.holdOn && this.nextAt) parts.push('holding');
        return parts.length ? { text: parts.join(' · '), warn: false } : null;
    }
}

module.exports = { AutoFlap, groupOf, modeName, GROUPS, TO_FLAP, HYST };
