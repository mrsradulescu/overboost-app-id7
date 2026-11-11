'use strict';
/**
 * faults.js - Fault Scanner (idrive7-apps "Fault Scanner"): reads the fault memory of every control unit
 * over the head unit's diagnostic transport (UDS 0x19 to all units), names the units and the codes, and
 * can clear them (UDS 0x14). Reading changes nothing; clearing is a separate, confirmed button.
 */
const fs = require('fs');
const path = require('path');
const { Diag, parseDtcReply, hex, NRC } = require('./diag');

const ECU = {
    0x01: 'ACSM airbag', 0x06: 'ICAM cameras', 0x07: 'SME HV battery', 0x08: 'SRR corner radar',
    0x0D: 'HKFM tailgate', 0x10: 'BDC gateway', 0x12: 'DME engine', 0x13: 'DME 2', 0x14: 'OBC charger',
    0x18: 'EGS gearbox', 0x1D: 'TFM fuel tank', 0x20: 'SRR corner radar', 0x21: 'FRR front radar',
    0x23: 'SAS assist sensors', 0x28: 'SRR corner radar', 0x29: 'DSC brakes', 0x2A: 'SRR corner radar',
    0x2C: 'USS park sensors', 0x30: 'EPS steering', 0x37: 'RAM audio', 0x38: 'VTG xDrive',
    0x39: 'DSC brake booster', 0x3A: 'EME e-motor', 0x40: 'BDC body', 0x43: 'FLM headlight',
    0x44: 'FLM headlight', 0x45: 'DCS driver camera', 0x56: 'FZD roof', 0x5D: 'KAFAS camera',
    0x5E: 'GWS gear selector', 0x60: 'KOMBI cluster', 0x61: 'ATM telematics', 0x63: 'Head unit',
    0x64: 'PDC parking', 0x67: 'ZBE controller', 0x6D: 'SM seat module', 0x76: 'VDP dampers',
    0x78: 'IHKA climate',
};
const RETRY_NRC = [0x22, 0x31, 0x33, 0x7E, 0x7F];
const ascii = (s) => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[^\x20-\x7e]/g, '');

function statusLabel(b) {
    if (b & 0x01) return 'ACTIVE';
    if (b & 0x80) return 'WARN LAMP';
    if (b & 0x04) return 'PENDING';
    if (b & 0x08) return 'STORED';
    return 'HISTORY';
}

function create(signals, dataDir, log) {
    let DB = null;
    try { DB = require('./pack').open(path.join(process.env.OVERBOOST_SRC || __dirname, 'dtc_db')); } catch (e) { log.warn('fault texts unavailable: ' + e); }
    let OWN = {};
    try { OWN = require(path.join(process.env.OVERBOOST_SRC || __dirname, 'known_texts')); } catch (e) { /* none */ }
    const IDS = path.join(dataDir, 'ecu_ids.json');
    let ids = {};
    try { ids = JSON.parse(fs.readFileSync(IDS, 'utf8')); } catch (e) { /* first run */ }
    const SGBD = DB ? DB.json('sgbd_index.json') : {};
    const UNIT_NAMES = DB ? DB.json('unit_names.json') : {};
    const hasDb = Object.keys(SGBD).length > 0;
    const variant = (a) => { const v = ids[hex(a)] ? SGBD[hex(a) + ' ' + ids[hex(a)]] : null; return v && /^[A-Za-z0-9_]+$/.test(v) ? v : null; };
    const ecuName = (a) => { const v = variant(a); return (v && UNIT_NAMES[v] && ascii(UNIT_NAMES[v])) || ECU[a] || v || ('ECU 0x' + hex(a)); };
    function describe(addr, rawCode) {
        const code = String(rawCode).trim().toUpperCase().padStart(6, '0');
        const key = hex(addr) + ':' + code;
        if (OWN[key]) return ascii(OWN[key]);
        if (!DB) return null;
        try {
            const v = variant(addr);
            const iv = (v && DB.get('tables/variant/' + v.toLowerCase() + '.json', code)) || DB.get('tables/addr/' + hex(addr) + '.json', code);
            if (iv) return ascii(iv);
            const t = (v && DB.get('texts/' + v + '.json', code)) || OWN['*:' + code] || DB.get('dtc_texts.json', key);
            if (t) return ascii(t);
            const c = DB.get('code_texts.json', code);
            const ct = (typeof c === 'string' ? c : c && c[hex(addr)]) || DB.get('tables/codes.json', code);
            return ct ? ascii(ct) : null;
        } catch (e) { return null; }
    }

    const st = { diag: null, busy: false, phase: 'idle', replies: 0, msg: '', scan: null, error: null, armed: null };
    const q = { unit: 0, codes: 0 };
    async function init(diag) {
        try { st.diag = diag || await new Diag(signals, log).init(); } catch (e) { st.error = String(e); }
        return st;
    }

    async function identify(addrs) {
        const todo = hasDb ? addrs.filter((a) => ids[hex(a)] === undefined) : [];
        let i = 0;
        for (const a of todo) {
            st.msg = 'Identifying control units ' + (++i) + '/' + todo.length;
            try {
                const r = await st.diag.physical(a, 0x22, [0xF1, 0x50], 3000,
                    (u) => (u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50) || (u[0] === 0x7F && u[1] === 0x22));
                if (!r) continue;
                ids[hex(a)] = r[0] === 0x62 && r.length >= 6 ? hex(((r[3] << 16) | (r[4] << 8) | r[5]) >>> 0, 6) : '';
            } catch (e) { log.warn('identify ' + hex(a) + ': ' + e); }
        }
        try { fs.writeFileSync(IDS, JSON.stringify(ids)); } catch (e) { /* ignore */ }
        st.msg = '';
    }

    async function scan() {
        if (st.busy) return;
        if (!st.diag || !st.diag.available) { st.msg = 'Diagnostic link not ready (ignition on?)'; return; }
        st.busy = true; st.phase = 'scanning'; st.replies = 0; st.msg = '';
        try {
            const byEcu = new Map();
            const params = [0x02, 0x0C];                 // fault memory, confirmed + test-failed
            const res = await st.diag.functional(0x19, params, { onReply: (e, n) => { st.replies = Math.max(st.replies, n); } });
            res.forEach((uds, addr) => {
                const p = parseDtcReply(uds, params);
                const e = byEcu.get(addr) || { addr, dtcs: [], nrc: null };
                p.dtcs.forEach((d) => e.dtcs.push({ code: d.code, status: d.status }));
                if (!p.ok) e.nrc = p.nrc;
                byEcu.set(addr, e);
            });
            st.scan = { at: Date.now(), ecus: Array.from(byEcu.values()) };
            await identify(st.scan.ecus.map((e) => e.addr));
            st.scan.ecus.sort((a, b) => b.dtcs.length - a.dtcs.length || a.addr - b.addr);
            const n = st.scan.ecus.reduce((s, e) => s + e.dtcs.length, 0);
            st.msg = !st.scan.ecus.length ? 'No control unit answered - ignition on?' : '';
            log.info('scan: ' + st.scan.ecus.length + ' units, ' + n + ' faults');
            st.phase = 'done';
        } catch (e) {
            log.warn('scan failed: ' + e);
            st.phase = 'error'; st.msg = 'Scan failed: ' + (e.message || e);
        }
        st.busy = false; q.unit = 0; q.codes = 0;
    }

    async function clearUnit(addr) {
        const ask = () => st.diag.physical(addr, 0x14, [0xFF, 0xFF, 0xFF], 8000, (u) => u[0] === 0x54 || (u[0] === 0x7F && u[1] === 0x14));
        const session = (n) => st.diag.physical(addr, 0x10, [n], 3000, (u) => (u[0] === 0x50 && u[1] === n) || (u[0] === 0x7F && u[1] === 0x10));
        let r = await ask();
        if (!r) r = await ask();
        if (r && r[0] === 0x7F && RETRY_NRC.indexOf(r[2]) >= 0) {
            const first = r;
            const ext = await session(0x03);
            if (ext && ext[0] === 0x50) { r = (await ask()) || first; await session(0x01); }
        }
        if (r && r[0] === 0x54) return { ok: true };
        return { ok: false, why: !r ? 'no answer' : r[0] === 0x7F ? (r[2] === 0x22 ? 'refused now (engine on? ignition only)' : NRC[r[2]] || 'NRC ' + hex(r[2])) : 'unexpected reply' };
    }

    async function clearAll() {
        if (st.busy) return;
        const targets = st.scan ? st.scan.ecus.filter((e) => e.dtcs.length) : [];
        if (!targets.length) { st.msg = st.scan ? 'Nothing to clear' : 'Scan first, then clear'; return; }
        st.busy = true; st.phase = 'clearing';
        let ok = 0; const failed = [];
        try {
            st.msg = 'Clearing all control units...';
            let all = new Map();
            try { all = await st.diag.functional(0x14, [0xFF, 0xFF, 0xFF], { idleMs: 5000 }); } catch (e) { log.warn('clear all: ' + e); }
            for (const e of targets) {
                const r = all.get(e.addr);
                if (r && r[0] === 0x54) { ok++; continue; }
                st.msg = 'Clearing ' + ecuName(e.addr) + '...';
                try { const res = await clearUnit(e.addr); if (res.ok) ok++; else failed.push(ecuName(e.addr) + ': ' + res.why); }
                catch (err) { failed.push(ecuName(e.addr) + ': ' + (err.message || err)); }
            }
            log.info('cleared ' + ok + '/' + targets.length + (failed.length ? ' - not: ' + failed.join('; ') : ''));
        } finally { st.busy = false; }
        await new Promise((r) => setTimeout(r, 1500));
        await scan();
        if (!st.msg) st.msg = failed.length ? 'Not cleared - ' + failed.join(';  ') : 'Cleared ' + ok + ' of ' + targets.length + ' units';
    }

    /** units that have at least one fault, for paging */
    const withFaults = () => (st.scan ? st.scan.ecus.filter((e) => e.dtcs.length) : []);
    return { st, q, init, scan, clearAll, ecuName, describe, statusLabel, withFaults };
}

module.exports = { create };
