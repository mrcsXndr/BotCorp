"""Skip marker for node suites that import the cockpit's TypeScript sources.

Node runs a .ts import only with type stripping, on by default from 22.18 and
23.6. The CI runner is Node 20 (.github/workflows pins it, and changing that
needs the workflow token scope), where such an import throws
ERR_UNKNOWN_FILE_EXTENSION. On an older node these suites are skipped, not
failed; on the host they run.
"""
from __future__ import annotations

import re
import shutil
import subprocess

import pytest


def _node_strips_types() -> bool:
    if shutil.which("node") is None:
        return False
    try:
        out = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    m = re.match(r"v(\d+)\.(\d+)", out.strip())
    if not m:
        return False
    major, minor = int(m.group(1)), int(m.group(2))
    return (major == 22 and minor >= 18) or (major == 23 and minor >= 6) or major >= 24


needs_node_ts = pytest.mark.skipif(not _node_strips_types(),
                                   reason="node without TypeScript type stripping (needs >= 22.18 / 23.6)")
