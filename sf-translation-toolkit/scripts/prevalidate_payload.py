#!/usr/bin/env python3
"""Strip references the TARGET org cannot resolve from a translation payload.

Salesforce caps the errors it enumerates per component and fails a component whole for one
bad reference, so dry-run -> strip -> dry-run converges slowly and hides the true count.
This checks every reference against the org in one pass.

  # see what would go (default — writes nothing)
  python prevalidate_payload.py work/<run>/out -o "<org alias>"

  # actually strip it
  python prevalidate_payload.py work/<run>/out -o "<org alias>" --apply

Point it at the payload folder that holds objectTranslations/ — NOT at force-app.

Safety: "absent" is only ever concluded from the org saying so. Any failed call (expired
login, wrong alias, network) stops the run before anything is changed; Account must
describe with fields; a query that returns nothing for a type the payload uses is treated
as a failure; and --apply refuses to remove more than half of anything without --force.
Run it as a user whose language is English: describe returns picklist labels in the
running user's language, and the payload is keyed by the English labels.
"""
import argparse
import collections
import json
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

NS = 'http://soap.sforce.com/2006/04/metadata'
Q = '{%s}' % NS

sys.path.insert(0, str(Path(__file__).resolve().parent))
from toolkit_settings import sf_executable  # noqa: E402
ET.register_namespace('', NS)

_cache: dict = {}
ABSENT_ERRORS = {'NOT_FOUND', 'INVALID_TYPE'}


def _fail(what: str, detail: str) -> None:
    sys.exit(f'error: {what} failed: {detail}\nNothing was changed. Check the org alias and '
             'that you are logged in (sf org display -o "<alias>"), then run again.')


def sfjson(args: list[str], allow_absent: bool = False):
    """Run an sf command with --json. Returns the parsed result, None when the org reports
    the item does not exist (allow_absent), and stops the run on any other failure."""
    p = subprocess.run([sf_executable()] + args + ['--json'], capture_output=True,
                       text=True, encoding='utf-8', errors='replace')
    what = 'sf ' + ' '.join(a for a in args[:3])
    try:
        data = json.loads(p.stdout)
    except ValueError:
        _fail(what, f'no readable output (exit {p.returncode}) {p.stderr.strip()[-300:]}')
    if p.returncode == 0 and data.get('status') == 0:
        return data.get('result')
    if allow_absent and data.get('name') in ABSENT_ERRORS:
        return None
    _fail(what, f"{data.get('name')}: {data.get('message')}")


def query(org: str, soql: str, tooling: bool = False) -> list[dict]:
    args = ['data', 'query'] + (['--use-tooling-api'] if tooling else []) + ['-q', soql, '-o', org]
    res = sfjson(args) or {}
    recs = res.get('records') or []
    if res.get('done') is False or (res.get('totalSize') or 0) > len(recs):
        _fail(f'query "{soql}"', f"returned {len(recs)} of {res.get('totalSize')} rows "
              "(truncated; raise the CLI's org-max-query-limit)")
    return recs


def running_user_language(org: str) -> str:
    p = subprocess.run([sf_executable(), 'api', 'request', 'rest', '/services/oauth2/userinfo',
                        '-o', org], capture_output=True, text=True, encoding='utf-8',
                       errors='replace')
    try:
        data = json.loads(p.stdout)
    except ValueError:
        _fail('reading the running user', f'no readable output (exit {p.returncode})')
    if p.returncode != 0 or not isinstance(data, dict):
        _fail('reading the running user', str(data)[:300])
    return data.get('language') or ''


def describe(org: str, obj: str) -> dict:
    k = ('d', obj)
    if k not in _cache:
        _cache[k] = sfjson(['sobject', 'describe', '-s', obj, '-o', org], allow_absent=True) or {}
    return _cache[k]


def field_map(org: str, obj: str) -> dict:
    k = ('f', obj)
    if k not in _cache:
        _cache[k] = {f['name']: f for f in (describe(org, obj).get('fields') or [])}
    return _cache[k]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('payload', type=Path, help='payload dir containing objectTranslations/')
    ap.add_argument('-o', '--target-org', required=True, help='org alias (quote it)')
    ap.add_argument('--apply', action='store_true',
                    help='actually remove the unresolvable references (default: report only)')
    ap.add_argument('--force', action='store_true',
                    help='allow --apply to remove more than half of a category')
    a = ap.parse_args()

    root, org = a.payload, a.target_org
    ot = root / 'objectTranslations'
    if not ot.is_dir():
        sys.exit(f'error: {ot} not found — point at the payload dir, not its parent')
    # A payload is disposable; force-app is not. Refuse to strip the source of truth.
    if 'force-app' in root.resolve().parts and a.apply:
        sys.exit('error: refusing to --apply inside force-app; copy the payload out first')

    lang = running_user_language(org)
    if not lang.startswith('en'):
        sys.exit(f'error: the user logged in to {org} has language {lang or "unknown"}. '
                 'Describe returns picklist labels in that language, so English picklist '
                 'values would all look missing. Log in as a user whose language is English.')

    # Positive control: an object every org has must come back with fields.
    if not describe(org, 'Account').get('fields'):
        _fail('describe Account', 'returned no fields')

    objs = sorted({d.name.rsplit('-', 1)[0] for d in ot.iterdir() if d.is_dir()})
    print(f'{len(objs)} objects in payload; describing each in {org} ...', file=sys.stderr)
    missing_obj = {o for o in objs if not describe(org, o).get('fields')}

    RT = {(r['SobjectType'], r['DeveloperName'])
          for r in query(org, 'SELECT DeveloperName, SobjectType FROM RecordType')}
    VR = {((r.get('EntityDefinition') or {}).get('QualifiedApiName'), r.get('ValidationName'))
          for r in query(org, 'SELECT ValidationName, EntityDefinition.QualifiedApiName '
                              'FROM ValidationRule', tooling=True)}
    CL = {r['Name'] for r in query(org, 'SELECT Name FROM ExternalString', tooling=True)}
    print(f'  org has {len(RT)} record types, {len(VR)} validation rules, '
          f'{len(CL)} custom labels', file=sys.stderr)

    def scan(apply: bool):
        stats: collections.Counter = collections.Counter()
        checked: collections.Counter = collections.Counter()
        detail: collections.Counter = collections.Counter()

        def save(root_el, path):
            if apply:
                ET.indent(root_el, space='    ')
                ET.ElementTree(root_el).write(path, encoding='UTF-8', xml_declaration=True)

        for d in sorted(ot.iterdir()):
            if not d.is_dir():
                continue
            obj = d.name.rsplit('-', 1)[0]
            checked['components'] += 1
            if obj in missing_obj:
                if apply:
                    shutil.rmtree(d)
                stats['component dropped (object absent)'] += 1
                checked['components dropped'] += 1
                detail[f'object: {obj}'] += 1
                continue
            fm = field_map(org, obj)

            for ff in sorted(d.glob('*.fieldTranslation-meta.xml')):
                fld = ff.name.split('.')[0]
                checked['field files'] += 1
                info = fm.get(fld)
                if info is None:
                    # A renamed standard field is not in describe under this name; only a
                    # missing __c field is genuinely absent.
                    if fld.endswith('__c'):
                        if apply:
                            ff.unlink()
                        stats['field file dropped (field absent)'] += 1
                        checked['field files dropped'] += 1
                        detail[f'field: {obj}.{fld}'] += 1
                    continue
                pv = info.get('picklistValues') or []
                if not pv:
                    continue
                ok = {v.get('label') for v in pv} | {v.get('value') for v in pv}
                r = ET.parse(ff).getroot()
                values = r.findall(Q + 'picklistValues')
                checked['picklist values'] += len(values)
                drop = [e for e in values
                        if (e.findtext(Q + 'masterLabel') or '').strip() not in ok]
                if not drop:
                    continue
                for e in drop:
                    r.remove(e)
                    detail[f'picklist: {obj}.{fld}'] += 1
                stats['picklist values dropped'] += len(drop)
                checked['picklist values dropped'] += len(drop)
                if not r.findall(Q + 'picklistValues') and not r.findtext(Q + 'label'):
                    if apply:
                        ff.unlink()
                    stats['field file dropped (empty after strip)'] += 1
                else:
                    save(r, ff)

            c = d / f'{d.name}.objectTranslation-meta.xml'
            if not c.is_file():
                continue
            r = ET.parse(c).getroot()
            changed = False
            for tag, known, label in (('recordTypes', RT, 'recordType'),
                                      ('validationRules', VR, 'validationRule')):
                for e in list(r.findall(Q + tag)):
                    checked[f'{label}s'] += 1
                    nm = (e.findtext(Q + 'name') or '').strip()
                    if (obj, nm) not in known:
                        r.remove(e)
                        changed = True
                        stats[f'{label} dropped'] += 1
                        checked[f'{label}s dropped'] += 1
                        detail[f'{label}: {obj}.{nm}'] += 1
            if changed:
                save(r, c)

        for p in sorted((root / 'translations').glob('*.xml')):
            r = ET.parse(p).getroot()
            changed = False
            for e in list(r.findall(Q + 'customLabels')):
                checked['customLabels'] += 1
                nm = (e.findtext(Q + 'name') or '').strip()
                if nm not in CL:
                    r.remove(e)
                    changed = True
                    stats['customLabel dropped'] += 1
                    checked['customLabels dropped'] += 1
                    detail[f'customLabel: {nm}'] += 1
            if changed:
                save(r, p)
        return stats, checked, detail

    stats, checked, detail = scan(apply=False)

    # A type the payload uses but the org returned none of means the read failed.
    for kind, have in (('recordTypes', RT), ('validationRules', VR), ('customLabels', CL)):
        if checked[kind] and not have:
            _fail(f'reading {kind} from the org', f'the payload has {checked[kind]} but the org '
                  'returned none')

    # Removing most of a category is far more likely a bad read than a real gap.
    heavy = [k for k in ('components', 'field files', 'picklist values', 'recordTypes',
                         'validationRules', 'customLabels')
             if checked[k] >= 10 and checked[f'{k} dropped'] * 2 > checked[k]]

    if a.apply:
        if heavy and not a.force:
            sys.exit('error: refusing --apply: it would remove more than half of: '
                     + ', '.join(f"{k} ({checked[k + ' dropped']}/{checked[k]})" for k in heavy)
                     + '. That usually means a bad read, not a real gap. Check the report, '
                     'then pass --force only if it is right.')
        stats, checked, detail = scan(apply=True)

    verb = 'DROPPED' if a.apply else 'WOULD DROP (report only — pass --apply)'
    print(f'\n{verb}:')
    for k, v in stats.most_common():
        print(f'   {k:<42}{v:>7}')
    print(f'\ndistinct targets: {len(detail)}')
    for k, v in detail.most_common(30):
        print(f'   {v:>5}  {k}')
    if len(detail) > 30:
        print(f'   ... and {len(detail) - 30} more')
    if heavy and not a.apply:
        print('\nWARNING: more than half of ' + ', '.join(heavy) + ' would go. Check the '
              'report before using --apply.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
