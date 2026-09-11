"""Start the personal UI without a persistent console window."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("Y2Y2_ENGINE_PORT", "49273"))
URL = f"http://127.0.0.1:{PORT}"


def running():
    try:
        request = urllib.request.Request(URL + "/session", headers={"X-Y2Y2-Local": "1"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=1) as response:
            return json.load(response).get("version") == "personal-2026.09.12"
    except Exception:
        return False


def main():
    if running():
        if "--no-browser" not in sys.argv:
            webbrowser.open(URL)
        return 0
    runtime = ROOT / ".runtime"
    if runtime.is_dir():
        sys.path.insert(0, str(runtime))
    try:
        import yt_dlp
        import yt_dlp_ejs
        import imageio_ffmpeg
    except ImportError:
        print("First run: python -m pip install --no-user --target .runtime -r requirements.txt")
        return 1
    if not shutil.which("node") and not shutil.which("deno"):
        print("Node.js 22+ or Deno is required. Install the official runtime, then start again.")
        return 1
    env = os.environ.copy()
    env["PYTHONPATH"] = str(runtime) + os.pathsep + env.get("PYTHONPATH", "")
    with (ROOT / "personal.log").open("ab") as log:
        child = subprocess.Popen([sys.executable, str(ROOT / "y2y2_personal.py"), "--no-browser"],
                                 cwd=ROOT, env=env, stdout=log, stderr=log,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    for _ in range(80):
        if running():
            if "--no-browser" not in sys.argv:
                webbrowser.open(URL)
            return 0
        if child.poll() is not None:
            break
        time.sleep(.15)
    print("Y2Y2 could not start. See personal.log in this folder.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
