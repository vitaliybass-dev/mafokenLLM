"""Read-only status checks for recognized provider endpoints."""
import json
import re
from urllib.error import HTTPError, URLError

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
    403: "У ключа нет прав на проверку.",
    404: "Провайдер не нашёл указанную модель.",
    429: "Провайдер ограничил частоту проверок. Повторите позже.",
}


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
