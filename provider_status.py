"""Read-only status checks for recognized provider endpoints."""
import json
import math
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit

# Match the actual configured endpoint, including profiles under "Свой API".
OFFICIAL = {
    "https://api.deepseek.com/chat/completions": "deepseek",
    "https://api.deepseek.com/v1/chat/completions": "deepseek",
    "https://api.openai.com/v1/chat/completions": "openai",
    "https://api.anthropic.com/v1/messages": "anthropic",
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions": "gemini",
}

HTTP_STATUS = {
    401: "Провайдер отклонил ключ API.",
    402: "Провайдер требует пополнить счёт.",
    403: "Провайдер отказал в доступе. Проверьте права ключа и условия доступа.",
    451: "Провайдер сообщил об ограничении доступа (HTTP 451).",
    404: "Провайдер не нашёл указанную модель.",
    429: "Провайдер ограничил частоту проверок. Повторите позже.",
}


JUNAI_CATALOG = "https://agents.ai.atechlab.ru/api/models"


def usd_amount(value):
    return type(value) in (int, float) and 0 <= value < 1e15 and math.isfinite(value)


def junai_prices(request):
    # Public model cards use USD per million tokens, also used by JunAI's own calculator.
    with request(JUNAI_CATALOG, timeout=5) as upstream:
        payload = json.loads(upstream.read(2 * 1024 * 1024))
    prices = {}
    for row in payload["data"]["models"]:
        if (isinstance(row, dict) and isinstance(row.get("alias"), str)
                and usd_amount(row.get("input_price")) and usd_amount(row.get("output_price"))):
            prices[row["alias"]] = {"inputPrice": row["input_price"], "outputPrice": row["output_price"]}
    return {"prices": prices}


def deepseek_balance(payload):
    available = payload["is_available"]
    rows = payload["balance_infos"]
    if type(available) is not bool or not isinstance(rows, list):
        raise ValueError("Неверный формат ответа DeepSeek.")
    balances = []
    for row in rows:
        currency, amount = row["currency"], row["total_balance"]
        if (not isinstance(currency, str) or not re.fullmatch("[A-Z]{3}", currency)
                or not isinstance(amount, str) or not re.fullmatch(r"-?\d{1,20}(?:\.\d{1,12})?", amount)):
            raise ValueError("Неверный формат баланса DeepSeek.")
        balances.append({"currency": currency, "amount": amount})
    return {"state": "verified" if available else "unavailable", "balances": balances}


def completion_endpoint(endpoint, kind):
    """Expand a conventional /v1 base URL while preserving explicit routes."""
    suffix = {"openai": "/chat/completions", "anthropic": "/messages"}.get(kind)
    if not suffix or not isinstance(endpoint, str):
        return endpoint
    url = urlsplit(endpoint)
    path = url.path.rstrip("/")
    if path.endswith("/v1") and not url.query and not url.fragment:
        return urlunsplit(url._replace(path=path + suffix))
    return endpoint


def check(data, request):
    endpoint = data.get("endpoint")
    provider = OFFICIAL.get(endpoint) if isinstance(endpoint, str) else None
    if not provider:
        return {"state": "unsupported"}

    key = data.get("key")
    if not isinstance(key, str) or not 1 <= len(key) <= 4096 or any(not 32 < ord(c) < 127 for c in key):
        return {"state": "error", "message": "Недопустимый ключ API."}

    headers = {"Authorization": "Bearer " + key, "Accept": "application/json"}
    if provider == "deepseek":
        url = "https://api.deepseek.com/user/balance"
    else:
        model = data.get("model")
        if provider == "gemini" and isinstance(model, str):
            model = model.removeprefix("models/")
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,250}", model):
            return {"state": "error", "message": "Проверьте идентификатор модели."}

        if provider == "openai":
            url = "https://api.openai.com/v1/models/" + model
        elif provider == "anthropic":
            url = "https://api.anthropic.com/v1/models/" + model
            headers["anthropic-version"] = "2026-10-21"
        else:
            url = "https://generativelanguage.googleapis.com/v1beta/models/" + model
            del headers["Authorization"]
            headers["x-goog-api-key"] = key
    try:
        with request(url, headers=headers, timeout=8) as upstream:
            result = json.loads(upstream.read(65536))
        if provider == "deepseek":
            return deepseek_balance(result)
        identifier = result["name" if provider == "gemini" else "id"]
        if not isinstance(identifier, str) or not identifier:
            raise ValueError("Ответ не содержит модель.")
        return {"state": "verified"}
    except HTTPError as error:
        if error.fp is not None:
            error.close()
        return {"state": "error", "message": HTTP_STATUS.get(error.code, f"Проверка не удалась (HTTP {error.code}).")}
    except (URLError, OSError):
        return {"state": "error", "message": "Провайдер не ответил. Повторите проверку."}
    except (ValueError, KeyError, TypeError):
        return {"state": "error", "message": "Провайдер вернул неизвестный формат ответа."}


def list_models(data, request):
    """Fetch a catalog using only the host and key selected by the user."""
    endpoint, key = data.get("endpoint"), data.get("key")
    if not isinstance(key, str) or not 1 <= len(key) <= 4096 or any(not 32 < ord(c) < 127 for c in key):
        return {"state": "error", "message": "Укажите действующий ключ API."}
    try:
        if not isinstance(endpoint, str) or any(c.isspace() for c in endpoint):
            raise ValueError()
        endpoint = completion_endpoint(endpoint, data.get("kind"))
        url = urlsplit(endpoint)
        if (url.scheme != "https" or not url.hostname or url.username is not None
                or url.password is not None or url.query or url.fragment):
            raise ValueError()
    except ValueError:
        return {"state": "error", "message": "Укажите полный HTTPS-адрес API без параметров."}

    provider = OFFICIAL.get(endpoint)
    headers = {"Accept": "application/json"}
    if provider == "gemini":
        headers["x-goog-api-key"] = key
        path = "/v1beta/models"
    else:
        kind = "anthropic" if provider == "anthropic" else data.get("kind") if not provider else "openai"
        if kind == "anthropic":
            headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
            suffix = "/messages"
        elif kind == "openai":
            headers["Authorization"] = "Bearer " + key
            suffix = "/chat/completions"
        else:
            return {"state": "unsupported", "message": "Для этого API укажите ID модели вручную."}
        if not url.path.endswith(suffix):
            return {"state": "unsupported", "message": "Для этого адреса укажите ID модели вручную."}
        path = url.path[:-len(suffix)] + "/models"

    found, seen = set(), set()
    params = {}
    try:
        for _ in range(4):
            query = urlencode(params)
            catalog = urlunsplit(("https", url.netloc, path, query, ""))
            with request(catalog, headers=headers, timeout=3) as upstream:
                payload = json.loads(upstream.read(2 * 1024 * 1024 + 1))
            rows = payload["models" if provider == "gemini" else "data"]
            if not isinstance(rows, list):
                raise ValueError()
            for row in rows:
                if not isinstance(row, dict):
                    continue
                if provider == "gemini":
                    if "generateContent" not in (row.get("supportedGenerationMethods") or []):
                        continue
                    name = row.get("name", "")
                    if isinstance(name, str):
                        name = name.removeprefix("models/")
                else:
                    name = row.get("id")
                if isinstance(name, str) and 0 < len(name) <= 256 and all(32 < ord(c) < 127 for c in name):
                    found.add(name)
            if provider == "gemini":
                cursor, param = payload.get("nextPageToken"), "pageToken"
            elif provider == "anthropic" and payload.get("has_more"):
                cursor, param = payload["last_id"], "after_id"
                if not cursor:
                    raise ValueError()
            else:
                cursor = None
            if not cursor:
                return {"state": "verified", "models": sorted(found)}
            if not isinstance(cursor, str) or len(cursor) > 2048 or cursor in seen:
                raise ValueError()
            seen.add(cursor)
            params = {param: cursor}
        return {"state": "verified", "models": sorted(found), "partial": True}
    except HTTPError as error:
        with error:
            try:
                payload = json.loads(error.read(16384))
                code = payload["error"].get("code")
            except (ValueError, KeyError, TypeError, AttributeError, OSError):
                code = None
        if code == "unsupported_country_region_territory":
            message = "Провайдер сообщил, что доступ из этого региона недоступен."
        elif error.code == 404:
            message = "Каталог по этому адресу недоступен (HTTP 404). Проверьте адрес или введите ID модели."
        else:
            message = HTTP_STATUS.get(error.code, f"Не удалось загрузить каталог (HTTP {error.code}).")
        return {"state": "error", "message": message}
    except (URLError, OSError):
        return {"state": "error", "message": "Провайдер не ответил. Повторите проверку или выберите модель на Mac."}
    except (ValueError, KeyError, TypeError, AttributeError):
        return {"state": "error", "message": "Провайдер вернул неизвестный формат каталога."}
