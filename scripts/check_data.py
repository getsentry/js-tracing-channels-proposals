#!/usr/bin/env python3
"""
Integrity check for data/libraries.json — the structured mirror of TRACKER.md
that powers the "Got diagnostics_channel?" site.

Because the JSON and TRACKER.md are maintained in parallel (see
skills/update-tracker), this guards against the two drifting:

  HARD checks (exit 1 — block CI):
    - JSON is valid and well-shaped (required fields, enums, unique packages).
    - meta.updated is a YYYY-MM-DD date.
    - shipped/merged libraries are COMPLETE: shipped => shippedVersion set;
      shipped|merged => at least one channel, each {name, type, desc}.
    - pr/issue (when present) have label + url.

  SOFT checks (warn — exit 0 unless --strict):
    - Every library in the JSON is mentioned somewhere in TRACKER.md
      (by package, an alias, or its display name). Catches renames/removals.

Run:  python3 scripts/check_data.py [--strict]
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "libraries.json"
TRACKER = ROOT / "TRACKER.md"

STATUSES = {
    "shipped", "merged", "pr-open", "discussion", "proposed",
    "not-started", "no-go", "skipped", "none",
}
GROUPS = {"otel", "sentry", "other", "logging"}
CHANNEL_TYPES = {"tracing", "diagnostics"}
REQUIRED = [
    "package", "name", "group", "category", "builtin", "downloadsPerMonth",
    "aliases", "status", "diagnostics_channel", "tracing_channel",
    "shippedVersion", "channels", "pr", "issue", "driver", "sentryLocation", "notes",
]

errors, warnings = [], []


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def check_link(obj, where):
    if obj is None:
        return
    if not isinstance(obj, dict) or "label" not in obj or "url" not in obj:
        err(f"{where}: pr/issue must be null or have 'label' and 'url'")


def main():
    strict = "--strict" in sys.argv

    try:
        data = json.loads(DATA.read_text())
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] {DATA} is not valid JSON: {e}")
        return 1

    meta = data.get("meta", {})
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(meta.get("updated", ""))):
        err("meta.updated must be a YYYY-MM-DD date")

    libs = data.get("libraries")
    if not isinstance(libs, list) or not libs:
        print("[FAIL] 'libraries' must be a non-empty array")
        return 1

    seen = set()
    for lib in libs:
        pkg = lib.get("package", "<missing package>")
        for key in REQUIRED:
            if key not in lib:
                err(f"{pkg}: missing required field '{key}'")

        if pkg in seen:
            err(f"duplicate package '{pkg}'")
        seen.add(pkg)

        if lib.get("group") not in GROUPS:
            err(f"{pkg}: group '{lib.get('group')}' not in {sorted(GROUPS)}")
        for f in ("status", "diagnostics_channel", "tracing_channel"):
            if lib.get(f) not in STATUSES:
                err(f"{pkg}: {f} '{lib.get(f)}' not in {sorted(STATUSES)}")

        check_link(lib.get("pr"), pkg)
        check_link(lib.get("issue"), pkg)

        chans = lib.get("channels", [])
        for c in chans:
            if not isinstance(c, dict) or set(("name", "type", "desc")) - c.keys():
                err(f"{pkg}: every channel needs {{name, type, desc}} (got {c!r})")
            elif c["type"] not in CHANNEL_TYPES:
                err(f"{pkg}: channel '{c['name']}' type must be one of {sorted(CHANNEL_TYPES)}")

        status = lib.get("status")
        # Completeness gate: a shipped/merged library must carry its channels,
        # so the tracker and the card never claim "yes" with nothing to show.
        if status in ("shipped", "merged") and not chans:
            err(f"{pkg}: status '{status}' but no channels listed "
                f"(pull them from the merged PR — see skills/update-tracker)")
        if status == "shipped" and not lib.get("shippedVersion"):
            err(f"{pkg}: status 'shipped' but shippedVersion is empty")

    # SOFT: each library should be findable in TRACKER.md.
    if TRACKER.exists():
        tracker = TRACKER.read_text().lower()
        for lib in libs:
            names = [lib.get("package", ""), lib.get("name", ""), *lib.get("aliases", [])]
            if not any(n and n.lower() in tracker for n in names):
                warn(f"{lib.get('package')}: not found in TRACKER.md "
                     f"(rename or removal? keep the two in sync)")
    else:
        warn("TRACKER.md not found — skipped cross-reference")

    for w in warnings:
        print(f"[warn] {w}")
    for e in errors:
        print(f"[FAIL] {e}")

    n = len(libs)
    shipped = sum(1 for l in libs if l["status"] in ("shipped", "merged"))
    chans = sum(len(l.get("channels", [])) for l in libs)
    print(f"\n{n} libraries · {shipped} shipped/merged · {chans} channels · "
          f"{len(errors)} error(s) · {len(warnings)} warning(s)")

    if errors or (strict and warnings):
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
