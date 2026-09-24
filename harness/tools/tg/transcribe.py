#!/usr/bin/env python3
"""
transcribe.py — transcribe a voice/audio file. Groq Whisper when configured,
local faster-whisper otherwise.

Groq (primary when GROQ_API_KEY is in .env): fast, hosted whisper-large-v3-turbo.
Telegram voice messages from the channel plugin arrive as .oga files with
audio/ogg mime — Groq's filename-based filetype check rejects .oga even though
the content is identical to .ogg, so we always override the filename in the
multipart form to .ogg. Also requires a browser-style User-Agent header —
Cloudflare in front of Groq returns 403 (error code 1010) for plain Python
urllib UAs.

Local (fallback when the key is missing OR the Groq call fails): faster-whisper
on CPU, int8. It decodes .oga through its bundled PyAV, so no ffmpeg binary is
required. Model weights are cached under ~/.cache/huggingface on first use
(~500MB for `small`).

One stderr line always says which path ran.

Usage:
    python tools/tg/transcribe.py <path-to-audio-file> [--model small] [--language xx]

Prints the transcript to stdout (empty output = nothing recognisable, e.g.
silence — that is a pass, not an error).

Exit codes:
    0  transcribed (possibly empty)
    1  bad path / decode failure
    2  Groq unavailable AND faster-whisper not installed (prints the pip line)
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

# Windows without Developer Mode: the HF cache falls back to copies and warns
# on every run. Harmless, and the warning would otherwise land in the bot's
# stderr each voice note.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

ENV_FILE = instance_root() / ".env"
GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
MODEL = "whisper-large-v3-turbo"  # faster, similar quality for short clips
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

AUDIO_EXTS = (".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".flac", ".webm", ".mp4")


def load_env_var(name: str) -> str:
    """The env var wins (lets a test point at an empty/bad key); else .env; else ''."""
    if name in os.environ:
        return os.environ[name].strip()
    if not ENV_FILE.exists():
        return ""
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        if k.strip() == name:
            return v.strip()
    return ""


def transcribe_groq(path: Path, api_key: str) -> str:
    """Raises on any HTTP/network failure so the caller can fall back."""
    data = path.read_bytes()
    boundary = f"----PythonBoundary{int(time.time() * 1000)}"

    # Telegram voice files arrive as .oga; Groq's filetype check rejects .oga
    # even though the bytes are valid OGG. Override the filename in the form.
    forced_filename = "voice.ogg"

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{forced_filename}"\r\n'
        f"Content-Type: audio/ogg\r\n\r\n"
    ).encode("utf-8")
    body += data
    body += (
        f"\r\n--{boundary}\r\n"
        f'Content-Disposition: form-data; name="model"\r\n\r\n'
        f"{MODEL}\r\n"
        f"--{boundary}--\r\n"
    ).encode("utf-8")

    req = urllib.request.Request(
        GROQ_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
            return result.get("text", "").strip()
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from Groq: {body_text[:300]}") from e


def transcribe_local(path: Path, model: str, language: str | None) -> int:
    """Prints the transcript; returns the exit code."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed. Install it with:\n"
              "    pip install faster-whisper\n"
              "then re-run this command.", file=sys.stderr)
        return 2

    try:
        wm = WhisperModel(model, device="cpu", compute_type="int8")
        segments, _info = wm.transcribe(str(path), language=language, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
    except Exception as exc:
        msg = str(exc)
        print(f"error: transcription failed: {type(exc).__name__}: {msg[:300]}", file=sys.stderr)
        if path.suffix.lower() in AUDIO_EXTS and ("decod" in msg.lower() or "av" in msg.lower()):
            print("If this is a codec/decode problem, install ffmpeg and convert first:\n"
                  "    winget install --id Gyan.FFmpeg -e\n"
                  f"    ffmpeg -i \"{path}\" -ar 16000 -ac 1 \"{path.with_suffix('.wav')}\"",
                  file=sys.stderr)
        return 1

    print(f"[transcribe] local faster-whisper ({model})", file=sys.stderr)
    print(text)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Groq Whisper when configured, local faster-whisper otherwise")
    p.add_argument("path")
    p.add_argument("--model", default="small",
                   help="local whisper size: tiny/base/small/medium (default small); ignored on the Groq path")
    p.add_argument("--language", default=None, help="ISO code for the local path (e.g. en, sv)")
    args = p.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f"error: {path} does not exist", file=sys.stderr)
        return 1

    api_key = load_env_var("GROQ_API_KEY")
    if api_key:
        try:
            text = transcribe_groq(path, api_key)
            print("[transcribe] groq whisper-large-v3-turbo", file=sys.stderr)
            print(text)
            return 0
        except Exception as exc:
            reason = " ".join(str(exc).split())[:200]
            print(f"[transcribe] groq failed ({type(exc).__name__}: {reason}); "
                  "falling back to local faster-whisper", file=sys.stderr)
    else:
        print("[transcribe] GROQ_API_KEY not set; using local faster-whisper", file=sys.stderr)

    return transcribe_local(path, args.model, args.language)


if __name__ == "__main__":
    sys.exit(main())
