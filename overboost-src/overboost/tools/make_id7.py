#!/usr/bin/env python3
"""make_id7.py - turns the OVERBOOST source (src/) into an app for the idrive7-apps kit (iDrive 7).

    python3 tools/make_id7.py <idrive7-apps folder>

Writes <idrive7-apps>/apps/overboost/ : app.json (the signals come from app/watch.json), icon.png and
tree/ (the whole src/ folder, plus flavor.json {"hmi": "ID7"}, which switches the app to the iDrive 7 layout).
kit/tools/build.py ("tree": true in app.json) copies tree/ into the app as it is.
Python standard library only."""
import json, os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    repo = os.path.abspath(sys.argv[1])
    if not os.path.isfile(os.path.join(repo, 'kit', 'tools', 'build.py')):
        sys.exit('not an idrive7-apps folder: ' + repo)
    ver = json.load(open(os.path.join(ROOT, 'app', 'version.json')))['version']
    watch = json.load(open(os.path.join(ROOT, 'app', 'watch.json')))
    signals = {}
    for iface, v in sorted(watch.items()):
        d = dict(v.get('attributes', {}))
        if v.get('instances', '1') != '1':
            d['_instances'] = v['instances']
        d['_optional'] = 'some of the live values'
        signals[iface] = d
    # the diagnostic gateway (UDS over SOME/IP): Fault Scanner and Engine Config need it
    signals['com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu'] = {
        '_instances': 'SystemFunctionsInternalTasuInst1', '_methods': ['sendTasuRequest'], '_broadcasts': ['sendTasuResponse']}
    spec = {
        'id': 'overboost', 'title': 'OVERBOOST', 'version': ver, 'vendor': 'custom', 'loggingId': 'OAB0',
        'description': 'M Vitals, Drag Timer, Fault Scanner and Engine Config in one app',
        'tree': True, 'signals': signals,
        'screens': [{'name': 'MAIN', 'kind': 'canvas', 'title': 'OVERBOOST', 'graphic': 'MAIN_GFX', 'buttons': []}],
    }
    out = os.path.join(repo, 'apps', 'overboost')
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    json.dump(spec, open(os.path.join(out, 'app.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    shutil.copy(os.path.join(ROOT, 'app', 'icon.png'), os.path.join(out, 'icon.png'))
    tree = os.path.join(out, 'tree')
    shutil.copytree(os.path.join(ROOT, 'src'), tree)
    shutil.copy(os.path.join(ROOT, 'app', 'version.json'), os.path.join(tree, 'version.json'))
    json.dump({'hmi': 'ID7'}, open(os.path.join(tree, 'flavor.json'), 'w', newline='\n'))
    print('apps/overboost written (version %s, %d signal interfaces)' % (ver, len(signals)))


if __name__ == '__main__':
    main()
