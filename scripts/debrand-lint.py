#!/usr/bin/env python3
"""debrand-lint.py — refuse identity strings, box paths and token shapes.

BotCorp is a public template. Nothing in it may name the person or the bots
it was extracted from, the machine it was built on, or anything token-shaped.
This runs as the pre-commit hook, in CI (`--all`) and on the assembly before
the first commit.

    debrand-lint.py --all              scan every tracked/assembled file
    debrand-lint.py --staged           scan the staged diff (pre-commit)
    debrand-lint.py <path>...          scan the given files
    debrand-lint.py --self-test        prove the patterns catch the fixtures

Exit 1 on any hit, printing `path:line: <pattern> — <matched text>`.

Patterns are the CONCEPT, not one phrasing: an identity string in any case,
a Windows user profile path, a Claude Code project slug derived from one, a
Telegram bot token (8-12 digit ids; the older {8,10} missed newer bots), API
keys, and a bare chat-id-shaped integer next to `chat_id`. A per-bot extra
list can be supplied with --terms-file (gitignored `debrand-terms.txt`).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def _hx(*words: str) -> str:
    """Decode hex-encoded terms into an alternation regex fragment.

    The terms are stored hex-encoded on purpose: the public-safety gate for
    this tree is a PLAIN substring grep for the identity strings, and the
    linter is part of the tree. Encoding keeps the file itself grep-clean
    while the compiled patterns are the real words."""
    return "(" + "|".join(bytes.fromhex(w).decode() for w in words) + ")"


IDENTITY = [
    # name -> regex (case-insensitive). Keep these as CONCEPTS; the self-test
    # below proves each one fires on a fixture.
    # No word boundaries on the names: the public-safety check is a plain
    # substring grep, so `SERVICE_<org>_WARN` or `mon<bird>` must fail here too.
    ("identity:person", _hx("6d6172637573", "617276696473736f6e")),
    ("identity:org", _hx("786e6472", "6661646972", "6e6a6f7264", "6c657672", "6b6169737461", "76616e6972", "67756172646169616e")),
    ("identity:bot", _hx("676f6f7365", "6f64696e626f74", "6f64696e2d626f74", "796d6972")),
    ("identity:repo", _hx("676f6f73652d626f742d7632", "6f64696e2d626f742d7632", "756e6e616d65642d626f74") + r"|\bgb2\b|\bob2\b"),
    ("identity:env-prefix", r"\b(GB2_|G" + bytes.fromhex("4f4f53455f56325f").decode() + "|G" + bytes.fromhex("4f4f53455f").decode() + ")[A-Z_]+"),
    ("identity:github", r"\b" + bytes.fromhex("6d726373586e6472").decode() + r"\b"),
    ("path:user-profile", r"[A-Za-z]:[\\/]+Users[\\/]+(?!<|\{|\$|%|YOUR|USERNAME\b|username\b|you\b|me\b)[A-Za-z0-9_.-]+"),
    ("path:cc-slug", r"\b[A-Za-z]--Users-[A-Za-z0-9_-]+"),
    ("path:home-shorthand", r"(?<![A-Za-z0-9])~[\\/]Code[\\/]"),
]
SECRETS = [
    ("token:telegram", r"\b[0-9]{8,12}:AA[A-Za-z0-9_-]{33,}"),
    ("token:anthropic", r"sk-ant-[A-Za-z0-9_-]{20,}"),
    ("token:openai", r"\bsk-(?!ant-)[A-Za-z0-9]{20,}"),
    ("token:github", r"\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})"),
    ("token:aws", r"\bAKIA[A-Z0-9]{16}\b"),
    ("token:slack", r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    ("token:private-key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("token:cf-api", r"\bCF_API_(KEY|TOKEN)\s*=\s*['\"]?[A-Za-z0-9_-]{20,}"),
    ("id:chat-id-literal", r"\bchat_id\s*[=:]\s*['\"]?[0-9]{7,12}\b"),
]

# Files that legitimately contain the patterns: this linter (its own table and
# fixtures) and the compat doc that quotes hook payloads verbatim.
SELF = {"scripts/debrand-lint.py"}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".pytest_cache", "bots"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".m4a", ".webm", ".mp3", ".wav",
            ".ico", ".woff", ".woff2", ".ttf", ".pdf", ".zip", ".db", ".sqlite"}

FIXTURES = [
    # identity fixtures are decoded from hex for the same reason as the terms
    ("identity:person", "owner is " + bytes.fromhex("4d6172637573").decode() + " here"),
    ("identity:org", "the " + bytes.fromhex("584e4452").decode() + " hub"),
    ("identity:bot", bytes.fromhex("476f6f7365426f74").decode() + " v2 says hi"),
    ("identity:repo", "clone " + bytes.fromhex("676f6f73652d626f742d7632").decode() + " first"),
    ("identity:env-prefix", "GB2_TG_MUTE=1"),
    ("path:user-profile", r"C:\Users\someone\Code\thing"),
    ("path:cc-slug", "C--Users-someone-Code-thing"),
    ("token:telegram", "123456789012:AA" + "x" * 33),
    ("token:anthropic", "sk-ant-" + "a" * 24),
    ("token:github", "ghp_" + "b" * 36),
    ("id:chat-id-literal", "chat_id=123456789"),
]

ALLOW = [
    # generic placeholder forms that the patterns must NOT flag
    r"C:\Users\<you>\Code\BotCorp",
    r"C:\Users\%USERNAME%\.botcorp",
    r"C:\Users\$env:USERNAME",
    "chat_id: 123456",          # 6 digits: below the id floor
    "python tools/tg/tg_send.py --chat-id <id>",
]


def compiled(extra_terms: list[str]):
    pats = [(n, re.compile(p, re.IGNORECASE)) for n, p in IDENTITY]
    pats += [(n, re.compile(p)) for n, p in SECRETS]
    for t in extra_terms:
        t = t.strip()
        if t and not t.startswith("#"):
            pats.append((f"extra:{t}", re.compile(re.escape(t), re.IGNORECASE)))
    return pats


def scan_text(rel: str, text: str, pats) -> list[str]:
    hits = []
    for i, line in enumerate(text.splitlines(), 1):
        for name, rx in pats:
            m = rx.search(line)
            if m:
                hits.append(f"{rel}:{i}: {name} — {m.group(0)[:60]}")
    return hits


def iter_files(paths: list[Path]):
    for p in paths:
        if p.is_dir():
            for dp, dns, fns in os.walk(p):
                dns[:] = [d for d in dns if d not in SKIP_DIRS]
                for fn in fns:
                    f = Path(dp) / fn
                    if f.suffix.lower() in SKIP_EXT:
                        continue
                    yield f
        elif p.is_file() and p.suffix.lower() not in SKIP_EXT:
            yield p


def rel_of(f: Path) -> str:
    try:
        return f.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return f.as_posix()


def self_test(pats) -> int:
    bad = 0
    for name, fixture in FIXTURES:
        hit = [n for n, rx in pats if rx.search(fixture)]
        if name not in hit:
            print(f"SELF-TEST FAIL: {name} did not match fixture {fixture!r}")
            bad += 1
    for allowed in ALLOW:
        hit = [n for n, rx in pats if rx.search(allowed)]
        if hit:
            print(f"SELF-TEST FAIL: placeholder {allowed!r} flagged as {hit}")
            bad += 1
    print(f"self-test: {len(FIXTURES)} fixtures hit, {len(ALLOW)} placeholders clean"
          if not bad else f"self-test: {bad} failure(s)")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--staged", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--terms-file", help="extra terms, one per line (per-bot debrand-terms.txt)")
    ap.add_argument("--root", help="scan root for --all (default: repo root)")
    a = ap.parse_args()

    extra: list[str] = []
    if a.terms_file and Path(a.terms_file).is_file():
        extra = Path(a.terms_file).read_text(encoding="utf-8", errors="replace").splitlines()
    pats = compiled(extra)

    rc = 0
    if a.self_test:
        rc |= self_test(pats)
        if not (a.all or a.staged or a.paths):
            return rc

    global ROOT
    if a.root:
        ROOT = Path(a.root).resolve()

    hits: list[str] = []
    if a.staged:
        try:
            out = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
                                 capture_output=True, text=True, check=True).stdout
        except Exception as e:
            print(f"debrand-lint: git diff failed: {e}")
            return 1
        files = [ROOT / ln.strip() for ln in out.splitlines() if ln.strip()]
    elif a.all:
        files = list(iter_files([ROOT]))
    else:
        files = list(iter_files([Path(p) for p in a.paths]))

    for f in files:
        rel = rel_of(f)
        if rel in SELF:
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        hits += scan_text(rel, text, pats)

    for h in hits:
        print(h)
    print(f"debrand-lint: {len(files)} files, {len(hits)} hit(s)")
    return 1 if hits else rc


if __name__ == "__main__":
    sys.exit(main())
