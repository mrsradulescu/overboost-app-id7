#!/usr/bin/env python3
"""store_tree.py - writes apps/overboost/, the SOURCE PACKAGE the Store builds on the head unit (mgu-store docs/PUBLISHING.md, "Repo tree").

    python3 tools/store_tree.py            # rewrite apps/overboost/ from overboost-src/
    python3 tools/store_tree.py --check    # build into a temporary folder and compare; exit 1 when apps/overboost/ is out of date

What it does:
  1. the idrive7-apps kit (overboost-src/idrive7-apps, MIT) builds the iDrive 7 tree (rhmiData, manifest.json, permissions.json, config);
  2. the app code (overboost-src/overboost/src) is flattened into modules src/<name>.js, requires rewritten to './<name>.js'
     (the head unit's deploy tool links them against the oap-sdk of a stock BMW app on the unit, its "donor");
     loading from disk (fonts, app.json, flavor.json, JSON) is replaced by static modules; the update/loader code is removed;
  3. apps/overboost/ gets mgu-app.json, src/ and package/ (the staged tree).
No BMW SDK file is in this repository. iDrive 7 only. The fault-text database overboost-src/overboost/src/dtc_db.pack goes into the package.
Raise "version" in overboost-src/overboost/app/version.json for every release, run this and commit apps/overboost/ with the rest.
Needs Python 3.
"""
import argparse, collections, io, json, os, re, shutil, subprocess, sys, tarfile, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'overboost-src')
OUT = os.path.join(ROOT, 'apps', 'overboost')
CODE = os.path.join(SRC, 'overboost', 'src')

ALIAS = {'pack.js': 'kit/pack.js', 'diag.js': 'kit/diag.js', 'known_texts.js': 'apps/dtc_scanner/known_texts.js'}
DROP = {'update.js', 'loader.js', 'apps/update/main.js'}
BUILTIN = {'fs', 'path', 'zlib', 'events', 'net', 'os', 'crypto', 'child_process', 'dgram', 'http', 'https', 'url', 'util', 'module'}
STATIC_JSON = ['kit/locale.json', 'kit/fonts/light.json', 'kit/fonts/gear.json', 'kit/fonts/bold.json',
               'kit/fonts/label.json', 'kit/fonts/num.json']
APP_IDS = ['menu', 'car_vitals', 'draggy', 'dtc_scanner', 'engine']


def flat(rel):
    rel = ALIAS.get(rel, rel)
    if rel == 'main.js':
        return 'ob_main.js'
    base = 'kit_' + rel[4:] if rel.startswith('kit/') else 'app_' + rel[5:] if rel.startswith('apps/') else 'ob_' + rel
    if rel.endswith('.json'):
        return base.replace('/', '_').replace('.', '_') + '.js'
    return base.replace('/', '_')


def resolve(frm, name):
    d = os.path.dirname(frm)
    p = os.path.normpath(os.path.join(d, name)).replace('\\', '/')
    for c in (p, p + '.js', p + '.json', p + '/index.js'):
        if os.path.isfile(os.path.join(CODE, c)):
            return c
    return None


def patch(text, old, new, what):
    if text.count(old) != 1:
        raise SystemExit('patch "%s": expected exactly 1 match, found %d' % (what, text.count(old)))
    return text.replace(old, new)


PATCHES = {
    'main.js': [
        ("const { OnlineApp } = require('oap-sdk');", "const OnlineApp = (function (m) { return m.OnlineApp || m; })(require('oap-sdk/src/core/OnlineApp.js'));", 'sdk'),
        ("require('./update').create(L)", "require('./ob_update.js').create(L)", 'update stub'),
        (", UPDATE: 'update' };", " };", 'no update app'),
        ("require('./kit/hmi')", "require('./kit/hmi')", 'noop'),
    ],
    'host8.js': [
        ("        const dir = path.join(__dirname, 'apps', id);\n        const spec = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));",
         "        const reg = require('./ob_apps.js')[id];\n        if (!reg) throw new Error('no app ' + id);\n        const spec = JSON.parse(JSON.stringify(reg.spec));", 'registry'),
        ("        require(path.join(dir, 'main.js'));", "        reg.load();", 'load'),
        ("{ label: 'Engine Config', screen: 'ENGINE' }].concat(require('./kit/hmi').id7 ? [] : [{ label: 'Update', screen: 'UPDATE' }]),",
         "{ label: 'Engine Config', screen: 'ENGINE' }],", 'chips'),
    ],
    'signals.js': [
        ("try { someip = require('someip'); }", "try { someip = require(['some', 'ip'].join('')); }", 'someip (native, resolved by the unit)'),
    ],
    'faults.js': [
        ("path.join(process.env.OVERBOOST_SRC || __dirname, 'dtc_db')", "path.join(__dirname, 'dtc_db')", 'db path'),
        ("OWN = require(path.join(process.env.OVERBOOST_SRC || __dirname, 'known_texts'));", "OWN = require('./known_texts');", 'own texts'),
    ],
    'apps/dtc_scanner/main.js': [
        ("path.join(process.env.OVERBOOST_SRC || path.join(__dirname, '..', '..'), 'dtc_db')", "path.join(__dirname, 'dtc_db')", 'db path'),
        ("Object.assign({}, req('./known_texts'), req('./dtc_texts'))", "Object.assign({}, require('./known_texts'))", 'own texts'),
    ],
    'apps/dtc_scanner/diagnostic-text.js': [
        ("language === 'zh-CN' ? require('../../kit/pack').open(path.join(__dirname, 'diagnostic_i18n')) : null", "null", 'no zh db'),
    ],
    'kit/brand.js': [
        ("path.join(process.env.OVERBOOST_SRC || path.join(__dirname, '..'), 'logo.rgba')", "path.join(__dirname, 'logo.rgba')", 'logo path'),
    ],
    'kit/fonts.js': [
        ("const j = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));", "const j = require('./kit_fonts_data.js')[name]();", 'fonts'),
    ],
}

GENERATED = {'./ob_update.js', './ob_apps.js', './kit_fonts_data.js'}
GEN_HMI = "'use strict';\nmodule.exports = { id: 'ID7', id7: true, id8: false };\n"
GEN_UPDATE = """'use strict';
/* the iDrive 7 build has no updater: the car has no internet; updates are installed with mgu-deploy */
const VERSION = %s;
exports.create = () => ({
    base: { version: VERSION, base: 3 }, st: { found: null, msg: '', busy: false },
    cur: () => null, check: () => Promise.resolve(), install: () => Promise.resolve(), remove: () => {},
});
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true', help='compare with apps/overboost/ instead of writing it')
    args = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix='overboost-build-') as tmp:
        # ---- 1. the tree, from the idrive7-apps kit
        kit = os.path.join(tmp, 'idrive7-apps')
        shutil.copytree(os.path.join(SRC, 'idrive7-apps'), kit)
        os.makedirs(os.path.join(kit, 'apps'), exist_ok=True)
        subprocess.check_call([sys.executable, os.path.join(SRC, 'overboost', 'tools', 'make_id7.py'), kit], cwd=tmp)
        sdk = os.path.join(kit, 'oap-sdk'); os.makedirs(sdk, exist_ok=True)
        open(os.path.join(sdk, 'index.js'), 'w').write('module.exports = {};\n')
        open(os.path.join(sdk, 'package.json'), 'w').write(json.dumps({'name': 'oap-sdk', 'version': '24.10.2', 'main': 'index.js'}))
        subprocess.check_call([sys.executable, os.path.join(kit, 'kit', 'tools', 'build.py'), 'overboost'], cwd=kit)
        built = [f for f in os.listdir(os.path.join(kit, 'dist')) if f.startswith('overboost@') and f.endswith('.tgz')]
        if len(built) != 1:
            raise SystemExit('expected one overboost tgz, found %r' % built)
        ext = os.path.join(tmp, 'old'); os.makedirs(ext)
        with tarfile.open(os.path.join(kit, 'dist', built[0])) as t:
            try:
                t.extractall(ext, filter='data')
            except TypeError:
                t.extractall(ext)
        pk = os.path.join(ext, 'package')
        pkg = json.load(open(os.path.join(pk, 'package.json')))
        ver = pkg['version']; ident = pkg['name']
        tree_name = 'package'
        app = os.path.join(tmp, 'app'); tree = os.path.join(app, tree_name)
        os.makedirs(os.path.join(app, 'src')); os.makedirs(os.path.join(tree, 'javascript'))
        for item in ('config', 'rhmiData', 'manifest.json', 'permissions.json', 'npm-shrinkwrap.json'):
            s = os.path.join(pk, item)
            if os.path.isdir(s): shutil.copytree(s, os.path.join(tree, item))
            elif os.path.exists(s): shutil.copy(s, os.path.join(tree, item))
        for data in ('dtc_db.pack', 'logo.rgba'):
            shutil.copy(os.path.join(CODE, data), os.path.join(tree, 'javascript', data))
        # the entry point as the Store's and Waze's apps have it ("private": null)
        ap_ = os.path.join(tree, 'rhmiData', 'application.json')
        appj = json.load(open(ap_, encoding='utf-8'))
        for ep in appj['application']['entryPoints']:
            ep['private'] = None
        json.dump(appj, open(ap_, 'w', encoding='utf-8'), indent=2); open(ap_, 'a').write('\n')
        # package.json as the Store's apps have it
        pkg['main'] = 'javascript/runner.js'
        pkg['files'] = ['config', 'rhmiData', 'package.json', 'npm-shrinkwrap.json', 'permissions.json', 'javascript', 'manifest.json']
        pkg['dependencies'] = {'oap-sdk': '24.10.2'}
        pkg['mguLocalOnly'] = True
        pkg['mguHmi'] = ['ID7']
        pkg['author'] = 'owner'
        json.dump(pkg, open(os.path.join(tree, 'package.json'), 'w'), indent=2); open(os.path.join(tree, 'package.json'), 'a').write('\n')

        # ---- 2. modules: reachable files from main.js and the app registry
        seen = collections.OrderedDict()
        rx = re.compile(r"require\('([^']+)'\)")
        queue = ['main.js', 'host8.js', 'signals.js', 'faults.js', 'engine.js', 'vitals.js', 'drag.js', 'ui.js', 'timer.js'] + \
                ['apps/%s/main.js' % a for a in APP_IDS] + ['apps/dtc_scanner/known_texts.js', 'kit/fonts.js', 'kit/brand.js']
        work = list(queue)
        while work:
            rel = work.pop(0)
            rel = ALIAS.get(rel, rel)
            if rel in seen or rel in DROP:
                continue
            text = open(os.path.join(CODE, rel), encoding='utf-8').read()
            for old, new, what in PATCHES.get(rel, []):
                text = patch(text, old, new, rel + ': ' + what)
            # comments that quote require('...') would be read by the linker as real requires
            text = '\n'.join(l.replace("require('", 'require("') if re.match(r'\s*(\*|//|/\*)', l) else l for l in text.split('\n'))
            seen[rel] = text
            # (requires inside text that a patch removed are no longer found)
            for name in rx.findall(text):
                if name.startswith('.') and name not in GENERATED:
                    tgt = resolve(rel, name)
                    if tgt is None:
                        raise SystemExit('%s requires %s: not found' % (rel, name))
                    if tgt.endswith('.json') or tgt in seen: continue
                    work.append(tgt)
        names = {}
        for rel in seen:
            n = flat(rel)
            if n in names.values(): raise SystemExit('name clash ' + n)
            names[rel] = n
        mods = []
        for rel, text in seen.items():
            def sub(m, rel=rel):
                name = m.group(1)
                if not name.startswith('.') or name in GENERATED:
                    return m.group(0)
                tgt = resolve(rel, name)
                if tgt.endswith('.json'):
                    return "require('./%s')" % flat(tgt)
                return "require('./%s')" % names[ALIAS.get(tgt, tgt)]
            out = rx.sub(sub, text)
            mods.append((names[rel], out))
        gen = {}
        gen['kit_hmi.js'] = GEN_HMI
        gen['ob_update.js'] = GEN_UPDATE % json.dumps(ver)
        for j in STATIC_JSON:
            gen[flat(j)] = 'module.exports = %s;\n' % open(os.path.join(CODE, j), encoding='utf-8').read().strip()
        fam = ['light', 'gear', 'bold', 'label', 'num']
        gen['kit_fonts_data.js'] = "'use strict';\nmodule.exports = {\n" + ''.join(
            "    %s: () => require('./%s'),\n" % (f, flat('kit/fonts/%s.json' % f)) for f in fam) + "};\n"
        reg = ["'use strict';", 'module.exports = {']
        for a in APP_IDS:
            spec = json.load(open(os.path.join(CODE, 'apps', a, 'app.json'), encoding='utf-8'))
            reg.append("    %s: { spec: %s, load: () => require('./%s') }," % (json.dumps(a), json.dumps(spec), names['apps/%s/main.js' % a]))
        reg.append('};\n')
        gen['ob_apps.js'] = '\n'.join(reg)
        # kit_hmi replaces the file based one
        mods = [(n, t) for n, t in mods if n != 'kit_hmi.js']
        for n, t in gen.items():
            mods.append((n, t))
        entry = 'ob_main.js'
        mods.sort(key=lambda e: (e[0] != entry, e[0]))
        for n, t in mods:
            open(os.path.join(app, 'src', n), 'w', encoding='utf-8').write(t)
        manifest = {'schema': 1, 'id': ident, 'version': ver, 'tree': tree_name,
                    'modules': ['src/' + n for n, _ in mods],
                    'sdk': ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging', 'oap-sdk/src/someip/someipBuilders']}
        json.dump(manifest, open(os.path.join(app, 'mgu-app.json'), 'w'), indent=1)
        # ---- 3. write apps/overboost
        if args.check:
            if not os.path.isdir(OUT) or not same(app, OUT):
                print('apps/overboost/ is out of date: run python3 tools/store_tree.py')
                sys.exit(1)
            print('OK: apps/overboost/ matches overboost-src/ (version %s)' % ver)
            return
        if os.path.isdir(OUT):
            shutil.rmtree(OUT)
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        shutil.copytree(app, OUT)
        print('apps/overboost/ written: version %s, %d modules' % (ver, len(mods)))


def same(a, b):
    import filecmp
    cmp = filecmp.dircmp(a, b)
    if cmp.left_only or cmp.right_only or cmp.funny_files:
        return False
    if filecmp.cmpfiles(a, b, cmp.common_files, shallow=False)[1:] != ([], []):
        return False
    return all(same(os.path.join(a, d), os.path.join(b, d)) for d in cmp.common_dirs)


if __name__ == '__main__':
    main()
