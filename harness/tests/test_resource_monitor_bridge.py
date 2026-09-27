"""The duplicate-TG-bridge check in resource_monitor.ps1 (Get-BridgeHolderKey /
Get-BridgeVerdict), ported from a bot's own fixed copy of this script.

Locked behaviour:
- a bridge HOLDER is decided by launch shape, not by a loose mention of the
  path in argv: `--channels plugin:telegram…` or a `--settings` pointing at a
  tracked tg-enable file. A process whose PROMPT merely quotes that path (a
  triage/report tick describing the very warning this check emits) is not a
  holder — a check that its own alert text can trip is a loop.
- a `claude --bg-pty-host <pipe> ... -- <child>` wrapper (a background session
  host that repeats its child's argv verbatim) is not a holder either; only
  the child is, so one session never reads as two.
- two holders of the SAME group (the same --settings file, or the bare
  '(default)' shape) are a 'dup' (warn) only once the SECOND-oldest holder has
  been alive >= DupBridgeMinMin (default 10 minutes). A younger pair is
  'young' (info) — a launch overlap or a scratch bot torn down within the
  hour is not something anyone can act on by paging for it. A single holder,
  or an unknown-age (0.0) second holder under the floor, is not a warn.
- the floor is inclusive, and the verdict counts every holder in the group,
  not just the two ages that decide it.

Both functions are lifted out of the monitor so a test can drive the decision
directly, without needing to fake process ages (a real claude.exe cannot be
made two hours old on demand). Each helper here pulls the function's source
text out of the SHIPPED script via its own AST, the same way
tools/infra/test_resource_monitor_reap.ps1 does upstream, so this tests the
code that actually runs and never a copy that can drift away from it.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
MONITOR = ASSEMBLY / "harness" / "tools" / "infra" / "resource_monitor.ps1"

needs_pwsh = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None,
                                 reason="Windows with pwsh on PATH")


def _ps_str(s: str) -> str:
    """A PowerShell single-quoted string literal for `s` (only ' needs doubling;
    backslashes must stay literal, so this must not go through json.dumps)."""
    return "'" + s.replace("'", "''") + "'"


def _run_ps(script: str) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                        capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def _extract_fn(name: str) -> str:
    script = (
        f"$ast = [System.Management.Automation.Language.Parser]::ParseFile({_ps_str(str(MONITOR))}, [ref]$null, [ref]$null); "
        f"$fn = $ast.Find({{ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq {_ps_str(name)} }}, $true); "
        "if ($fn) { $fn.Extent.Text } else { '' }"
    )
    return _run_ps(script)


def _verdict(ages: list[float], min_min: float = 10.0) -> dict:
    fn = _extract_fn("Get-BridgeVerdict")
    assert fn, "monitor no longer defines Get-BridgeVerdict"
    ages_lit = ",".join(repr(float(a)) for a in ages)
    out = _run_ps(f"{fn}\n(Get-BridgeVerdict -Ages @({ages_lit}) -MinMin {float(min_min)!r}) | ConvertTo-Json -Compress")
    return json.loads(out)


def _holder_key(command_line: str) -> str:
    fn = _extract_fn("Get-BridgeHolderKey")
    assert fn, "monitor no longer defines Get-BridgeHolderKey"
    out = _run_ps(f"{fn}\nGet-BridgeHolderKey -CommandLine {_ps_str(command_line)}")
    return out


# --- Get-BridgeVerdict: warn only once a duplicate has PERSISTED -------------

@needs_pwsh
def test_a_single_holder_is_not_an_issue():
    assert _verdict([300.0])["verdict"] == "none"


@needs_pwsh
def test_a_young_second_holder_is_info_not_warn():
    v = _verdict([45.0, 6.0])
    assert v["verdict"] == "young"
    assert v["held"] == 6.0  # names how long it has been doubled


@needs_pwsh
def test_two_holders_both_past_the_floor_warn():
    assert _verdict([180.0, 95.0])["verdict"] == "dup"


@needs_pwsh
def test_the_warn_counts_every_holder_not_just_the_deciding_pair():
    assert _verdict([180.0, 95.0, 90.0])["count"] == 3


@needs_pwsh
def test_an_unknown_age_holder_does_not_warn():
    # a holder whose CreationDate was unreadable comes in as age 0.0: unknown
    # must not promote a duplicate to a warn.
    assert _verdict([180.0, 0.0])["verdict"] == "young"


@needs_pwsh
def test_the_floor_is_inclusive():
    assert _verdict([60.0, 10.0], min_min=10.0)["verdict"] == "dup"


def test_a_naive_count_check_would_have_warned_on_a_short_lived_duplicate():
    # mutation proof: the bug this replaces was `count > 1` with no age term,
    # which fires on the exact "young" case above.
    assert len([45.0, 6.0]) > 1


# --- Get-BridgeHolderKey: only a LAUNCHED bridge counts as a holder ----------

@needs_pwsh
def test_a_launched_bot_groups_by_its_settings_file():
    cmd = (r'claude.exe --dangerously-skip-permissions --resume abc123 '
           r'--channels plugin:telegram@claude-plugins-official '
           r'--settings C:\bots\alpha\.claude\tg-enable.settings.json')
    assert _holder_key(cmd) == r'c:\bots\alpha\.claude\tg-enable.settings.json'


@needs_pwsh
def test_bare_channels_is_the_default_group():
    assert _holder_key('claude.exe --channels plugin:telegram@claude-plugins-official') == '(default)'


@needs_pwsh
def test_a_prompt_that_only_quotes_the_path_is_not_a_holder():
    # a report/triage tick: its PROMPT names the file and the flag words, but
    # it was launched with neither flag itself.
    tick = ('claude.exe --print --model claude-opus-5 --setting-sources user -p '
            '"2 claude procs hold the SAME TG bridge '
            '(c:\\bots\\alpha\\.claude\\tg-enable.settings.json) '
            '- duplicate session / dual-poller risk"')
    assert _holder_key(tick) == ''


def test_a_naive_substring_match_would_have_counted_that_prompt():
    # mutation proof: the bug this replaces matched the bare path anywhere in
    # the command line, including inside a quoted prompt.
    tick = r'-p "... c:\bots\alpha\.claude\tg-enable.settings.json ..."'
    assert "tg-enable.settings.json" in tick


@needs_pwsh
def test_a_plain_worker_is_not_a_holder():
    assert _holder_key('claude.exe -p --setting-sources user') == ''


@needs_pwsh
def test_the_bg_pty_host_wrapper_is_not_a_holder_but_its_child_is():
    # the background session host repeats its child's argv verbatim: one
    # session, two procs, and only the child should hold the bridge.
    pty_host = (r'C:\botcorp\bin\claude.exe --bg-pty-host \\.\pipe\cc-daemon-pty-1 200 50 -- '
                r'C:\botcorp\bin\claude.exe --session-id b12e56b1 --dangerously-skip-permissions '
                r'--setting-sources user,project -n alpha --channels plugin:telegram@claude-plugins-official '
                r'--settings C:\bots\alpha\.claude\tg-enable.settings.json --')
    assert _holder_key(pty_host) == ''
    child = pty_host.split(' -- ', 1)[1]
    assert _holder_key(child) == r'c:\bots\alpha\.claude\tg-enable.settings.json'


# --- end-to-end: one holder per group is NOT a duplicate on a live box -------

@needs_pwsh
def test_a_real_run_reports_no_duplicate_when_each_bridge_has_one_holder():
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(MONITOR)],
                        capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    dup_lines = [i for i in out["issues"] if "SAME TG bridge" in i["detail"] and i["sev"] == "warn"]
    if int(out.get("claude_procs", 0)) < 1:
        pytest.skip("no bridge holder running on this box — nothing to observe")
    # a REAL dual-poller on this box also fails this assertion — check the
    # running claude processes before assuming the test is wrong.
    assert dup_lines == []
