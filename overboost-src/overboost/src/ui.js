'use strict';
/**
 * ui.js - the screen: one RHMI list state with a pool of rows (logo, 8 info lines, 9 buttons). A "screen" is a
 * description { title, logo, lines[], buttons[{t, f}] }; show() writes only what changed and hides unused rows.
 * Only what the id8-logger already proved on a real unit is relied on (Text of labels / buttons, button actions);
 * Visible (setProperty) and the logo (Graphic asset) are used defensively: if the HMI refuses them the text
 * screens still work.
 */
const path = require('path');
const LINES = 8, BUTTONS = 9;

class Ui {
    constructor(app, log, root) {
        this.app = app; this.log = log; this.root = root;
        this.visible = false;
        this.shown = {};           // row -> text last written
        this.vis = {};             // row -> visibility last written
        this.cur = { buttons: [] };
        this.logoOk = null;
        this.problems = {};
    }
    get rhmi() { return this.app.rhmiApplication; }
    comp(n) { return this.rhmi.getByName(n); }
    warn(k, e) { if (!this.problems[k]) { this.problems[k] = true; this.log('UI_WARN ' + k + ' ' + String(e && (e.stack || e.message) || e).slice(0, 300)); } }

    reset() { this.shown = {}; this.vis = {}; }

    text(name, t) {
        if (!this.visible || this.shown[name] === t) return Promise.resolve();
        const c = this.comp(name);
        if (!c) return Promise.resolve();
        this.shown[name] = t;
        return Promise.resolve(c.setValue(0, 'Text', t, 'Text')).catch((e) => { this.shown[name] = null; this.warn('text ' + name, e); });
    }
    show(name, on) {
        if (!this.visible || this.vis[name] === on) return Promise.resolve();
        const c = this.comp(name);
        if (!c) return Promise.resolve();
        this.vis[name] = on;
        return Promise.resolve(c.setProperty('Visible', on ? 1 : 0, 'UInt')).catch((e) => { this.vis[name] = null; this.warn('visible ' + name, e); });
    }

    async setLogo() {
        if (this.logoOk !== null) return;
        try {
            const rb = this.rhmi.getResourceBundle();
            const file = path.join(this.root, 'rhmiData', 'resources', 'overboost_logo.png');
            await rb.createResourceHandles([file]);
            const handle = rb.getResourceHandle(file);
            await this.comp('LOGO').setValue(0, 'Graphic', handle, 'Asset');
            this.logoOk = true;
            this.log('LOGO_OK ' + JSON.stringify(handle));
        } catch (e) { this.logoOk = false; this.warn('logo', e); }
    }

    /** s = { title, logo: bool, lines: [text], buttons: [{ t, f }] } */
    async render(s) {
        this.cur = s;
        if (require('./kit/hmi').id7) return;
        if (!this.visible) return;
        if (s.logo) await this.setLogo();
        const jobs = [];
        jobs.push(this.show('LOGO', !!s.logo && this.logoOk !== false));
        jobs.push(this.text('MAIN_TITLE', s.title || 'OVERBOOST'));
        for (let i = 0; i < LINES; i++) {
            const t = (s.lines || [])[i];
            jobs.push(this.text('L' + (i + 1), t === undefined || t === '' ? ' ' : String(t)));
            jobs.push(this.show('L' + (i + 1), t !== undefined && t !== ''));
        }
        for (let i = 0; i < BUTTONS; i++) {
            const b = (s.buttons || [])[i];
            jobs.push(this.text('B' + (i + 1), b ? b.t : ' '));
            jobs.push(this.show('B' + (i + 1), !!b));
        }
        await Promise.all(jobs);
    }

    /** wire the button rows once; the handler of whatever the current screen has on that row runs */
    bind() {
        if (require('./kit/hmi').id7) return;      // iDrive 7: the screen is the renderer's; the HMI has no rows to drive
        for (let i = 0; i < BUTTONS; i++) {
            const c = this.comp('B' + (i + 1));
            if (!c) { this.log('WARN no component B' + (i + 1)); continue; }
            c.on('action', () => {
                const b = (this.cur.buttons || [])[i];
                if (b && b.f) Promise.resolve().then(b.f).catch((e) => this.log('BUTTON_FAILED B' + (i + 1) + ' ' + (e.stack || e)));
            });
        }
    }
}

module.exports = { Ui, LINES, BUTTONS };
