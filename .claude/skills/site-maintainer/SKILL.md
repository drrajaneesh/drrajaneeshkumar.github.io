---
name: site-maintainer
description: Maintain Dr. Rajaneesh Kumar's public GitHub Pages site (repo drrajaneesh/drrajaneeshkumar.github.io), a collection of standalone clinical calculator and tool pages. Use for any change to the site itself - adding a new calculator or tool page, publishing one that was just built, renaming/retiring a page, regenerating the home page (index.html) and sitemap, fixing broken links, checking every page before a push, or "why isn't my page showing up". Trigger on casual phrasing too ("put the FIB-4 calculator on my site", "add this to the website", "update the homepage", "the site link is broken", "publish this tool", "tidy up the github pages repo"). Building the calculator's clinical logic stays with `clinical-calculator`; this skill owns everything that happens once a page is going onto the site.
---

# Site maintainer

The site is a public, static GitHub Pages site. Every page is a single self-contained HTML file in the repo root, and a clinician may open it on a ward phone or save it for offline use. The home page lists every tool. The goal of this skill: every change leaves the site consistent. That means every page is listed, every link works, every page carries the disclaimer, and the site holds no patient data.

## Things to know before touching anything

**It is a project site, not a user site.** GitHub serves a site at the root domain only when the repo is named exactly `<owner>.github.io`. This repo is `drrajaneesh/drrajaneeshkumar.github.io`, and the owner is `drrajaneesh`, so the names differ. That makes it a project site, served at `https://drrajaneesh.github.io/drrajaneeshkumar.github.io/` unless a custom domain is set up. Check this before stating a URL. Look for a `CNAME` file. If the user can reach Settings → Pages, the URL shown there is the authority. The practical consequence is that links must be **relative** (`fib4-calculator.html`, never `/fib4-calculator.html`). A leading-slash link resolves to the domain root and returns a 404.

**Paths are case-sensitive and permanent.** GitHub Pages treats `HOMA.html` and `homa.html` as different files. Colleagues bookmark and share URLs, so renaming a page breaks their links. Use lowercase kebab-case names (`chads-vasc-calculator.html`) from the start. When a rename is unavoidable, leave a redirect stub at the old path (see `references/page-standards.md`).

**The site is public and indexed.** Anything committed is published, and the git history keeps it after deletion. Never commit patient names, CPR/MRN numbers, lab exports, registers or screenshots, including as "example" values in a calculator. Use obviously synthetic numbers. If patient data was committed by mistake, stop and tell the user. Deleting the file does not remove it from history, and the fix needs a deliberate history rewrite that the user must authorise.

**Hospital branding on a personal site.** Pages built by `clinical-calculator` or `alhilal-branding` may carry Al Hilal Hospital identity. Putting a hospital's name and logo on a personal public site may need the hospital's permission. Keep the site's own chrome (home page, footer) under Dr. Kumar's name. Mention the branding question the first time a branded page goes up, and don't repeat it after that.

## The manifest: `tools.json`

`tools.json` in the repo root is the single source of truth for what the site lists. Both scripts read it. If it doesn't exist yet, create it by running `build_index.py --init`, which scans the existing pages. Shape:

```json
{
  "site": {
    "title": "Clinical Tools - Dr. Rajaneesh Kumar",
    "author": "Dr. Rajaneesh Kumar, Internal Medicine",
    "base_url": "https://drrajaneesh.github.io/drrajaneeshkumar.github.io/"
  },
  "tools": [
    {
      "file": "insulin-resistance-calculator.html",
      "title": "HOMA-IR (Insulin Resistance)",
      "category": "Endocrine & Metabolic",
      "description": "Homeostatic model assessment of insulin resistance from fasting insulin and glucose.",
      "audience": "clinician",
      "added": "2025-01-01",
      "updated": "2025-01-01",
      "status": "live"
    }
  ]
}
```

`status` is `live` (listed), `draft` (in repo, not listed) or `retired` (a redirect stub or removed page, not listed). `audience` is `clinician` or `patient`. The home page shows a badge for patient-facing tools.

## Workflows

### Add or publish a page

1. **Get the page.** If it doesn't exist yet, build it with `clinical-calculator`, then return here. If the user hands over a page, read the whole file before it goes onto a public site.
2. **Bring it to the page standards** in `references/page-standards.md`: viewport, `<title>`, meta description, disclaimer, source citation, footer link back to the home page, no external scripts outside the allowed CDNs, and synthetic example values only. Fix gaps in the page rather than listing them for the user.
3. **Name it** in lowercase kebab-case, ending in `-calculator.html`, `-score.html` or `-tool.html`, whichever fits.
4. **Add it to `tools.json`** with today's date for `added`/`updated`. Reuse an existing category where one fits so the home page doesn't split into one-item groups.
5. **Rebuild and check:**
   ```bash
   python .claude/skills/site-maintainer/scripts/build_index.py
   python .claude/skills/site-maintainer/scripts/check_site.py
   ```
   `build_index.py` regenerates `index.html`, `sitemap.xml`, `robots.txt` and `.nojekyll` from the manifest. Don't hand-edit `index.html`, because the next build overwrites it. Change the manifest or the script instead.
6. **Fix every error** `check_site.py` reports, and rerun until it exits 0. Warnings are judgment calls. Mention any you left in place.
7. **Commit and push** on the working branch with a message naming the tool (`Add FIB-4 calculator`). Say that GitHub Pages usually takes a minute or two to publish, and give the page's live URL.

### Update an existing page

Edit it in place. Keep the filename unless it's truly wrong. Bump `updated` in the manifest, then rebuild and check. If the change touches a formula or cutoff, verify it against the primary source the way `clinical-calculator` does, and update the citation on the page.

### Rename or retire a page

Rename: move the content to the new filename and replace the old file with a redirect stub (template in `references/page-standards.md`). Set the old entry to `retired` in the manifest and add a new `live` entry. Retire without a replacement: ask whether to keep a stub that points to the home page (the safer choice for shared links) or to delete the file. Then rebuild and check.

### Health check ("is the site OK", before any push)

Run `check_site.py` and report the result in one or two lines. Only when something fails, list what failed and fix it.

## Output

Reply briefly. Say what changed (files added or edited), give the check result, and give the live URL(s). Don't paste whole pages back. The diff is the record.
