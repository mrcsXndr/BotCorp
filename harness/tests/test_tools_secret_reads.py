"""R5c step 19b: the scan detects secret reads on every executable.

secretReads() counts a declared key's env name, or an env read (os.environ,
os.getenv, process.env, $env:) whose literal name looks like a secret. A
secret reader is proposed as an exact integration entry whatever references
it, an unreferenced one is an orphan carrying its reads, and no glob is formed
over a folder that holds one.
"""
from __future__ import annotations

import json
import subprocess

import pytest

from test_operator_only import ASSEMBLY, box, cli, needs_node  # noqa: F401

TOOLS_MJS = (ASSEMBLY / "cli" / "tools.mjs").as_uri()
READER = 'import os\nkey = os.environ["AWS_SECRET_ACCESS_KEY"]\n'


def _reads(text: str, declared: list) -> list:
    script = ("const { secretReads } = await import(process.argv[1]);"
              "const [t, d] = JSON.parse(process.argv[2]);"
              "console.log(JSON.stringify(secretReads(t, d)));")
    r = subprocess.run(["node", "--input-type=module", "-e", script, TOOLS_MJS, json.dumps([text, declared])],
                       capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@needs_node
@pytest.mark.parametrize("text, declared, want", [
    ('os.environ.get("HOME")', [], []),                                        # (e) not a secret name
    ('os.getenv("PATH")\nprocess.env.USER', [], []),
    ('os.environ["AWS_SECRET_ACCESS_KEY"]', [], ["AWS_SECRET_ACCESS_KEY"]),
    ("os.environ.get('GH_TOKEN', '')", [], ["GH_TOKEN"]),
    ('os.getenv("DB_PASSWORD")', [], ["DB_PASSWORD"]),
    ("const k = process.env.STRIPE_API_KEY;", [], ["STRIPE_API_KEY"]),
    ("process.env['SIGNING_KEY']", [], ["SIGNING_KEY"]),
    ("$h = $env:CF_BEARER", [], ["CF_BEARER"]),
    ("print('MAIL_TOKEN is set')", ["mail_token"], ["MAIL_TOKEN"]),            # a declared key by name
    ("env CLAUDE_CODE_OAUTH_TOKEN", ["oauth_token"], ["CLAUDE_CODE_OAUTH_TOKEN", "OAUTH_TOKEN"]),
    ("print('MAIL_TOKEN')", [], []),                                           # undeclared and no env read
    ('os.environ.get("MAX_CONTEXT_TOKENS")', [], []),                          # a token COUNT, not a token
    ('os.environ.get("AUTH_TOKEN_FILE")', [], ["AUTH_TOKEN_FILE"]),            # a path to one still counts
])
def test_secret_reads(text, declared, want):
    assert _reads(text, declared) == want


def _scan(env, bot="t"):
    r = cli(env, "tools", bot, "scan", "--json")
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _write(home, files):
    for rel, text in files.items():
        f = home / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")


@needs_node
def test_an_unreferenced_reader_is_an_orphan_with_its_reads(box):
    rt, bots, env = box
    _write(bots / "t", {"tools/x/a.py": READER})
    d = _scan(env)
    assert d["proposal"]["orphans"] == [{"path": "tools/x/a.py", "reads": ["AWS_SECRET_ACCESS_KEY"]}]
    assert d["proposal"]["tools"] == []


@needs_node
def test_a_documented_reader_is_an_integration_naming_the_undeclared_key(box):
    rt, bots, env = box
    _write(bots / "t", {"tools/x/a.py": READER, "CLAUDE.md": "Run `python tools/x/a.py` to sync.\n"})
    (tools,) = _scan(env)["proposal"]["tools"]
    assert tools["path"] == "tools/x/a.py" and tools["kind"] == "integration"
    assert "AWS_SECRET_ACCESS_KEY" in tools["purpose"] and "not declared" in tools["purpose"]
    assert "secrets" not in tools


@needs_node
def test_a_declared_key_goes_in_secrets(box):
    rt, bots, env = box
    (bots / "t" / "bot.yaml").write_text("name: t\nharness:\n  service: manual\nsecrets: [oauth_token, mail_token]\n", encoding="utf-8")
    _write(bots / "t", {"tools/lib/m.py": 'import os\nt = os.environ["MAIL_TOKEN"]\n', "tools/cli/run.py": "import m\n",
                        "CLAUDE.md": "Run `python tools/cli/run.py`.\n"})
    tools = {e["path"]: e for e in _scan(env)["proposal"]["tools"]}
    m = tools["tools/lib/m.py"]      # import-only, still an exact integration
    assert m["kind"] == "integration" and m["secrets"] == ["mail_token"] and "not declared" not in m["purpose"]


@needs_node
def test_no_glob_over_a_folder_holding_a_reader(box):
    rt, bots, env = box
    _write(bots / "t", {
        "tools/x/one.py": "print(1)\n", "tools/x/two.py": "print(2)\n", "tools/x/a.py": READER,
        "tools/y/one.py": "print(1)\n", "tools/y/two.py": "print(2)\n",
        "CLAUDE.md": "`tools/x/one.py` `tools/x/two.py` `tools/x/a.py` `tools/y/one.py` `tools/y/two.py`\n",
    })
    tools = {e["path"]: e for e in _scan(env)["proposal"]["tools"]}
    assert set(tools) == {"tools/x/one.py", "tools/x/two.py", "tools/x/a.py", "tools/y/*.py"}
    assert tools["tools/x/a.py"]["kind"] == "integration"
    assert tools["tools/x/one.py"]["kind"] == tools["tools/x/two.py"]["kind"] == "cli"
    assert len({e["name"] for e in tools.values()}) == 4
