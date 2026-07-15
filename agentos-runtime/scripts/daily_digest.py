#!/usr/bin/env python
"""Generate an AgentOS daily digest."""
import subprocess
import sys
from pathlib import Path

WORKSPACE = Path('C:\\Users\\User\\AgentOS')
CLI = WORKSPACE / "agentosctl.py"
subprocess.run([sys.executable, str(CLI), "--workspace", str(WORKSPACE), "digest", "daily"], check=True)
