"""v0.8.5 step 14a: every chain entry is an Account.

Locked behaviour (daemon/accounts.ps1 seed -Link / rename, cli/botcorp.mjs
accounts seed --link / rename / detectPlan, harness/hooks/operator-guard.sh):
- `accounts seed --link` registers each bot's own vault token once (matched by
  the vault fingerprint: two bots sharing a token get ONE account), sets
  `account:` on every bot that had none, and relabels every "bot <name>"
  label; `--json` prints {seeded, linked, relabeled}; a second run prints
  three empty lists; `--dry-run` reports the same and writes nothing;
- afterwards `accounts failover <bot> --json` names no `own:` chain entry;
- the plan comes from the account's .credentials.json (plan_source
  credentials), else the profile endpoint (a 403 -> plan null), never from an
  input, and no token reaches stdout, stderr, the cache or a log;
- `accounts rename` changes the label only;
- rename and seed --link refuse (exit 3) in any bot session, an admin bot's
  included, and change nothing; so does approve from a non-admin bot.

Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR with fake token values.
"""
from __future__ import annotations

import http.server
import json
import shutil
import sys
import threading

import pytest

from test_admin_role import ID_BOSS, ID_PEON, abox  # noqa: F401 (abox is a fixture)
from test_operator_only import ASSEMBLY, cli, make_bot, operator_env, queue

T1 = "sk-ant-oat01-" + "SHARED" * 5 + "-Qx1A"
T2 = "sk-ant-oat01-" + "SOLO" * 7 + "-Zz9b"
DOTS = "·" * 4

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
    reason="Windows only (DPAPI vaults) with pwsh and node on PATH",
)


def _cli_in(env, stdin, *args):
    import subprocess
    return subprocess.run(["node", str(ASSEMBLY / "cli" / "botcorp.mjs"), *args], input=stdin, capture_output=True,
                          text=True, encoding="utf-8", timeout=180, cwd=str(ASSEMBLY), env=env)


def _set_oauth(env, bot, token):
    r = _cli_in(env, token + "\n", "secrets", "set", bot, "oauth")
    assert r.returncode == 0, r.stdout + r.stderr


def _link(env, *extra):
    r = _cli_in(env, None, "accounts", "seed", "--link", "--json", *extra)
    assert r.returncode == 0, r.stdout + r.stderr
    assert T1 not in r.stdout + r.stderr and T2 not in r.stdout + r.stderr
    return json.loads(r.stdout)


def _accounts(env):
    r = _cli_in(env, None, "accounts", "list", "--json")
    assert r.returncode == 0, r.stderr
    return {a["id"]: a for a in json.loads(r.stdout)}


def _account_of(bots, bot):
    for line in (bots / bot / "bot.yaml").read_text(encoding="utf-8").splitlines():
        if line.startswith("account:"):
            return line.split(":", 1)[1].strip()
    return None


@pytest.fixture
def lbox(tmp_path):
    """alpha + beta share token T1, gamma has T2, delta has none; a legacy "bot alpha" account holds T1."""
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    for name in ("alpha", "beta", "gamma", "delta"):
        make_bot(bots, name)
    env = operator_env(rt, bots)
    for bot, tok in (("alpha", T1), ("beta", T1), ("gamma", T2)):
        _set_oauth(env, bot, tok)
    r = _cli_in(env, T1 + "\n", "accounts", "add", "alpha", "--label", "bot alpha")
    assert r.returncode == 0, r.stdout + r.stderr
    return rt, bots, env


def test_a_shared_token_is_one_account_and_every_bot_is_linked(lbox):
    rt, bots, env = lbox
    res = _link(env)
    accts = _accounts(env)
    # T1 was already registered as "alpha": reused, not a second account; T2 is new
    assert res["seeded"] == ["acct-zz9b"], res
    assert sorted(res["linked"]) == ["alpha", "beta", "gamma"], res
    assert res["relabeled"] == ["alpha"], res
    assert sorted(accts) == ["acct-zz9b", "alpha"]
    assert _account_of(bots, "alpha") == "alpha" and _account_of(bots, "beta") == "alpha"
    assert _account_of(bots, "gamma") == "acct-zz9b" and _account_of(bots, "delta") is None
    assert accts["acct-zz9b"]["masked"].endswith("Zz9b")
    log = [json.loads(l) for l in (rt / "logs" / "beta" / "accounts.log").read_text(encoding="utf-8").splitlines()]
    assert log[-1]["to"] == "alpha" and log[-1]["from"] is None and log[-1]["via"] == "seed --link"


def test_an_own_token_also_listed_as_a_backup_becomes_the_primary(lbox):
    """gamma's own token is acc-z's, which is also its backup: linking must not leave an invalid bot.yaml."""
    rt, bots, env = lbox
    assert _cli_in(env, T2 + "\n", "accounts", "add", "acc-z").returncode == 0
    (bots / "gamma" / "bot.yaml").write_text("name: gamma\nbackup_accounts: [acc-z, alpha]\nharness:\n  service: manual\n", encoding="utf-8")
    res = _link(env)
    assert "gamma" in res["linked"] and res["seeded"] == [], res
    text = (bots / "gamma" / "bot.yaml").read_text(encoding="utf-8")
    assert _account_of(bots, "gamma") == "acc-z" and "- alpha" in text and "- acc-z" not in text, text


def test_a_second_run_prints_three_empty_lists(lbox):
    rt, bots, env = lbox
    _link(env)
    before = {b: (bots / b / "bot.yaml").read_bytes() for b in ("alpha", "beta", "gamma", "delta")}
    assert _link(env) == {"seeded": [], "linked": [], "relabeled": []}
    assert {b: (bots / b / "bot.yaml").read_bytes() for b in before} == before


def test_no_label_is_named_after_a_bot(lbox):
    rt, bots, env = lbox
    _link(env)
    labels = {i: a["label"] for i, a in _accounts(env).items()}
    assert not any(l.startswith("bot ") for l in labels.values()), labels
    assert labels == {"alpha": f"Account {DOTS}Qx1A", "acct-zz9b": f"Account {DOTS}Zz9b"}


def test_failover_names_no_own_token_after_link(lbox):
    rt, bots, env = lbox
    before = _cli_in(env, None, "accounts", "failover", "beta", "--json")
    assert "own:beta" in before.stdout   # positive control: an unlinked bot's chain is its own token
    _link(env)
    for bot in ("alpha", "beta", "gamma"):
        r = _cli_in(env, None, "accounts", "failover", bot, "--json")
        assert r.returncode == 0, r.stderr
        assert "own:" not in r.stdout, r.stdout
        assert json.loads(r.stdout)["chain"][0]["id"] == _account_of(bots, bot)


def test_dry_run_reports_and_writes_nothing(lbox):
    rt, bots, env = lbox
    before = {b: (bots / b / "bot.yaml").read_bytes() for b in ("alpha", "beta", "gamma")}
    res = _link(env, "--dry-run")
    assert res == {"seeded": ["acct-zz9b"], "linked": ["alpha", "beta", "gamma"], "relabeled": ["alpha"]}, res
    assert sorted(_accounts(env)) == ["alpha"]
    assert {b: (bots / b / "bot.yaml").read_bytes() for b in before} == before


def test_plan_source_from_a_credentials_file(lbox):
    rt, bots, env = lbox
    leak = "sk-ant-oat01-" + "LOGIN" * 6 + "-Nope"
    creds = rt / "accounts" / "alpha" / "claude" / ".credentials.json"
    creds.parent.mkdir(parents=True, exist_ok=True)
    creds.write_text(json.dumps({"claudeAiOauth": {"accessToken": leak, "refreshToken": leak, "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"}}), encoding="utf-8")
    r = _cli_in(env, None, "accounts", "seed", "--link", "--json")
    assert r.returncode == 0, r.stderr
    a = _accounts(env)["alpha"]
    assert (a["plan"], a["plan_source"]) == ("Max 20×", "credentials"), a
    assert a["label"] == f"Max 20× {DOTS}Qx1A"
    assert _accounts(env)["acct-zz9b"]["plan"] is None
    for text in (r.stdout, r.stderr, (rt / "state" / "account-checks.json").read_text(encoding="utf-8"), (rt / "logs" / "accounts.log").read_text(encoding="utf-8")):
        assert leak not in text and T1 not in text


class _Profile(http.server.BaseHTTPRequestHandler):
    status, body, seen = 403, b'{"error":"forbidden"}', []

    def do_GET(self):  # noqa: N802
        type(self).seen.append((self.path, self.headers.get("Authorization"), self.headers.get("anthropic-beta")))
        self.send_response(type(self).status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(type(self).body)

    def log_message(self, *a):
        pass


@pytest.mark.parametrize("status,body,want", [
    (403, b'{"error":"forbidden"}', (None, None)),
    (200, json.dumps({"account": {"email": "x@example.com"}, "organization": {"organization_type": "claude_max", "rate_limit_tier": "default_claude_max_5x"}}).encode(), ("Max 5×", "profile")),
])
def test_profile_probe_on_add(tmp_path, status, body, want):
    """The probe gets the real token (not the CLI's masked copy); a 403 is no plan; no token is ever printed or cached."""
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    bots.mkdir()
    _Profile.status, _Profile.body, _Profile.seen = status, body, []
    srv = http.server.HTTPServer(("127.0.0.1", 0), _Profile)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        env = {**operator_env(rt, bots), "BOTCORP_OAUTH_PROFILE_URL": f"http://127.0.0.1:{srv.server_port}/api/oauth/profile"}
        r = _cli_in(env, T2 + "\n", "accounts", "add", "acc9", "--label", "Spare")
        assert r.returncode == 0, r.stdout + r.stderr
    finally:
        srv.shutdown()
    assert _Profile.seen == [("/api/oauth/profile", f"Bearer {T2}", "oauth-2025-04-20")]
    a = _accounts(env)["acc9"]
    assert (a["plan"], a["plan_source"]) == want, a
    cache = (rt / "state" / "account-checks.json").read_text(encoding="utf-8")
    assert json.loads(cache)[a["fp"]]["plan"] == want[0]
    for text in (r.stdout, r.stderr, cache, (rt / "logs" / "accounts.log").read_text(encoding="utf-8")):
        assert T2 not in text and "x@example.com" not in text


def test_the_plan_override_stays_on_the_cli(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    bots.mkdir()
    env = operator_env(rt, bots)
    assert _cli_in(env, T2 + "\n", "accounts", "add", "acc1", "--plan", "Team").returncode == 0
    a = _accounts(env)["acc1"]
    assert (a["plan"], a["plan_source"]) == ("Team", "operator")


def test_rename_changes_the_label_only(lbox):
    rt, bots, env = lbox
    fp = _accounts(env)["alpha"]["fp"]
    r = _cli_in(env, None, "accounts", "rename", "alpha", "--label", "-Home seat", "--by", "ops@example.com")
    assert r.returncode == 0, r.stdout + r.stderr
    a = _accounts(env)["alpha"]
    assert (a["label"], a["fp"]) == ("-Home seat", fp)
    log = json.loads((rt / "logs" / "accounts.log").read_text(encoding="utf-8").splitlines()[-1])
    assert log["action"] == "rename" and log["label"] == "-Home seat" and log["by"] == "ops@example.com"
    assert _cli_in(env, None, "accounts", "rename", "nope", "--label", "x").returncode == 2
    assert _cli_in(env, None, "accounts", "rename", "alpha").returncode == 2   # usage: no label


def test_no_bot_renames_links_or_approves_its_own_widening(abox):
    """The operator gate: exit 3 for an admin bot and a plain bot, nothing written."""
    rt, bots, op, as_bot = abox
    _set_oauth(op, "peon", T1)
    assert _cli_in(op, T2 + "\n", "accounts", "add", "acc1", "--label", "bot acc1").returncode == 0
    yamls = {b: (bots / b / "bot.yaml").read_bytes() for b in ("boss", "peon")}
    for env in (as_bot("boss", ID_BOSS), as_bot("peon", ID_PEON)):
        for args in (("accounts", "rename", "acc1", "--label", "mine"), ("accounts", "seed", "--link", "--json")):
            r = _cli_in(env, None, *args)
            assert r.returncode == 3 and "operator-only" in r.stderr, (args, r.stdout + r.stderr)
    assert _accounts(op)["acc1"]["label"] == "bot acc1"
    assert sorted(_accounts(op)) == ["acc1"]
    assert {b: (bots / b / "bot.yaml").read_bytes() for b in yamls} == yamls
    # a bot's own queued widening change: a plain bot cannot approve it; an admin bot never decides its own role
    q = queue(rt, "peon", [{"id": "w1", "ts": "2026-09-30T00:00:00Z", "path": "harness.modules.remote_control", "value": True, "requested_by": "bot:peon", "reason": "enables Remote Control"}])
    assert cli(as_bot("peon", ID_PEON), "approve", "peon", "w1").returncode == 3
    assert [e["id"] for e in json.loads(q.read_text(encoding="utf-8"))] == ["w1"]
    queue(rt, "boss", [{"id": "r1", "ts": "2026-09-30T00:00:00Z", "path": "role", "value": None, "requested_by": "bot:boss", "reason": "changes the bot role"}])
    assert cli(as_bot("boss", ID_BOSS), "approve", "boss", "r1").returncode == 3
    # positive control: the operator's terminal links
    assert _link(op)["linked"] == ["peon"]
