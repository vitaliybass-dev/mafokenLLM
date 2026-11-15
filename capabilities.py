"""Local tools and explicit, individually configured network calls."""
import base64
import csv
import io
import os
import re
import shutil
import statistics
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

FILE_LIMIT = 8 * 1024 * 1024
CONTEXT_LIMIT = 24000
IMAGE_TYPES = {"image/png": b"\x89PNG\r\n\x1a\n", "image/jpeg": b"\xff\xd8\xff",
               "image/webp": b"RIFF"}
TEXT_SUFFIXES = frozenset("""
txt md markdown csv tsv json jsonl yaml yml toml ini log xml html css js jsx ts tsx
py rb go rs swift java kt cs c cpp h hpp sh zsh bash sql diff patch r lua php svelte vue
""".split())


def decode(value, limit=FILE_LIMIT):
    if not isinstance(value, str) or len(value) > (limit + 2) // 3 * 4:
        raise ValueError("Файл слишком большой.")
    try:
        result = base64.b64decode(value, validate=True)
    except ValueError:
        raise ValueError("Не удалось прочитать вложение.") from None
    if not result or len(result) > limit:
        raise ValueError("Файл пуст или слишком большой.")
    return result


def image(item):
    mime, content = item.get("mime"), item.get("data")
    if mime not in IMAGE_TYPES:
        raise ValueError("Поддерживаются изображения PNG, JPEG и WebP.")
    raw = decode(content, 2 * 1024 * 1024)
    if not raw.startswith(IMAGE_TYPES[mime]) or (mime == "image/webp" and raw[8:12] != b"WEBP"):
        raise ValueError("Формат изображения не совпадает с содержимым.")
    return mime, content


def program(name):
    candidates = (shutil.which(name), "/opt/homebrew/bin/" + name, "/usr/local/bin/" + name)
    return next((p for p in candidates if p and Path(p).is_file()), None)


def run(argv, timeout=45):
    try:
        out = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             check=True, timeout=timeout)
        return out.stdout.decode("utf-8", "replace")
    except (subprocess.SubprocessError, OSError):
        raise ValueError("Локальный инструмент не смог обработать файл.") from None


def read_xml(archive, name):
    with archive.open(name) as stream:
        xml = stream.read(4 * 1024 * 1024 + 1)
    if len(xml) > 4 * 1024 * 1024 or b"<!DOCTYPE" in xml.upper() or b"\x00" in xml:
        raise ValueError("XML в документе слишком велик или имеет неподдерживаемый формат.")
    return ElementTree.fromstring(xml)


def office_text(raw, extension):
    ns_doc = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    ns_tab = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            if extension == "docx":
                root = read_xml(archive, "word/document.xml")
                return "\n".join("".join(t.text or "" for t in p.iter(ns_doc+"t"))
                                 for p in root.iter(ns_doc+"p"))
            shared = []
            names = archive.namelist()
            if "xl/sharedStrings.xml" in names:
                root = read_xml(archive, "xl/sharedStrings.xml")
                shared = ["".join(t.text or "" for t in item.iter(ns_tab+"t"))
                          for item in root.iter(ns_tab+"si")]
            result = []
            sheets = sorted(n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
            for name in sheets[:10]:
                root = read_xml(archive, name)
                out = io.StringIO()
                writer = csv.writer(out)
                for row in list(root.iter(ns_tab+"row"))[:1000]:
                    cells = []
                    for cell in list(row)[:80]:
                        label = re.match(r"[A-Z]+", cell.get("r", ""))
                        slot = len(cells)
                        if label:
                            slot = 0
                            for char in label.group()[:3]:
                                slot = slot * 26 + ord(char) - 64
                            slot -= 1
                        if slot >= 80:
                            break
                        if slot < len(cells):
                            continue
                        cells.extend([""] * (slot - len(cells)))
                        val = cell.findtext(ns_tab+"v", "")
                        if cell.get("t") == "s":
                            index = int(val)
                            val = shared[index] if 0 <= index < len(shared) else ""
                        elif cell.get("t") == "inlineStr":
                            val = "".join(t.text or "" for t in cell.iter(ns_tab+"t"))
                        formula = cell.findtext(ns_tab+"f")
                        if formula and not val:
                            val = "=" + formula
                        cells.append(val)
                    writer.writerow(cells)
                sheet = out.getvalue()
                result.append(Path(name).stem + "\n" + table_text(sheet, ","))
                if sum(map(len, result)) > CONTEXT_LIMIT:
                    break
            return "\n\n".join(result)
    except (ElementTree.ParseError, zipfile.BadZipFile, KeyError, IndexError, ValueError, RuntimeError):
        raise ValueError("Не удалось прочитать документ Office.") from None


def table_text(text, delimiter):
    try:
        reader = csv.reader(io.StringIO(text), delimiter=delimiter)
        header = next(reader)
        data = []
        for i, row in enumerate(reader):
            if i == 10000:
                break
            data.append(row[:80])
        summary = [f"Строк данных прочитано: {len(data)}; столбцов в заголовке: {len(header)}."]
        for col, title in enumerate(header[:30]):
            values = []
            for row in data:
                try:
                    number = float(row[col])
                    if abs(number) < 1e100:
                        values.append(number)
                except (ValueError, IndexError):
                    continue
            if values and len(values) >= len(data) * .8:
                summary.append(f"{title}: чисел={len(values)}, минимум={min(values):.8g}, "
                               f"максимум={max(values):.8g}, среднее={statistics.mean(values):.8g}")
        return "\n".join(summary) + "\n\nНачало таблицы:\n" + text[:14000]
    except (StopIteration, csv.Error):
        return text


def extract(data):
    name = str(data.get("name", ""))[:200]
    ext = Path(name.lower()).suffix.lstrip(".")
    raw = decode(data.get("data"))
    if ext in ("docx", "xlsx"):
        text = office_text(raw, ext)
    elif ext == "pdf":
        converter = program("pdftotext")
        if not converter:
            raise ValueError("Для PDF требуется pdftotext (Poppler).")
        with tempfile.TemporaryDirectory(prefix="localchat-pdf-") as tmp:
            source = Path(tmp) / "source.pdf"
            source.write_bytes(raw)
            text = run([converter, "-f", "1", "-l", "120", "-layout", str(source), "-"])
    elif ext in TEXT_SUFFIXES or not ext:
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeError:
            raise ValueError("Текстовый файл должен быть в UTF-8.") from None
        if "\x00" in text:
            raise ValueError("Ожидается текстовый файл.")
        if ext in ("csv", "tsv"):
            text = table_text(text, "," if ext == "csv" else "\t")
    else:
        raise ValueError("Поддерживаются текст, код, CSV, TSV, XLSX, DOCX и PDF с текстовым слоем.")
    text = text.strip()
    if not text:
        raise ValueError("Не найден текст. Для сканов PDF нужен OCR.")
    return {"name": name, "text": text[:CONTEXT_LIMIT], "truncated": len(text) > CONTEXT_LIMIT}


def whisper_model():
    return Path(os.environ.get("LOCALCHAT_WHISPER_MODEL",
        str(Path.home() / ".cache/whisper/ggml-large-v3-turbo.bin"))).expanduser()


def voice_available():
    return bool(program("ffmpeg") and program("whisper-cli") and whisper_model().is_file())


def transcribe(data):
    if not voice_available():
        raise ValueError("Для диктовки нужны ffmpeg, whisper-cli и локальная модель Whisper.")
    raw = decode(data.get("data"))
    with tempfile.TemporaryDirectory(prefix="localchat-voice-") as tmp:
        source, wave, result = (Path(tmp) / n for n in ("recording", "audio.wav", "result"))
        source.write_bytes(raw)
        container = ("matroska" if raw.startswith(b"\x1a\x45\xdf\xa3")
                     else "mov" if raw[4:8] == b"ftyp"
                     else "wav" if raw.startswith(b"RIFF") and raw[8:12] == b"WAVE" else "")
        if not container:
            raise ValueError("Поддерживается запись браузера в WebM, MP4 или WAV.")
        run([program("ffmpeg"), "-nostdin", "-loglevel", "error", "-protocol_whitelist",
             "file,pipe", "-f", container, "-i", str(source),
             "-t", "60", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wave)], 25)
        run([program("whisper-cli"), "-m", str(whisper_model()), "-f", str(wave),
             "-l", "auto", "-otxt", "-of", str(result), "-nt", "-np"], 100)
        return {"text": result.with_suffix(".txt").read_text(encoding="utf-8").strip()}
