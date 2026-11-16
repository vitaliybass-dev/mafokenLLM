"""Private companion for a single paired phone, behind the local Tailscale Serve proxy."""
import base64
import binascii
import hmac
from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
import secrets
from threading import Lock
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PORT = 8772
ASSETS = {"/": ("iphone.html", "text/html"), "/iphone.js": ("iphone.js", "text/javascript"),
          "/iphone.css": ("iphone.css", "text/css")}


class Companion:
    def __init__(self, models, request, default_model):
        self.models, self.request, self.default_model = models, request, default_model
        self.lock = Lock()
        self.generation = Lock()
        self.reset()

    def reset(self):
        self.origin = self.login = self.code = self.token = ""
        self.deadline = self.expires = 0
        self.attempts = 0
        self.command = None
        self.last = None
        self.screenshot = None

    def manage(self, body):
        with self.lock:
            action = body.get("action")
            if action == "start":
                origin, login = body.get("origin"), body.get("login")
                if not isinstance(origin, str) or not isinstance(login, str) or not login:
                    raise ValueError("Не найден аккаунт Tailscale.")
                url = urlsplit(origin)
                if (url.scheme not in ("http", "https") or not url.hostname or not url.hostname.endswith(".ts.net")
                        or url.username or url.password or url.path or url.query or url.fragment
                        or not 1 <= (url.port or 443) <= 65535):
                    raise ValueError("Неверный адрес Tailscale.")
                self.reset()
                self.origin, self.login = origin, login
                self.code = f"{secrets.randbelow(100_000_000):08d}"
                self.deadline = time.monotonic() + 300
            elif action == "stop":
                self.reset()
            elif action == "result":
                if self.command and self.command["id"] == body.get("id"):
                    if self.command["kind"] == "screenshot":
                        encoded = body.get("jpeg")
                        if isinstance(encoded, str) and len(encoded) <= 1_400_000:
                            try:
                                data = base64.b64decode(encoded, validate=True)
                                if data.startswith(b"\xff\xd8"):
                                    self.screenshot = (self.command["id"], data)
                            except (ValueError, binascii.Error):
                                pass
                    self.last = {"id": self.command["id"], "message": str(body.get("message", ""))[:300],
                                 "screenshot": bool(self.screenshot and self.screenshot[0] == self.command["id"])}
                    self.command = None
            return {"enabled": bool(self.origin), "code": self.code if time.monotonic() < self.deadline else "",
                    "paired": bool(self.token) and time.monotonic() < self.expires,
                    "command": self.current_command()}

    def current_command(self):
        if self.command and min(self.command["until"], self.expires) <= time.monotonic():
            self.last = {"id": self.command["id"], "message": "Истекло время подтверждения на Mac."}
            self.command = None
        return self.command

    def pair(self, code):
        if self.attempts >= 8 or not self.code or time.monotonic() >= self.deadline:
            return ""
        self.attempts += 1
        if not hmac.compare_digest(code, self.code.encode()):
            return ""
        self.code = ""
        self.token = secrets.token_urlsafe(32)
        self.expires = time.monotonic() + 12 * 3600
        return self.token


class PhoneHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        pass

    def response(self, status, mime="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()

    def packet(self, **body):
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode() + b"\n")
        self.wfile.flush()

    def reject(self, status, message):
        self.response(status)
        self.packet(error=message)

    def verify(self, post=False, paired=True):
        state = self.server.companion
        host = self.headers.get("Host", "")
        identity = self.headers.get("Tailscale-User-Login", "")
        # Serve replaces the identity headers and this handler only listens on loopback.
        if (not state.origin or host.lower() != state.origin.split("://", 1)[1].lower()
                or not hmac.compare_digest(identity.encode(), state.login.encode())):
            self.reject(403, "Включите доступ на Mac и войдите в тот же аккаунт Tailscale.")
            return False
        if post and (self.headers.get("Origin") != state.origin
                     or self.headers.get_content_type() != "application/json"):
            self.reject(403, "Не удалось подтвердить источник запроса.")
            return False
        if paired and (not state.token or time.monotonic() >= state.expires
                       or not hmac.compare_digest(self.headers.get("Authorization", "").encode(),
                                                  ("Bearer " + state.token).encode())):
            self.reject(401, "Введите код, показанный на Mac.")
            return False
        return True

    def do_GET(self):
        state = self.server.companion
        with state.lock:
            if not self.verify(paired=self.path not in ASSETS):
                return
            if self.path in ASSETS:
                name, mime = ASSETS[self.path]
                self.response(200, mime)
                self.wfile.write((ROOT / name).read_bytes())
                return
            if self.path == "/api/screenshot":
                if not state.screenshot:
                    self.reject(404, "Снимок недоступен.")
                    return
                self.response(200, "image/jpeg")
                self.wfile.write(state.screenshot[1])
                return
            if self.path == "/api/command":
                self.response(200)
                command = state.current_command()
                self.packet(pending=command["id"] if command else None, result=state.last)
                return
        if self.path == "/api/models":
            try:
                models = state.models()
            except (ValueError, OSError, KeyError):
                self.reject(503, "Ollama на Mac недоступна.")
                return
            self.response(200)
            self.packet(models=models, default=state.default_model)
        else:
            self.reject(404, "Адрес не найден.")

    def do_POST(self):
        state = self.server.companion
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 131072:
                raise ValueError()
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError()
        except (ValueError, OSError):
            self.reject(400, "Неверный формат запроса.")
            return

        with state.lock:
            if not self.verify(post=True, paired=self.path != "/api/pair"):
                return
            if self.path == "/api/pair":
                code = body.get("code")
                token = state.pair(code.encode()) if isinstance(code, str) and len(code) == 8 and code.isascii() else ""
                if not token:
                    self.reject(401, "Код неверный или истёк. Покажите новый код на Mac.")
                    return
                self.response(200)
                self.packet(token=token)
                return
            if self.path == "/api/logout":
                state.token = ""
                state.expires = 0
                state.command = state.last = state.screenshot = None
                self.response(200)
                self.packet(ok=True)
                return
            if self.path == "/api/command":
                kind, value = body.get("kind"), body.get("value")
                if kind not in ("desktop", "volume", "mute", "unmute", "screenshot") or (
                        kind == "volume" and (type(value) is not int or not 0 <= value <= 100)):
                    self.reject(400, "Недопустимая команда.")
                    return
                if state.current_command():
                    self.reject(409, "На Mac уже ожидает подтверждения другой запрос.")
                    return
                if kind == "screenshot":
                    state.screenshot = None
                state.command = {"id": secrets.token_hex(12), "kind": kind, "value": value if kind == "volume" else None,
                                 "until": time.monotonic() + 60}
                self.response(202)
                self.packet(id=state.command["id"])
                return
        if self.path == "/api/chat":
            self.chat(body)
        else:
            self.reject(404, "Адрес не найден.")

    def chat(self, body):
        state = self.server.companion
        model, messages = body.get("model"), body.get("messages")
        if (not isinstance(model, str) or not isinstance(messages, list) or not 1 <= len(messages) <= 40
                or not all(isinstance(m, dict) and m.get("role") in ("user", "assistant")
                           and isinstance(m.get("content"), str) and 0 < len(m["content"]) <= 16000 for m in messages)
                or messages[-1]["role"] != "user"):
            self.reject(400, "Проверьте сообщение и выберите модель.")
            return
        if not state.generation.acquire(blocking=False):
            self.reject(409, "Другой запрос с iPhone уже выполняется.")
            return
        authorized_token = self.headers.get("Authorization")
        try:
            if model not in state.models():
                self.reject(400, "Эта модель Ollama недоступна.")
                return
            with state.request("http://127.0.0.1:11434/api/chat", {"model": model, "stream": True,
                       "messages": [{"role": m["role"], "content": m["content"]} for m in messages],
                       "options": {"num_predict": 2048}}, timeout=120) as upstream:
                self.response(200, "application/x-ndjson")
                try:
                    for raw in upstream:
                        with state.lock:
                            if authorized_token != "Bearer " + state.token or time.monotonic() >= state.expires:
                                self.packet(error="Подключение iPhone закрыто на Mac.")
                                return
                        event = json.loads(raw)
                        if event.get("error"):
                            break
                        value = event.get("message", {}).get("content")
                        if isinstance(value, str) and value:
                            self.packet(delta=value)
                        if event.get("done") is True:
                            self.packet(done=True)
                            return
                    self.packet(error="Ollama прервала ответ.")
                except OSError:
                    pass
                except (ValueError, TypeError):
                    self.packet(error="Не удалось разобрать ответ Ollama.")
        except (ValueError, OSError, KeyError):
            self.reject(502, "Не удалось получить ответ Ollama.")
        finally:
            state.generation.release()
