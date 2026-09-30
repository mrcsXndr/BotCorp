"""QA pack C 4: the engine contract's module rows say what the code gates.

For telegram, usage_resume and telemetry, each fact below is checked on both
sides: the code does it (the evidence string is in the named source) and the
module's row in docs/engine-contract.md names it.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]

FACTS = [
    # module, words the row must carry, source, code evidence
    ("telegram", "access.json", "daemon/sync.mjs", "if (cfg.harness.modules.telegram) {"),
    ("telegram", "poller", "daemon/tick.ps1", "if ($hasTg -and $alive) {"),
    ("telegram", "boot prompt", "daemon/botyaml.mjs", "return cfg.harness.modules.telegram ? BOOT_PROMPT_DEFAULT : '';"),
    ("telegram", "botcorp/telegram.json", "daemon/sync.mjs", "report['.claude-<name>/botcorp/telegram.json'] = writeIfChanged("),
    ("usage_resume", "usage_monitor.py warn", "daemon/tick.ps1", "Invoke-UsageWarn -Bot $Bot"),
    ("usage_resume", "--resume-check", "daemon/tick.ps1", "$a = @($um, '--resume-check')"),
    ("telemetry", "OpenTelemetry env at launch", "daemon/launch.ps1", "($modules -contains 'telemetry')"),
    ("telemetry", "hub push", "harness/tools/infra/hub_push.py", 'if module_enabled("telemetry"):'),
    ("telemetry", "OTel sink", "daemon/tick.ps1", "Invoke-OtelSinkKeepalive"),
]


def _row(module: str) -> str:
    md = (ASSEMBLY / "docs" / "engine-contract.md").read_text(encoding="utf-8")
    m = re.search(rf"^\| `{module}` \|.*$", md, re.M)
    assert m, f"no contract row for {module}"
    return m.group(0)


@pytest.mark.parametrize("module,words,source,evidence", FACTS)
def test_contract_row_names_what_the_code_gates(module, words, source, evidence):
    assert evidence in (ASSEMBLY / source).read_text(encoding="utf-8"), f"{source} no longer has: {evidence}"
    assert words in _row(module), f"the {module} row does not mention {words!r}"
