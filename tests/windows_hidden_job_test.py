"""Windows-only smoke test for DTV HTTP Job Object ownership; no real TradingView involved."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER_DIR = ROOT / "scripts" / "windows"


@unittest.skipUnless(os.name == "nt", "Windows-only Win32 process lifetime smoke test")
class HiddenJobObjectTests(unittest.TestCase):
    def test_child_disappears_when_hidden_owner_is_terminated(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "child.pid"
            launcher = Path(tmp) / "owner.py"
            launcher.write_text(
                "import os,sys\n"
                "from pathlib import Path\n"
                "sys.path.insert(0, sys.argv[1])\n"
                "from _job_process import run_job_child\n"
                "pid_file=Path(sys.argv[2])\n"
                "cmd='import os,time;open(' + repr(str(marker)) + "
                "',' + repr('w') + ').write(str(os.getpid()));time.sleep(60)'\n"
                "with open(os.devnull, 'w', encoding='utf-8') as log:\n"
                "  raise SystemExit(run_job_child([sys.executable,'-c',cmd],"
                "cwd=os.getcwd(),env=os.environ,log=log))\n",
                encoding="utf-8",
            )
            owner = subprocess.Popen(
                [sys.executable, str(launcher), str(HELPER_DIR), str(marker)],
                creationflags=0x08000000,
            )
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and not marker.exists():
                    if owner.poll() is not None:
                        self.fail("owner exited before a child was started")
                    time.sleep(0.1)
                self.assertTrue(marker.exists(), "child process was not created")
                child_id = int(marker.read_text(encoding="utf-8"))
                owner.terminate()
                owner.wait(timeout=8)

                def alive(pid):
                    output = subprocess.check_output(
                        ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                        text=True, errors="replace",
                    )
                    return str(pid) in output

                deadline = time.monotonic() + 12
                while time.monotonic() < deadline and alive(child_id):
                    time.sleep(0.2)
                self.assertFalse(alive(child_id), "orphaned DTV child after owner stopped")
            finally:
                if owner.poll() is None:
                    owner.terminate()
                    owner.wait(timeout=8)


if __name__ == "__main__":
    unittest.main()
