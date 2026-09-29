# Леммы для ats.mjs. На входе JSON-массив строк, на выходе массив тех же строк,
# где каждое русское слово заменено нормальной формой. Латиница (Next.js, CI/CD) не трогается.
import json
import re
import sys

import pymorphy3

morph = pymorphy3.MorphAnalyzer()
cache = {}


def lemma(match):
    w = match.group(0).lower().replace("ё", "е")
    if w not in cache:
        cache[w] = morph.parse(w)[0].normal_form.replace("ё", "е")
    return cache[w]


data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
out = [re.sub(r"[А-Яа-яЁё]+", lemma, s) for s in data]
sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))
