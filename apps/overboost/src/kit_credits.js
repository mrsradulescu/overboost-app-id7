'use strict';
// The translation credit in the corner: Chinese packages only. Its text is in their locale.json
// (build.py, from kit/localization/credit.zh-CN.json); other packages carry none.
const locale = require('./kit_locale_json.js');
const { getLanguage } = require('./kit_i18n.js');
const CREDIT = typeof locale.credit === 'string' ? locale.credit : '';
function drawCredit(canvas, x, baseline) {
    if (getLanguage() !== 'zh-CN' || !CREDIT) return;
    canvas.text(CREDIT, x, baseline, 12, '#ffffff40', { align: 'right', font: 'label' });
}
module.exports = { CREDIT, drawCredit };
