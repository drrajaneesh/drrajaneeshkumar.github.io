#!/usr/bin/env python3
"""Regenerate index.html, sitemap.xml, robots.txt and .nojekyll from tools.json.

Usage (from the repo root):
  python .claude/skills/site-maintainer/scripts/build_index.py          # build
  python .claude/skills/site-maintainer/scripts/build_index.py --init   # create tools.json from existing pages
"""
import argparse
import datetime as dt
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path.cwd()
MANIFEST = ROOT / "tools.json"
GENERATED = {"index.html", "404.html"}
DEFAULT_SITE = {
    "title": "Clinical Tools - Dr. Rajaneesh Kumar",
    "author": "Dr. Rajaneesh Kumar, Internal Medicine",
    "base_url": "https://drrajaneesh.github.io/drrajaneeshkumar.github.io/",
}


def page_title(path):
    m = re.search(r"<title>(.*?)</title>", path.read_text(encoding="utf-8", errors="replace"), re.I | re.S)
    return html.unescape(m.group(1).strip()) if m else path.stem.replace("-", " ").title()


def page_description(path):
    m = re.search(r'<meta\s+name="description"\s+content="(.*?)"', path.read_text(encoding="utf-8", errors="replace"), re.I | re.S)
    return html.unescape(m.group(1).strip()) if m else ""


def init():
    if MANIFEST.exists():
        sys.exit("tools.json already exists; edit it instead of re-initialising.")
    today = dt.date.today().isoformat()
    tools = [
        {
            "file": p.name,
            "title": page_title(p),
            "category": "Uncategorised",
            "description": page_description(p),
            "audience": "clinician",
            "added": today,
            "updated": today,
            "status": "live",
        }
        for p in sorted(ROOT.glob("*.html"))
        if p.name not in GENERATED
    ]
    MANIFEST.write_text(json.dumps({"site": DEFAULT_SITE, "tools": tools}, indent=2) + "\n", encoding="utf-8")
    print(f"Created tools.json with {len(tools)} page(s). Fill in category and description, then build.")


CSS = """
:root{--bg:#f7f8fa;--card:#fff;--text:#1d2330;--muted:#5b6475;--line:#dde1e8;--accent:#0b6e8a;--badge:#e6f3f6}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--text:#e6e9ef;--muted:#9aa3b2;--line:#2c3340;--accent:#5cc3dc;--badge:#1f3640}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.6rem;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 20px}
input[type=search]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font-size:1rem}
h2{font-size:1rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:28px 0 8px}
ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}
li a{display:block;padding:14px 16px;background:var(--card);border:1px solid var(--line);border-radius:10px;color:inherit;text-decoration:none}
li a:hover,li a:focus{border-color:var(--accent);outline:none}
.t{font-weight:600;color:var(--accent)}
.d{color:var(--muted);font-size:.93rem;margin-top:2px}
.b{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:99px;background:var(--badge);font-size:.75rem;color:var(--text);vertical-align:middle}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}
[hidden]{display:none!important}
"""

JS = """
const q=document.getElementById('q');
q.addEventListener('input',()=>{const s=q.value.trim().toLowerCase();
document.querySelectorAll('section').forEach(sec=>{let any=false;
sec.querySelectorAll('li').forEach(li=>{const hit=!s||li.dataset.k.includes(s);li.hidden=!hit;any=any||hit});
sec.hidden=!any});});
"""


def build():
    if not MANIFEST.exists():
        sys.exit("tools.json not found. Run with --init first.")
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    site = {**DEFAULT_SITE, **data.get("site", {})}
    live = [t for t in data.get("tools", []) if t.get("status", "live") == "live"]
    live.sort(key=lambda t: (t.get("category", "Uncategorised").lower(), t["title"].lower()))

    groups = {}
    for t in live:
        groups.setdefault(t.get("category", "Uncategorised"), []).append(t)

    e = html.escape
    sections = []
    for cat, items in groups.items():
        lis = []
        for t in items:
            badge = '<span class="b">Patient</span>' if t.get("audience") == "patient" else ""
            key = e(f"{t['title']} {t.get('description', '')} {cat}".lower())
            lis.append(
                f'<li data-k="{key}"><a href="{e(t["file"])}"><div class="t">{e(t["title"])}{badge}</div>'
                f'<div class="d">{e(t.get("description", ""))}</div></a></li>'
            )
        sections.append(f"<section><h2>{e(cat)}</h2><ul>{''.join(lis)}</ul></section>")

    year = dt.date.today().year
    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(site['title'])}</title>
<meta name="description" content="Free clinical calculators and bedside tools by {e(site['author'])}.">
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
<h1>{e(site['title'])}</h1>
<p class="sub">{len(live)} tool{'s' if len(live) != 1 else ''} · {e(site['author'])}</p>
<input id="q" type="search" placeholder="Search tools" aria-label="Search tools">
{''.join(sections) or '<p>No tools published yet.</p>'}
<footer>For use by healthcare professionals. These tools support, and are not a substitute for clinical judgement.
No data entered is stored or transmitted. © {year} {e(site['author'])}.</footer>
</div>
<script>{JS}</script>
</body>
</html>
"""
    # Generated file; edit tools.json or this script, not index.html.
    (ROOT / "index.html").write_text(page, encoding="utf-8")

    base = site["base_url"].rstrip("/") + "/"
    urls = [("", max((t.get("updated", "") for t in live), default=""))] + [(t["file"], t.get("updated", "")) for t in live]
    entries = "".join(
        f"  <url><loc>{e(base + f)}</loc>" + (f"<lastmod>{e(d)}</lastmod>" if d else "") + "</url>\n" for f, d in urls
    )
    (ROOT / "sitemap.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{entries}</urlset>\n',
        encoding="utf-8",
    )
    (ROOT / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {base}sitemap.xml\n", encoding="utf-8")
    (ROOT / ".nojekyll").touch()
    print(f"Built index.html ({len(live)} live tool(s) in {len(groups)} categor{'y' if len(groups) == 1 else 'ies'}), sitemap.xml, robots.txt.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--init", action="store_true", help="create tools.json from existing pages")
    args = ap.parse_args()
    init() if args.init else build()
