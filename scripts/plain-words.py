#!/usr/bin/env python3
# C21 plain language: fail when user-facing text uses an internal term bare (docs/glossary.md says which word to use instead).
# Reads HTML or plain text files. For HTML it checks what a person reads: visible text, plus the human sentences inside the
# page's own script (string literals with a space and a letter, i.e. what the Status card renders), but not code, CSS or JSON.
# usage: plain-words.py <file>...   (prints each hit, exits 1 if any)
import html, re, sys
BANNED = re.compile(r"\b((?i:peers?|grants?|presets?|spaces?|verbs?|scopes?|leases?|leased)|DO|DOs)\b|\*\*")  # DO = Durable Object, upper case only
# A banned word is fine as a literal command, flag or file path the reader types or sees on disk (<code>/<pre> blocks).
def texts(raw: str):
    if "<html" not in raw[:400].lower(): yield raw; return
    body = re.sub(r"<style.*?</style>|<script[^>]*application/json[^>]*>.*?</script>", " ", raw, flags=re.S | re.I)
    for js in re.findall(r"<script[^>]*>(.*?)</script>", body, flags=re.S | re.I):
        js = re.sub(r"(?m)//[^\n\"']*$", " ", js)  # code comments are for maintainers
        for q in re.findall(r'"((?:[^"\\\n]|\\.)*)"', js):
            if " " in q and re.search(r"[A-Za-z]{3}", q) and not re.search(r"[{};=]|=>", q): yield q
    body = re.sub(r"<script.*?</script>|<code>.*?</code>|<pre[^>]*>.*?</pre>", " ", body, flags=re.S | re.I)
    body = re.sub(r"<(input|textarea)[^>]*>", " ", body, flags=re.I)  # field values are data (e.g. ** write:shared/**)
    yield html.unescape(re.sub(r"<[^>]+>", " ", body))
bad = 0
for f in sys.argv[1:]:
    for t in texts(open(f, encoding="utf-8").read()):
        for m in BANNED.finditer(t):
            bad += 1; s = max(0, m.start() - 50); print(f"{f}: '{m.group(0)}' in: ...{' '.join(t[s:m.end() + 50].split())}...")
sys.exit(1 if bad else 0)
