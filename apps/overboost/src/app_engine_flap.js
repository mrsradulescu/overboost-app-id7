'use strict';
/**
 * flap.js - the DME's electric exhaust flap: which job a car has, and the bytes of each command.
 *
 *   plain      2F 60FD   position 22 64FD   (Bosch MG1 / DME8; idrive7-apps' Engine Config: open 10 %, close 90 %)
 *   regulated  2F 611E   position 22 651E   (a G80 S58 in IterioDev's car-apps issue #3: 22 64FD reads 00 00 and 2F 60FD is
 *                                            refused with 7F 2F 22; argument = % x 81.92, 10 % = 0333, 90 % = 1CCD)
 *   MHD        2F 02 nn  (00 back to the tune, 01 open, 02 closed), echoed 6F 02 nn; held while driving
 *
 * Which of the first two a car has is asked with a read only (22 651E first). BMW's jobs are diagnostic overrides: the DME
 * lets a tester's command go after ~20 s (or when the car moves), so Open / Close are sent again (engine.js, auto.js).
 */
const MHD = { open: [0x02, 0x01], close: [0x02, 0x02], oem: [0x02, 0x00] };
const KINDS = {
    regulated: { set: [0x61, 0x1E], read: [0x65, 0x1E],
        cmd: { open: [0x03, 0x03, 0x33], close: [0x03, 0x1C, 0xCD], oem: [0x00] },
        pct: (hi, lo) => Math.round(((hi << 8) | lo) / 81.92 * 10) / 10 },
    plain: { set: [0x60, 0xFD], read: [0x64, 0xFD],
        cmd: { open: [0x03, 0x03, 0xE8], close: [0x03, 0x23, 0x28], oem: [0x00] },
        pct: (hi, lo) => { const raw = (hi << 8) | lo; return (raw > 0x7FFF ? raw - 0x10000 : raw) / 100; } },
};
const TRANSIENT = [0x21, 0x22, 0x78];           // busy, conditions not correct, pending: ask again later
const key = (mode) => (mode === 'OPEN' ? 'open' : mode === 'CLOSED' ? 'close' : 'oem');

/** a read reply (bytes after the 0x7F / 0x62) that belongs to that kind's read */
const isRead = (kind, u) => !!u && ((u[0] === 0x62 && u[1] === KINDS[kind].read[0] && u[2] === KINDS[kind].read[1]) || (u[0] === 0x7F && u[1] === 0x22));

/**
 * a read reply -> { pct } (a position), { kind: 'plain' } (regulated asked and refused for good: use plain),
 * { none: true } (plain refused for good: no electric flap), or {} (nothing learned: no reply, busy)
 */
function onRead(kind, u) {
    if (!u) return {};
    if (u[0] === 0x62 && u.length >= 5) return { pct: KINDS[kind].pct(u[3], u[4]) };
    if (u[0] === 0x7F && TRANSIENT.indexOf(u[2]) < 0) return kind === 'regulated' ? { kind: 'plain' } : { none: true };
    return {};
}

/** the 2F request data for mode ('OPEN' | 'CLOSED' | 'OEM') */
const command = (kind, mode) => KINDS[kind].set.concat(KINDS[kind].cmd[key(mode)]);
const mhdCommand = (mode) => MHD[key(mode)];

/** MHD's reply to its flap request: 'held' (echoed), 'busy' (ask again), 'none' (no MHD flap control: use BMW's job) */
const onMhd = (mode, u) => {
    const m = MHD[key(mode)];
    return u && u[0] === 0x6F && u[1] === m[0] && u[2] === m[1] ? 'held'
        : !u || (u[0] === 0x7F && TRANSIENT.indexOf(u[2]) >= 0) ? 'busy' : 'none';
};

/** <= 20 % open, >= 80 % closed */
const state = (pct) => (pct === null || pct === undefined ? null : pct <= 20 ? 'OPEN' : pct >= 80 ? 'CLOSED' : pct + ' %');

module.exports = { KINDS, MHD, TRANSIENT, isRead, onRead, command, mhdCommand, onMhd, state };
