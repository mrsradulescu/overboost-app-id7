'use strict';
/**
 * vitals.js - live car values for the M Vitals pages (ported from the idrive7-apps "M Vitals" app:
 * same signals, same BMW scalings). Everything lands in `live`; the screens only read it.
 */
const SC = {
    rpm: { f: 0.25, o: 0, inv: 65535 },
    speed: { f: 0.015625, o: 0, inv: 65535 },
    accel: { f: 0.002, o: -65, inv: 65535 },
    ambient: { f: 0.5, o: -40, inv: 255 },
    engineTemp: { f: 1, o: -48, inv: 255 },
    gearboxTemp: { f: 1, o: -48, inv: 255 },
    boost: { f: 0.01, o: 0, inv: 255 },
    torque: { f: 0.5, o: -1023.5, inv: 65535, from: 4095 },
    tyreTemp: { f: 1, o: -40, inv: 65535 },
    split: { f: 0.01, o: 0, inv: 65535 },
    tyrePress: { f: 0.1, o: 0, from: 65532 },
};
function sc(k, raw) {
    const c = SC[k];
    if (!c || raw === undefined || raw === null || raw === c.inv || (c.from !== undefined && raw >= c.from)) return null;
    return raw * c.f + c.o;
}
const num = (x) => typeof x === 'number' && isFinite(x);

function start(signals, log, hooks) {
    const live = { at: {}, speed: null, subs: [] };
    const units = { press: null, temp: null, psiSeen: false };
    const PRESS_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI' }, TEMP_UNITS = { 1: 'C', 2: 'F' };
    const TO_BAR = { BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 };
    const put = (k, v) => { if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return; live[k] = v; live.at[k] = Date.now(); };
    const tyreP = (raw) => {
        const v = sc('tyrePress', raw);
        if (v === null) return null;
        const k = TO_BAR[units.press];
        if (k) return v * k;
        if (v >= 0.5 && v <= 6) return v;
        if (v >= 7 && v < 60) { units.psiSeen = true; return v / 14.5038; }
        if (v >= 60 && v <= 600) return v / 100;
        return v;
    };
    const tyreT = (raw) => {
        const v = sc('tyreTemp', raw), f = units.temp ? units.temp === 'F' : units.psiSeen;
        return v !== null && v > -40 && v < 300 && f ? (v - 32) * 5 / 9 : (v !== null && v > -40 && v < 150 ? v : null);
    };
    const four = (v, names, f, keys) => names.forEach((n, i) => put(keys[i], f(v && v[n])));
    const watches = [
        ['de.bmw.infotainment.vehicle.CDS', {
            statusEngineSpeed2: (v) => put('rpm', sc('rpm', v.actualValueRPMEngineCrankshaft)),
            statusEngineTemperature: (v) => {
                put('coolant', sc('engineTemp', v.temperatureEngineDrive));
                put('oil', sc('engineTemp', v.temperatureEngineOilDrive));
            },
        }],
        ['de.bmw.infotainment.vehicle.CDS2', {
            statusLongitudinalAccelerationMassCenter: (v) => { const a = sc('accel', v.longitudinalAccelerationCentreOfGravity); put('gLong', a === null ? null : a / 9.80665); },
            statusLateralAccelerationMassCenter: (v) => { const a = sc('accel', v.lateralAccelerationCentreOfGravity); put('gLat', a === null ? null : a / 9.80665); },
        }],
        ['de.bmw.infotainment.vehicle.Vehicle', {
            statusNewCurrentUnitsStatusExt: (v) => {
                units.press = PRESS_UNITS[v && v.unitOfMeasurementAirPressure] || null;
                units.temp = TEMP_UNITS[v && v.unitOfMeasurementTemperature] || null;
            },
        }],
        ['de.bmw.infotainment.vehicle.Vehicle2', {
            statusCarSpeed2: (v) => {
                const kmh = sc('speed', v.speedVehicleCentreOfGravity);
                if (kmh === null) return;
                put('speed', kmh);
                if (hooks && hooks.onSpeed) hooks.onSpeed(Date.now(), kmh);
            },
        }],
        ['de.bmw.infotainment.drivingexcitement.FES', {
            statusSwitchDriveDynamicSport2: (v) => put('boost', sc('boost', v.displayBoostPressure)),
            statusActualValueTorque2: (v) => { const t = sc('torque', v.actualValueTorqueCrankshaft); put('torque', t === null ? null : Math.max(0, t)); },
        }],
        ['de.bmw.infrastructure.analytics.BasicDataSet', {
            basicDataSet: (v) => {
                put('gearbox', sc('gearboxTemp', v.valueTemperatureTransmissionOil));
                const split = sc('split', v.valueDistributionLongitudinalTorqueRearAxisFrontAxis);
                if (num(split) && split > 0) put('splitRear', split);
            },
        }],
        ['de.bmw.infrastructure.EnvironmentalInformation', { ExteriorTemperature: (v) => put('ambient', sc('ambient', v.temperatureExterior)) }],
        ['de.bmw.infotainment.vehicle.TPMS', {
            statusTyreTemperature: (v) => four(v, ['actualValueTemperatureTyreFLH', 'actualValueTemperatureTyreFRH', 'actualValueTemperatureTyreRLH', 'actualValueTemperatureTyreRRH'], tyreT, ['tFL', 'tFR', 'tRL', 'tRR']),
            statusTyrePressure: (v) => four(v, ['actualValuePressureTyreFLH', 'actualValuePressureTyreFRH', 'actualValuePressureTyreRLH', 'actualValuePressureTyreRRH'], tyreP, ['pFL', 'pFR', 'pRL', 'pRR']),
        }],
    ];
    watches.forEach((w) => {
        signals.watch(w[0], '1', w[1], log, /\.TPMS$/.test(w[0]) ? { pollMs: 10000 } : undefined)
            .then((s) => { live.subs.push(s); log.info('signal ' + w[0].split('.').pop() + (s.error ? ' ERROR ' + s.error : ' ok')); })
            .catch((e) => log.warn('signal ' + w[0] + ': ' + e));
    });
    // the car sends nothing while parked: "present" = any provider has answered
    live.present = () => live.subs.some((s) => s.available) || Object.keys(live.at).length > 0;
    return live;
}

module.exports = { start, sc };
