#!/usr/bin/env python3
"""Check every page in the site against the page standards and the manifest.

Run from the repo root. Exits 1 if any ERROR is found; WARNs are judgment calls.
"""
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path.cwd()
ALLOWED_HOSTS = {"cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"}
SKIP_DIRS = {".git", ".claude", "node_modules"}
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*\.html$")
DISCLAIMER = re.compile(r"not\s+a\s+substitute\s+for\s+clinical\s+judge?ment", re.I)
# Heuristics for real patient identifiers left in a public page.
PHI = [
    (re.compile(r"\b(CPR|MRN|UHID|IP\s*No|File\s*No)\b\s*[:#]?\s*\d{5,}", re.I), "looks like a patient identifier"),
    (re.compile(r"\bpatient\s*name\s*[:=]\s*[A-Z][a-z]+", re.I), "looks like a patient name"),
]


class Scan(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.assets, self.meta, self.title, self._in_title = [], [], {}, "", False
        self.lang = None
        self.refresh = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "html":
            self.lang = a.get("lang")
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            if a.get("name"):
                self.meta[a["name"].lower()] = a.get("content", "")
            if (a.get("http-equiv") or "").lower() == "refresh":
                self.refresh = True
        elif tag == "a" and a.get("href"):
            self.links.append(a["href"])
        elif tag == "script" and a.get("src"):
            self.assets.append(a["src"])
        elif tag == "link" and a.get("href"):
            (self.assets if (a.get("rel") or "").lower() in ("stylesheet", "preload", "icon") else self.links).append(a["href"])
        elif tag in ("img", "iframe", "source") and a.get("src"):
            self.assets.append(a["src"])

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def main():
    errors, warns = [], []
    err = lambda f, m: errors.append(f"ERROR {f}: {m}")
    warn = lambda f, m: warns.append(f"WARN  {f}: {m}")

    pages = sorted(p for p in ROOT.rglob("*.html") if not SKIP_DIRS & set(p.relative_to(ROOT).parts))
    names = {p.relative_to(ROOT).as_posix() for p in pages}

    manifest = {}
    mpath = ROOT / "tools.json"
    if mpath.exists():
        try:
            manifest = {t["file"]: t for t in json.loads(mpath.read_text(encoding="utf-8")).get("tools", [])}
        except (json.JSONDecodeError, KeyError) as ex:
            err("tools.json", f"unreadable ({ex})")
    else:
        err("tools.json", "missing; run build_index.py --init")

    for f, t in manifest.items():
        if f not in names and t.get("status") != "retired":
            err("tools.json", f"lists {f} but the file does not exist")
        for k in ("title", "category", "description"):
            if t.get("status", "live") == "live" and not t.get(k):
                warn("tools.json", f"{f} has no {k}")

    if (ROOT / "index.html").exists() and mpath.exists() and mpath.stat().st_mtime > (ROOT / "index.html").stat().st_mtime + 1:
        warn("index.html", "older than tools.json; rerun build_index.py")
    if not (ROOT / ".nojekyll").exists():
        warn(".nojekyll", "missing; build_index.py creates it")

    for p in pages:
        rel = p.relative_to(ROOT).as_posix()
        src = p.read_text(encoding="utf-8", errors="replace")
        s = Scan()
        s.feed(src)

        for href in s.links + s.assets:
            u = urlparse(href)
            if u.scheme in ("http", "https"):
                continue
            if u.scheme in ("mailto", "tel", "data", "javascript") or href.startswith("#"):
                continue
            if href.startswith("/"):
                err(rel, f'root-relative link "{href}" breaks on a project site; make it relative')
                continue
            target = (p.parent / u.path).resolve()
            if u.path and not target.exists():
                err(rel, f'broken link "{href}" (paths are case-sensitive)')

        for a in s.assets:
            host = urlparse(a).hostname
            if host and host not in ALLOWED_HOSTS:
                err(rel, f"external asset from {host}; inline it or use an allowed CDN")

        if s.refresh or rel == "index.html":
            continue  # redirect stubs and the generated home page only get link checks

        if not KEBAB.match(p.name) or "/" in rel:
            warn(rel, "name is not lowercase kebab-case in the repo root")
        if not src.lstrip().lower().startswith("<!doctype html"):
            err(rel, "missing <!DOCTYPE html>")
        if not s.lang:
            err(rel, 'missing <html lang="en">')
        if "width=device-width" not in s.meta.get("viewport", ""):
            err(rel, "missing mobile viewport meta tag")
        if not s.title.strip():
            err(rel, "missing <title>")
        if not s.meta.get("description"):
            err(rel, "missing meta description")
        if not DISCLAIMER.search(re.sub(r"<[^>]+>", " ", src)):
            err(rel, 'no disclaimer ("not a substitute for clinical judgement")')
        if not any(urlparse(h).path in ("index.html", "./", "./index.html") for h in s.links):
            err(rel, "no link back to index.html")
        for rx, why in PHI:
            m = rx.search(src)
            if m:
                warn(rel, f'{why}: "{m.group(0)[:40]}"; confirm it is synthetic')
        if rel not in manifest and p.name != "404.html":
            err(rel, "not in tools.json (add it, status live or draft)")
        if p.stat().st_size > 2_000_000:
            warn(rel, f"{p.stat().st_size // 1024} KB; heavy for a ward phone")

    for line in errors + warns:
        print(line)
    print(f"\n{len(pages)} page(s) checked: {len(errors)} error(s), {len(warns)} warning(s).")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
