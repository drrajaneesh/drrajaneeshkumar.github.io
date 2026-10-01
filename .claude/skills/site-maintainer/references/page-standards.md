# Page standards

Every live page meets these. `check_site.py` verifies the mechanical ones (marked ✓). The rest need judgment.

## Head
- ✓ `<!DOCTYPE html>` and `<html lang="en">`
- ✓ `<meta name="viewport" content="width=device-width, initial-scale=1">`, because the pages are used on phones at the bedside
- ✓ `<title>` naming the tool (`FIB-4 Calculator`)
- ✓ `<meta name="description" content="...">`, one sentence, used by search engines and link previews

## Body
- ✓ **Disclaimer**, visible on the page. The checker looks for the phrase `not a substitute for clinical judgement` (either spelling of judg(e)ment). Standard wording:
  > For use by healthcare professionals. This tool supports, and is not a substitute for clinical judgement. Verify results before acting on them. No data entered here is stored or transmitted.

  For `audience: patient` pages, use plain language instead: "This tool is for information only and is not a substitute for clinical judgement by your doctor."
- **Source citation** for every formula and cutoff: the primary paper, or the guideline with its year. Never invent a citation. If one can't be verified, say so on the page.
- ✓ **Home link**, a relative link to `index.html` (e.g. in the footer: `<a href="index.html">All tools</a>`).
- **Inputs validated.** Empty or impossible input shows a message, never `NaN` or `Infinity`. Show units next to every field. Offer mmol/L alongside mg/dL where the value is commonly reported both ways.
- **Synthetic values only** in placeholders and examples.

## Self-contained
- ✓ No external scripts or stylesheets except `cdnjs.cloudflare.com`, `cdn.jsdelivr.net` and `fonts.googleapis.com`/`fonts.gstatic.com`. Prefer none at all, because the page should still work when saved and opened offline.
- ✓ No root-relative links (`href="/..."`). They break on a project site.
- No analytics or tracking, and nothing entered is sent anywhere.

## Naming
- ✓ Lowercase kebab-case `.html` in the repo root.

## Redirect stub (for renamed or retired pages)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moved</title>
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=NEW-FILE.html">
<link rel="canonical" href="NEW-FILE.html">
</head>
<body><p>This tool has moved to <a href="NEW-FILE.html">NEW-FILE.html</a>.</p></body>
</html>
```

`check_site.py` recognises stubs by the `http-equiv="refresh"` tag and applies only the link checks to them.
