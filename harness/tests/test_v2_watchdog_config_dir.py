"""tools/v2/tg_watchdog.py: --config-dir token resolution + UNKNOWN classification.

A bad or unreachable token must never crash the watchdog — it must classify
as UNKNOWN so the caller takes no action (fail-open). Network calls are
monkeypatched; no test here ever reaches api.telegram.org.
"""
from __future__ import annotations

import urllib.error

import tg_watchdog as tw


def _write_env(config_dir, token: str) -> None:
    env_dir = config_dir / "channels" / "telegram"
    env_dir.mkdir(parents=True, exist_ok=True)
    (env_dir / ".env").write_text(f"TELEGRAM_BOT_TOKEN={token}\n", encoding="utf-8")


def test_read_token_from_config_dir_env_file(tmp_path):
    _write_env(tmp_path, "bad-token-123")
    assert tw._read_token(tmp_path) == "bad-token-123"


def test_read_token_falls_back_to_env_var_when_file_absent(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "env-fallback-token")
    assert tw._read_token(tmp_path / "nocfg") == "env-fallback-token"


def test_read_token_absent_returns_none(tmp_path, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    assert tw._read_token(tmp_path / "nocfg") is None


def test_probe_classifies_non_409_non_200_as_unknown(monkeypatch):
    def _boom(req, timeout=None):
        raise urllib.error.URLError("no route to host")

    monkeypatch.setattr(tw.urllib.request, "urlopen", _boom)
    assert tw._probe_once("bad-token-123") == tw.UNKNOWN


def test_probe_classifies_http_409_as_alive(monkeypatch):
    def _fake(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 409, "Conflict", {}, None)

    monkeypatch.setattr(tw.urllib.request, "urlopen", _fake)
    assert tw._probe_once("bad-token-123") == tw.ALIVE


def test_classify_with_bad_token_never_raises_and_yields_unknown(monkeypatch):
    """classify() samples PROBE_SAMPLES times; with every probe erroring
    (bad token / no network) it must settle on UNKNOWN, never crash and never
    claim DEAD (which would trigger an auto-heal restart)."""
    def _boom(req, timeout=None):
        raise urllib.error.URLError("dns failure")

    monkeypatch.setattr(tw.urllib.request, "urlopen", _boom)
    monkeypatch.setattr(tw.time, "sleep", lambda *_a, **_k: None)  # skip the real sampling delay
    assert tw.classify("bad-token-123") == tw.UNKNOWN


def test_main_probe_only_with_bad_token_prints_unknown_and_exits_0(tmp_path, capsys, monkeypatch):
    _write_env(tmp_path, "bad-token-123")

    def _boom(req, timeout=None):
        raise urllib.error.URLError("no network in test")

    monkeypatch.setattr(tw.urllib.request, "urlopen", _boom)
    monkeypatch.setattr(tw.time, "sleep", lambda *_a, **_k: None)
    rc = tw.main(["tg_watchdog.py", "--probe-only", "--config-dir", str(tmp_path)])
    assert rc == 0
    assert capsys.readouterr().out.strip() == "UNKNOWN"
