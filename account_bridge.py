"""Private connection from mafokenLLM's HTTP server to the official ChatGPT SDK."""
import atexit
from contextlib import contextmanager
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
from threading import Lock
import time

ROOT = Path(__file__).resolve().parent
GUARD = Lock()
_process = None
_temp = None


class Unavailable(Exception):
    pass


class LocalConnection(HTTPConnection):
    def __init__(self, address, timeout):
        super().__init__("localhost", timeout=timeout)
        self.address = address

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self.address)
        except OSError:
            sock.close()
            raise
        self.sock = sock


@atexit.register
def cleanup():
    global _process, _temp
    if _process is not None:
        _process.stdin.close()
        try:
            _process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            _process.kill()
            _process.wait()
        _process = None
    if _temp is not None:
        _temp.cleanup()
        _temp = None


def bridge_address():
    global _process, _temp
    with GUARD:
        if _process is not None and _process.poll() is None:
            return str(Path(_temp.name) / "s")
        cleanup()
        node = shutil.which("node") or next((p for p in
            ("/opt/homebrew/bin/node", "/usr/local/bin/node") if Path(p).is_file()), None)
        if not node or not (ROOT / ".siwc/sdk/packages/local/dist/index.js").is_file() or not (
                ROOT / ".siwc/keychain-helper").is_file():
            raise Unavailable("Вход через ChatGPT требует установки локального модуля.")
        _temp = tempfile.TemporaryDirectory(prefix="lchat-", dir="/tmp")
        address = str(Path(_temp.name) / "s")
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("OPENAI_", "CODEX_", "NODE_"))}
        _process = subprocess.Popen([node, str(ROOT / "chatgpt_bridge.mjs"), address],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        for _ in range(70):
            if Path(address).is_socket():
                return address
            if _process.poll() is not None:
                break
            time.sleep(0.05)
        cleanup()
        raise Unavailable("Не удалось запустить вход через ChatGPT.")


@contextmanager
def send(method, path, payload=None, timeout=12):
    conn = LocalConnection(bridge_address(), timeout)
    try:
        body = json.dumps(payload).encode() if payload is not None else None
        conn.request(method, path, body, {"Content-Type": "application/json"})
        with conn.getresponse() as response:
            if response.status != 200:
                raise Unavailable("Служба входа ChatGPT недоступна.")
            yield response
    finally:
        conn.close()


def status(method, path):
    try:
        with send(method, path) as response:
            return json.loads(response.read(65536))
    except (Unavailable, OSError, ValueError):
        return {"available": False, "status": "disconnected", "sharing": False,
                "error": "Модуль входа ChatGPT недоступен."}
