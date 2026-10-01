"""QA pack B 7b: the daemon auto-roll at a declared breakpoint (module auto_roll).

Locked behaviour (daemon/tick.ps1 Get-AutoRollWhy, lifted out by the parser and
run with stubs for the breakpoint / busy checks and the log):
- every gate passes -> a reason naming the context and roll_tokens;
- each gate alone blocks it: a stale breakpoint, a busy session, a subagent in
  the bg job record (`fan` kind agent, or an agent kind in `inFlight`), an open
  subagent start of this session (pty), status.json of another session or too
  old, a context at or below harness.roll_tokens, a journal older than 30 min,
  an unreadable job record;
- harness.roll_tokens moves the threshold; bot.yaml validation takes an
  integer >= 100000 only;
- Invoke-BotTick asks only with the module on, and writes the fresh-restart
  marker (and drops the breakpoint) right before spawning restart.ps1.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
needs_win = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows + pwsh")
SID = "11111111-2222-3333-4444-555555555555"
BG = "a1b2c3d4"

PROBE = r"""
param([string]$Tick, [string]$Root, [string]$Bg, [string]$Sid, [string]$Fresh, [string]$Busy, [string]$Roll, [string]$CfgFile)
$ErrorActionPreference = 'Continue'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Tick, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-AutoRollWhy' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$script:logs = @()
function Write-DaemonLog { param($Message, $Bot, [switch]$Quiet) $script:logs += "$Message" }
function Read-JsonFile { param($Path) try { Get-Content -Raw -LiteralPath $Path -ErrorAction Stop | ConvertFrom-Json } catch { $null } }
function Test-BreakpointFresh { param($Bot) $Fresh -eq '1' }
function Test-SessionBusy { param($Bot) $Busy -eq '1' }
$cfg = [pscustomobject]@{ harness = [pscustomobject]@{ roll_tokens = $(if ($Roll) { [int]$Roll } else { 500000 }) } }
if ($CfgFile) { $cfg = Get-Content -Raw -LiteralPath $CfgFile | ConvertFrom-Json }
$paths = @{ BotHome = (Join-Path $Root 'bot'); ConfigDir = (Join-Path $Root 'cfg'); BotStateDir = (Join-Path $Root 'state') }
$why = Get-AutoRollWhy -Bot 't' -Cfg $cfg -Paths $paths -BgId $Bg -SessionId $Sid
[pscustomobject]@{ why = "$why"; logs = @($script:logs) } | ConvertTo-Json -Compress
"""


def _box(tmp: Path, *, ctx=620000, status_sid=SID, status_age_s=60, journal_age_s=60, fan=(), in_flight=(), job=True):
    bot, cfg, state = tmp / "bot", tmp / "cfg", tmp / "state"
    for d in (bot / "memory" / "sessions" / SID, bot / ".claude", cfg / "botcorp", cfg / "jobs" / BG, state):
        d.mkdir(parents=True, exist_ok=True)
    j = bot / "memory" / "sessions" / SID / "journal.md"
    j.write_text("# Journal\n", encoding="utf-8")
    t = time.time() - journal_age_s
    os.utime(j, (t, t))
    (cfg / "botcorp" / "status.json").write_text(json.dumps({
        "ts": time.time() - status_age_s, "session_id": status_sid,
        "context_window": {"context_window_size": 1000000, "current_usage": {
            "input_tokens": 20000, "cache_read_input_tokens": ctx - 30000, "cache_creation_input_tokens": 10000}}}), encoding="utf-8")
    jf = cfg / "jobs" / BG / "state.json"
    if job:
        jf.write_text(json.dumps({"state": "idle", "tempo": "idle", "fan": list(fan),
                                  "inFlight": {"tasks": len(in_flight), "kinds": list(in_flight)}}), encoding="utf-8")
    elif jf.exists():
        jf.unlink()
    return bot, state


def _why(tmp, bg=BG, sid=SID, fresh="1", busy="0", roll="", cfg_file=""):
    ps = tmp / "probe.ps1"
    ps.write_text(PROBE, encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ps),
                        "-Tick", str(ASSEMBLY / "daemon" / "tick.ps1"), "-Root", str(tmp), "-Bg", bg, "-Sid", sid,
                        "-Fresh", fresh, "-Busy", busy, "-Roll", roll, "-CfgFile", str(cfg_file)], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr + r.stdout
    return json.loads(r.stdout.strip().splitlines()[-1])


@needs_win
def test_every_gate_passes_rolls(tmp_path):
    _box(tmp_path)
    out = _why(tmp_path)
    assert out["why"] == "auto-roll: context 620K > roll_tokens 500K at a declared breakpoint", out


@needs_win
@pytest.mark.parametrize("case", ["stale-breakpoint", "busy", "fan-agent", "inflight-agent", "other-session", "old-status",
                                  "small-context", "old-journal", "no-job-record"])
def test_each_gate_blocks(tmp_path, case):
    kw = {"fan-agent": {"fan": [{"id": "a1", "kind": "agent", "label": "x"}]},
          "inflight-agent": {"in_flight": ["local_agent"]},
          "other-session": {"status_sid": "someone-else"},
          "old-status": {"status_age_s": 61 * 60},
          "small-context": {"ctx": 500000},
          "old-journal": {"journal_age_s": 31 * 60},
          "no-job-record": {"job": False}}.get(case, {})
    _box(tmp_path, **kw)
    out = _why(tmp_path, fresh="0" if case == "stale-breakpoint" else "1", busy="1" if case == "busy" else "0")
    assert out["why"] == "", (case, out)
    if case != "stale-breakpoint":
        assert any(l.startswith("auto-roll: not at this breakpoint") for l in out["logs"]), out


@needs_win
def test_a_shell_in_the_fan_is_not_a_subagent(tmp_path):
    _box(tmp_path, fan=[{"id": "b1", "kind": "shell", "label": "ls"}], in_flight=["artifact_watch"])
    assert _why(tmp_path)["why"].startswith("auto-roll:")


@needs_win
def test_pty_open_subagent_start_blocks_and_its_stop_clears(tmp_path):
    _, state = _box(tmp_path)
    f = state / "subagents.jsonl"
    f.write_text(json.dumps({"event": "start", "session_id": SID, "agent_id": "x1"}) + "\n", encoding="utf-8")
    assert _why(tmp_path, bg="")["why"] == ""
    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"event": "stop", "session_id": SID, "agent_id": "x1"}) + "\n")
    assert _why(tmp_path, bg="")["why"].startswith("auto-roll:")


@needs_win
def test_roll_tokens_moves_the_threshold(tmp_path):
    _box(tmp_path, ctx=300000)
    assert _why(tmp_path)["why"] == ""
    assert _why(tmp_path, roll="200000")["why"] == "auto-roll: context 300K > roll_tokens 200K at a declared breakpoint"


def test_roll_tokens_schema(tmp_path):
    def check(v):
        f = tmp_path / "bot.yaml"
        f.write_text(f"name: v\nharness:\n  roll_tokens: {v}\n", encoding="utf-8")
        return subprocess.run(["node", str(ASSEMBLY / "daemon" / "botyaml.mjs"), str(f), "--validate"], capture_output=True, text=True, timeout=60)
    assert check(300000).returncode == 0
    for bad in ("99999", "'lots'", "300000.5"):
        r = check(bad)
        assert r.returncode == 1 and "roll_tokens" in r.stderr, (bad, r.stderr)


def test_the_tick_asks_only_with_the_module_and_marks_fresh_before_the_restart():
    text = (ASSEMBLY / "daemon" / "tick.ps1").read_text(encoding="utf-8")
    body = text[text.index("function Invoke-BotTick"):]
    assert "(Test-BotModule $cfg 'auto_roll')" in body and "Get-AutoRollWhy -Bot $Bot" in body
    marker = body.index("Set-Content -LiteralPath $P.FreshMarker")
    assert body.index("if ($autoRoll) {") < marker < body.index("Start-RestartDetached")
    assert body.index("Test-SessionBusy -Bot $Bot -LimitBlocked:$stuck") < marker   # every gate first


# v0.9.13: a live bot ran context_window 50% (a 500K compact point) with the
# default roll_tokens 500000. Claude Code compacted at 467-493K every time, so
# the context never passed 500K and the roll never fired (21 compactions, no
# fresh session in 5 days).
def _effective(tmp_path, harness: str, model: str = "claude-opus-5-5") -> tuple[dict, subprocess.CompletedProcess]:
    f = tmp_path / "bot.yaml"
    f.write_text(f"name: v\nmodel: {model}\nharness:\n{harness}", encoding="utf-8")
    eff = subprocess.run(["node", str(ASSEMBLY / "daemon" / "botyaml.mjs"), str(f)], capture_output=True, text=True, timeout=60)
    assert eff.returncode == 0, eff.stderr
    val = subprocess.run(["node", str(ASSEMBLY / "daemon" / "botyaml.mjs"), str(f), "--validate"], capture_output=True, text=True, timeout=60)
    return json.loads(eff.stdout), val


@pytest.mark.parametrize("harness,model,compact_at,roll", [
    ("  context_window: 50%\n", "claude-opus-5-5", 500000, 400000),                   # the live case: capped
    ("  context_window: 70%\n", "claude-opus-5-5", 700000, 500000),                   # the default: roll_tokens stands
    ("  context_window: auto\n", "claude-opus-5-5", 1000000, 500000),                 # auto = the model's window
    ("  context_window: 70%\n", "claude-haiku-4-5-20251001", 140000, 112000),         # a 200K model
    ("  context_window: 50%\n  roll_tokens: 300000\n", "claude-opus-5-5", 500000, 300000),
])
def test_the_roll_threshold_sits_below_the_compact_point(tmp_path, harness, model, compact_at, roll):
    cfg, _ = _effective(tmp_path, harness, model)
    assert (cfg["_compact_at"], cfg["_roll_tokens"]) == (compact_at, roll)
    assert cfg["_roll_tokens"] <= 0.8 * cfg["_compact_at"]


def test_validate_warns_when_roll_tokens_reaches_the_compact_point(tmp_path):
    _, val = _effective(tmp_path, "  context_window: 50%\n")
    assert val.returncode == 0, val.stderr                       # a warning, never a launch-blocking error
    assert "bot.yaml: warning: harness.roll_tokens 500000 >= the auto-compact point 500000" in val.stderr, val.stderr
    _, val = _effective(tmp_path, "  context_window: 70%\n")
    assert val.returncode == 0 and "warning" not in val.stderr, val.stderr


@needs_win
def test_the_tick_rolls_below_the_compact_point(tmp_path):
    cfg, _ = _effective(tmp_path, "  context_window: 50%\n")
    cf = tmp_path / "effective.json"
    cf.write_text(json.dumps(cfg), encoding="utf-8")
    _box(tmp_path, ctx=450000)                                   # past 80% of 500K, short of the compaction
    out = _why(tmp_path, cfg_file=cf)
    assert out["why"] == ("auto-roll: context 450K > roll threshold 400K (roll_tokens 500K capped below the 500K "
                          "compact point) at a declared breakpoint"), out


def test_doctor_warns_when_roll_tokens_reaches_the_compact_point(tmp_path):
    from test_operator_only import cli, make_bot, operator_env
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    make_bot(bots, "w", "name: w\nmodel: claude-opus-5-5\nharness:\n  service: manual\n  context_window: 50%\n")
    make_bot(bots, "p", "name: p\nmodel: claude-opus-5-5\nharness:\n  service: manual\n")
    r = cli(operator_env(rt, bots), "doctor", "--no-tg-probe", "--no-accounts", "--json", timeout=300)
    rows = {c["name"]: c for c in json.loads(r.stdout)}
    assert rows["w: roll threshold"]["level"] == "WARN" and "rolls at 400000" in rows["w: roll threshold"]["detail"]
    assert rows["p: roll threshold"]["level"] == "PASS", rows["p: roll threshold"]
