'use strict';
/**
 * OVERBOOST's menu and splash, in the kit's look (same fonts, theme, buttons as the apps).
 *   splash: the OVERBOOST logo in the middle of the screen.
 *   menu:   the logo stays at the left, the apps are the buttons at its right.
 */
const mgu = require('../../kit/mgu');
const G = require('../../kit/gauges');
const rec = require('../../kit/record');

const W = 1600, H = 520;
const brand = require('../../kit/brand');
const LOGO_ID = brand ? brand.id : 0;
const logo = brand;

function drawLogo(cv, t, x, y, w) {
    const h = logo ? Math.round(w * logo.h / logo.w) : 80;
    if (logo) cv.picture(LOGO_ID, x, y, w, h, 0);
    else cv.text('OVERBOOST', x + w / 2, y + 60, 64, t.text, { align: 'center', font: 'bold', spacing: 4 });
    return h;
}

mgu.run({
    async start(ctx) {
        const { ui, host } = ctx;
        const items = [
            ['M Vitals', 'VITALS'], ['Drag Timer', 'DRAG'], ['Fault Scanner', 'FAULTS'], ['Engine Config', 'ENGINE'],
        ];

        function render() {
            const t = ctx.theme(), st = host.status(), arg = ctx.arg || {};
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (arg.splash) {
                const lw = 900, lh = logo ? Math.round(lw * logo.h / logo.w) : 80;
                drawLogo(cv, t, (W - lw) / 2, (H + 38 - lh) / 2 - 10, lw);
                return ui.image('MAIN_GFX', cv);
            }
            // left: the logo, always here; right: the apps
            const lw = 560, ly = 190;
            const lh = drawLogo(cv, t, 40, ly, lw);
            cv.text(st.car || '', 40 + lw / 2, ly + lh + 52, 22, st.carLive ? t.text : t.dim, { align: 'center' });
            cv.text(st.diag || '', 40 + lw / 2, ly + lh + 82, 22, st.diagReady ? t.text : t.dim, { align: 'center' });
            cv.fillRect(660, 76, 2, 396, G.withAlpha('#ffffff', 0.14));
            const bx = 720, bw = 820, bh = 64, gap = 14;
            const list = items.concat([[st.update && st.update.newer ? 'Update  -  new ' + st.update.tag : 'Update', 'UPDATE']]);
            const y0 = 38 + Math.round((H - 38 - (list.length * bh + (list.length - 1) * gap)) / 2);
            list.forEach(([label, screen], i) => {
                G.button(cv, t, bx, y0 + i * (bh + gap), bw, bh, label, () => host.nav(screen), { key: 'menu:' + screen, primary: i === 0 });
            });
            return ui.image('MAIN_GFX', cv);
        }

        let last = '';
        // the menu changes with the car's state and the update check: draw when that text changes (and every second, for the renderer)
        ctx.loop('MAIN', 4, async () => {
            const st = host.status();
            last = JSON.stringify([st, ctx.arg]);
            await render();
        });
        ctx.onLayout(() => render());
    },
});
