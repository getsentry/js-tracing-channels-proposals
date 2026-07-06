#!/usr/bin/env python3
"""
Ecosystem coverage model for the TracingChannel initiative.

Fair single-number methodology (see TRACKER.md > Ecosystem Coverage):
  - Denominator = whole ecosystem, ALL versions (weekly npm downloads).
  - Numerator   = only downloads on CHANNEL-CAPABLE versions (the release that
                  introduced the channel, and later). This is real adoption,
                  not "exists upstream" — it self-corrects for version lag.
  - Two numbers + diff:
      Number 1 = covered WITHOUT Sentry        (baseline the ecosystem reached on its own)
      Number 2 = covered WITH Sentry's merges
      DIFF     = Number 2 - Number 1           = Sentry's measurable effect today
  - Ceiling   = Sentry libs at FULL adoption (all installs on a capable version),
                i.e. the payoff still in flight as users upgrade.

Run:  python3 scripts/coverage.py            # prints the markdown block + numbers
      python3 scripts/coverage.py --write     # also rewrites the section in TRACKER.md

Maintenance: when a new channel merges, add the library to COVERED with the
version that introduced it and who drove it. When one is still tracked but has
no channel, leave it out of COVERED (it stays in the denominator via ECOSYSTEM).
Re-run monthly; download numbers drift.
"""
import json, sys, time, datetime, urllib.request, re

# --- Whole tracked ecosystem (denominator). npm package names; built-ins excluded. ---
ECOSYSTEM = [
    "express", "fastify", "koa", "@hapi/hapi", "connect", "pg", "mysql", "mysql2",
    "mongodb", "mongoose", "redis", "ioredis", "tedious", "knex", "prisma", "graphql",
    "kafkajs", "amqplib", "dataloader", "generic-pool", "lru-memoizer", "undici",
    "hono", "postgres", "firebase-admin", "openai", "@anthropic-ai/sdk", "@google/genai",
    "langchain", "@langchain/langgraph", "ai", "h3", "srvx", "unstorage", "db0",
    "nitropack", "nuxt", "elysia", "pino", "consola", "@tanstack/react-start",
]

# --- Libraries that have SHIPPED a channel. pkg -> (introducing_version, driver) ---
# driver: "sentry"  = a proposal authored in this repo that merged
#         "other"   = independent (undici/fastify/pino) or unjs/community (h3/srvx/unstorage/nitro)
# threshold is compared on (major,minor,patch) with prerelease stripped, so e.g.
# graphql 17.0.0-rc.0 counts as capable (>= 17.0.0).
COVERED = {
    "mysql2":    ("3.20.0", "sentry"),   # PR #4178, merged 2026-03-14, first stable 3.20.0
    "redis":     ("5.12.0", "sentry"),   # node-redis PR #3195, merged 2026-04-02
    "ioredis":   ("5.11.0", "sentry"),   # PR #2089, merged 2026-04-07
    "mongoose":  ("9.7.0",  "sentry"),   # PR #16275, released v9.7.0 2026-06-09
    "graphql":   ("17.0.0", "sentry"),   # PR #4670, shipped v17.0.0-rc.0 (pre-release)
    "ai":        ("7.0.0",  "sentry"),   # vercel/ai#15660, merged 2026-06-15, released stable v7.0.0 (2026-06-25)
    "undici":    ("4.7.0",  "other"),    # Node core diagnostics channels
    "fastify":   ("4.0.0",  "other"),    # tracing:fastify.request.handler, native since v4
    "pino":      ("9.10.0", "other"),    # PR #2281, v9.10.0
    "h3":        ("2.0.0",  "other"),    # h3#1251 (v2 line)
    "srvx":      ("0.0.0",  "other"),    # srvx#141 (new pkg; ~all current)
    "unstorage": ("1.16.0", "other"),    # unjs/unstorage#707
    "nitropack": ("2.12.0", "other"),    # nitrojs/nitro#4001
}

def _get(url, tries=5):
    for i in range(tries):
        try:
            return json.load(urllib.request.urlopen(url, timeout=40))
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None

def point_lastweek(pkg):
    d = _get(f"https://api.npmjs.org/downloads/point/last-week/{pkg}")
    time.sleep(0.4)
    return (d or {}).get("downloads", 0)

def _semkey(v):
    parts = v.split("-")[0].split("+")[0].split(".")
    n = []
    for p in parts[:3]:
        try: n.append(int(p))
        except ValueError: n.append(0)
    while len(n) < 3: n.append(0)
    return tuple(n)

def perversion_lastweek(pkg, threshold):
    d = _get(f"https://api.npmjs.org/versions/{pkg}/last-week")
    time.sleep(0.4)
    dl = (d or {}).get("downloads", {})
    total = sum(dl.values())
    tk = _semkey(threshold)
    capable = sum(val for k, val in dl.items() if _semkey(k) >= tk)
    return total, capable

def human(n):
    return f"{n/1e6:.1f}M"

def main():
    denom = sum(point_lastweek(p) for p in ECOSYSTEM)
    rows, sentry_cap, other_cap, sentry_total = [], 0, 0, 0
    for pkg, (thr, who) in COVERED.items():
        total, cap = perversion_lastweek(pkg, thr)
        pct = (cap / total * 100) if total else 0
        rows.append((pkg, thr, who, total, cap, pct))
        if who == "sentry":
            sentry_cap += cap; sentry_total += total
        else:
            other_cap += cap
    n1 = other_cap / denom * 100
    n2 = (other_cap + sentry_cap) / denom * 100
    ceiling = sentry_total / denom * 100
    today = datetime.date.today().isoformat()

    md = []
    md.append("<!-- COVERAGE:START (generated by scripts/coverage.py — do not edit by hand) -->")
    md.append(f"_Snapshot {today} · weekly npm downloads · denominator = whole tracked ecosystem, all versions ({human(denom)}/wk). Numerator counts only downloads on channel-capable versions (real adoption, not “exists upstream”)._")
    md.append("")
    md.append("| | Channel-capable / ecosystem | Coverage |")
    md.append("|---|---|---|")
    md.append(f"| **Without Sentry** (undici, fastify, pino, h3, srvx, unstorage, nitro) | {human(other_cap)} / {human(denom)} | **{n1:.1f}%** |")
    md.append(f"| **With Sentry** (+ mysql2, redis, ioredis, mongoose, graphql, ai) | {human(other_cap+sentry_cap)} / {human(denom)} | **{n2:.1f}%** |")
    md.append(f"| **Sentry's effect (adopted today)** | +{human(sentry_cap)} | **+{n2-n1:.1f} pts** |")
    md.append("")
    md.append(f"**Fair single statement:** Sentry has merged native tracing into libraries representing **~{ceiling:.0f}% of the ecosystem's weekly downloads** (the ceiling at full adoption); **~{n2-n1:.1f} point{'s' if round(n2-n1,1)!=1.0 else ''} is adopted in production today**, with the rest landing as users upgrade.")
    md.append("")
    md.append("Adoption lags merges — share of each Sentry library already on a channel-capable version:")
    md.append("")
    md.append("| Sentry library | introduced in | on capable version |")
    md.append("|---|---|---|")
    for pkg, thr, who, total, cap, pct in rows:
        if who == "sentry":
            md.append(f"| {pkg} | ≥{thr} | {pct:.0f}% |")
    md.append("<!-- COVERAGE:END -->")
    block = "\n".join(md)
    print(block)
    print("\n--- raw ---", file=sys.stderr)
    for pkg, thr, who, total, cap, pct in rows:
        print(f"{pkg:<20} {who:<7} >={thr:<8} total={total:>11,} cap={cap:>11,} {pct:>4.0f}%", file=sys.stderr)
    print(f"denom={denom:,}  N1={n1:.2f}%  N2={n2:.2f}%  diff=+{n2-n1:.2f}  ceiling={ceiling:.2f}%", file=sys.stderr)

    if "--write" in sys.argv:
        path = "TRACKER.md"
        with open(path) as f:
            doc = f.read()
        new = re.sub(r"<!-- COVERAGE:START.*?COVERAGE:END -->", block, doc, flags=re.S)
        if new == doc:
            print("\n[!] COVERAGE markers not found in TRACKER.md — section not written.", file=sys.stderr)
        else:
            with open(path, "w") as f:
                f.write(new)
            print(f"\n[ok] wrote coverage block into {path}", file=sys.stderr)

if __name__ == "__main__":
    main()
