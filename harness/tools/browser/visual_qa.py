"""
Visual QA capture tool.

Captures screenshots of a set of app pages at mobile (390x844 isMobile) +
desktop (1440x900) viewports, writes an index file. The CALLING agent (Claude
with vision) reads each screenshot via its Read tool to judge UI — this tool
does not itself judge anything, it only captures.

Usage:
  python tools/browser/visual_qa.py --base http://localhost:3000
  python tools/browser/visual_qa.py --base https://staging.example.com \
      --pages home,settings --viewport mobile
  python tools/browser/visual_qa.py --base https://staging.example.com \
      --no-bypass --cookie <session-cookie-value>

Optional dev-auth bypass: if the app exposes a dev-login endpoint that sets a
session cookie, point BOT_VISUAL_QA_BYPASS_PATH / --dev-email at it and this
tool will call it and carry the resulting cookie into every page. Disabled by
default (--no-bypass is implied when neither is configured); pass --cookie to
carry an existing session cookie instead.

Output:
  screenshots/visual_qa/<timestamp>/{mobile,desktop}_<page>.png
  screenshots/visual_qa/<timestamp>/index.md  ← list with file paths
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

ROOT = instance_root()
SHOTS_ROOT = ROOT / "screenshots" / "visual_qa"

DEFAULT_PAGES: list[tuple[str, str]] = [
    ("home", "/"),
]

# Generic dev-auth bypass config — set these for an app that has one; left
# unset, --no-bypass behavior applies (pages are captured logged-out).
BYPASS_PATH = os.environ.get("BOT_VISUAL_QA_BYPASS_PATH", "/api/auth/dev-bypass")
SESSION_COOKIE_NAME = os.environ.get("BOT_VISUAL_QA_SESSION_COOKIE", "session")
DEFAULT_DEV_EMAIL = os.environ.get("BOT_VISUAL_QA_DEV_EMAIL", "test@example.com")


def get_dev_session(base_url: str, email: str) -> str | None:
    body = json.dumps({"email": email}).encode()
    req = Request(
        f"{base_url}{BYPASS_PATH}",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Origin": base_url,
            "User-Agent": "Mozilla/5.0 (visual-qa)",
        },
        method="POST",
    )
    try:
        resp = urlopen(req, timeout=15)
    except HTTPError as e:
        print(f"[!] dev-bypass failed: {e.code}")
        return None
    set_cookies = resp.getheader("Set-Cookie") or ""
    for chunk in set_cookies.split(","):
        for piece in chunk.split(";"):
            piece = piece.strip()
            if piece.startswith(f"{SESSION_COOKIE_NAME}="):
                return piece.split("=", 1)[1]
    return None


def run(base_url: str, pages: list[tuple[str, str]], viewports: list[str],
        out_dir: Path, use_bypass: bool, dev_email: str, existing_cookie: str | None) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    session = existing_cookie
    if use_bypass and not session:
        session = get_dev_session(base_url, dev_email)
        if not session:
            print("[!] no auth — pages will hit login screen")
    cookie_domain = base_url.replace("https://", "").replace("http://", "").split("/")[0]

    from playwright.sync_api import sync_playwright

    captured: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for vp_name in viewports:
            if vp_name == "mobile":
                ctx = browser.new_context(
                    viewport={"width": 390, "height": 844},
                    device_scale_factor=2,
                    is_mobile=True,
                    has_touch=True,
                    user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1",
                )
            else:
                ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            if session:
                ctx.add_cookies([{
                    "name": SESSION_COOKIE_NAME, "value": session,
                    "domain": cookie_domain, "path": "/",
                    "httpOnly": True, "secure": True, "sameSite": "Lax",
                }])
            page = ctx.new_page()
            for slug, path in pages:
                url = base_url + path
                shot_path = out_dir / f"{vp_name}_{slug}.png"
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    page.wait_for_timeout(3500)
                    page.screenshot(path=str(shot_path), full_page=True)
                    print(f"  {vp_name:7s} {slug:18s} → {shot_path.name}")
                    captured.append({"viewport": vp_name, "page": slug, "path": str(shot_path)})
                except Exception as e:
                    print(f"  {vp_name:7s} {slug:18s} → FAIL: {e}")
                    captured.append({"viewport": vp_name, "page": slug, "path": "FAILED", "error": str(e)})
            ctx.close()
        browser.close()

    # Write index for the calling agent to read each shot.
    index_path = out_dir / "index.md"
    md = [f"# Visual QA Screenshots — {time.strftime('%Y-%m-%d %H:%M:%S')}",
          f"\n**Base:** `{base_url}`  ·  **Pages:** {len(pages)}  ·  **Viewports:** {', '.join(viewports)}",
          "\nRead each screenshot via the Read tool. Inspect for: mobile sidebar bleed, horizontal scroll, content cut at edge, overlapping text, broken layout, action buttons unreachable.",
          "\n## Screenshots\n"]
    for c in captured:
        md.append(f"- **{c['viewport']:7s}** — `{c['page']}`")
        md.append(f"  - `{c['path']}`")
    index_path.write_text("\n".join(md), encoding="utf-8")
    print(f"\n[+] {len(captured)} screenshots captured")
    print(f"[+] index → {index_path}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:3000")
    ap.add_argument("--pages", default="")
    ap.add_argument("--viewport", default="both", choices=["mobile", "desktop", "both"])
    ap.add_argument("--no-bypass", action="store_true")
    ap.add_argument("--dev-email", default=DEFAULT_DEV_EMAIL)
    ap.add_argument("--cookie", default="")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    pages = DEFAULT_PAGES
    if args.pages:
        wanted = set(s.strip() for s in args.pages.split(",") if s.strip())
        pages = [p for p in DEFAULT_PAGES if p[0] in wanted]
        if not pages:
            # A caller passing page slugs not in DEFAULT_PAGES almost always
            # means they want ad-hoc paths — accept "slug=/path" too.
            pages = []
            for item in args.pages.split(","):
                item = item.strip()
                if not item:
                    continue
                if "=" in item:
                    slug, path = item.split("=", 1)
                else:
                    slug, path = item, "/" + item
                pages.append((slug, path))

    viewports = ["mobile", "desktop"] if args.viewport == "both" else [args.viewport]
    out_dir = Path(args.out) if args.out else SHOTS_ROOT / time.strftime("%Y%m%d_%H%M%S")
    use_bypass = not args.no_bypass
    sys.exit(run(args.base, pages, viewports, out_dir, use_bypass, args.dev_email, args.cookie or None))


if __name__ == "__main__":
    main()
