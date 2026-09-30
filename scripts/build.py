#!/usr/bin/env python3
"""
Build the zip that gets submitted to addons.mozilla.org.

The manifest has to be at the zip root, so the archive is built from the
*contents* of src/, not from the src/ directory itself. There is no build
step: what is in src/ is the extension, and this script only packs it --
after refusing to pack a manifest that names files that are not there.

    python3 scripts/build.py                # dist/scrollpeak-<version>.zip
    python3 scripts/build.py --out /tmp     # somewhere else
    python3 scripts/build.py --check        # verify, write nothing

The zip is deterministic: entries are sorted by name and stamped with a fixed
timestamp, so packing the same files twice produces byte-identical archives.
The sha256 printed at the end is therefore meaningful in a release note.

    python3 scripts/build.py && sha256sum dist/*.zip
"""
import hashlib
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "src")
MANIFEST = os.path.join(SRC, "manifest.json")

# Never ship these, even if they appear in src/. Nothing in the repository
# produces them today; this is here so a stray __pycache__ cannot reach a
# store listing. Matches are by directory name or exact file name.
SKIP_DIRS = {"__pycache__"}
SKIP_FILES = {".DS_Store"}

# A fixed timestamp makes the archive reproducible. 1980-01-01 is the
# earliest date the zip format can represent.
EPOCH = (1980, 1, 1, 0, 0, 0)


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def load_manifest():
    if not os.path.isfile(MANIFEST):
        fail(f"no manifest at {MANIFEST}")
    try:
        with open(MANIFEST, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as err:
        fail(f"manifest.json is not valid JSON: {err}")


def referenced_files(manifest):
    """Every file the manifest names, so we can prove none is missing."""
    refs = []
    refs += list(manifest.get("icons", {}).values())
    action = manifest.get("action", {})
    if action.get("default_popup"):
        refs.append(action["default_popup"])
    refs += list((action.get("default_icon") or {}).values())
    options = manifest.get("options_ui", {})
    if options.get("page"):
        refs.append(options["page"])
    refs += manifest.get("background", {}).get("scripts", [])
    for script in manifest.get("content_scripts", []):
        refs += script.get("js", [])
        refs += script.get("css", [])
    return refs


def verify(manifest):
    """Refuse to build a broken extension, and say exactly what is wrong."""
    problems = []

    if manifest.get("manifest_version") != 3:
        problems.append("manifest_version must be 3 for MV3 submission")

    for key in ("name", "version", "description"):
        if not manifest.get(key):
            problems.append(f"manifest.json has no {key!r}")

    gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
    if not gecko.get("id"):
        problems.append("browser_specific_settings.gecko.id is required "
                        "for AMO signing and updates")
    if not gecko.get("strict_min_version"):
        problems.append("gecko.strict_min_version is required: the README "
                        "documents why this extension cannot run on older "
                        "Firefox (MV3 host permissions need 127+, and the "
                        "vendored CSS uses @scope, which Firefox shipped in "
                        "146)")

    dcp = gecko.get("data_collection_permissions")
    if not isinstance(dcp, dict) or not isinstance(dcp.get("required"), list) \
            or not dcp.get("required"):
        problems.append(
            "gecko.data_collection_permissions with a non-empty 'required' "
            "list is required for new AMO submissions; use [\"none\"] when "
            "no data is collected "
            "(https://mzl.la/firefox-builtin-data-consent)")
    elif "none" in dcp["required"] and len(dcp["required"]) != 1:
        problems.append("data_collection_permissions: 'none' must be the "
                        "only entry in the required list")

    for ref in referenced_files(manifest):
        if ref.startswith("/") or ".." in ref.split("/"):
            problems.append(f"manifest references {ref!r}, outside src/")
        elif not os.path.isfile(os.path.join(SRC, ref)):
            problems.append(f"manifest references {ref!r}, which does not exist")

    if problems:
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        fail("manifest validation failed; nothing was written")


def collect():
    """Every file under src/, as (archive path, disk path), sorted."""
    entries = []
    for dirpath, dirnames, filenames in os.walk(SRC):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name in SKIP_FILES:
                continue
            disk = os.path.join(dirpath, name)
            archive = os.path.relpath(disk, SRC).replace(os.sep, "/")
            entries.append((archive, disk))
    return sorted(entries)


def build(entries, out):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for archive, disk in entries:
            info = zipfile.ZipInfo(archive, date_time=EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(disk, "rb") as f:
                zf.writestr(info, f.read())

    digest = hashlib.sha256()
    with open(out, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    args = sys.argv[1:]
    check_only = "--check" in args
    outdir = os.path.join(ROOT, "dist")
    if "--out" in args:
        outdir = args[args.index("--out") + 1]

    manifest = load_manifest()
    verify(manifest)
    entries = collect()

    total = sum(os.path.getsize(disk) for _, disk in entries)
    print(f"{manifest['name']} {manifest['version']}: "
          f"{len(entries)} files, {total / 1024:.1f} KiB uncompressed")
    if check_only:
        print("manifest is valid; --check, so nothing was written")
        return 0

    os.makedirs(outdir, exist_ok=True)
    out = os.path.join(outdir, f"scrollpeak-{manifest['version']}.zip")
    digest = build(entries, out)

    print()
    for archive, disk in entries:
        print(f"  {os.path.getsize(disk):>7}  {archive}")
    print()
    print(f"wrote {out}")
    print(f"sha256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
