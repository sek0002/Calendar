#!/usr/bin/env python3
"""MUUC TeamApp calendar ingestion, storage, JSON API, and static export."""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


CLUB_ID = "132307"
DEFAULT_START_YEAR = dt.date.today().year
DEFAULT_DB = Path(__file__).with_name("calendar.db")
DEFAULT_STATIC_EXPORT = Path(__file__).with_name("public").joinpath("data", "events.json")
DEFAULT_ENV = Path(__file__).with_name(".env")

PAST_CSV_URL = "https://muuc.teamapp.com/events/past.json?_csv_data=v1&page=1"
PAST_IMG_URL = "https://muuc.teamapp.com/events/past.json?_img_data=v1&page=1"
FUTURE_CSV_URL = f"https://muuc.teamapp.com/clubs/{CLUB_ID}/events.json?_csv_data=v1"
FUTURE_IMG_URL = f"https://muuc.teamapp.com/clubs/{CLUB_ID}/events.json?_img_data=v1"
MAX_FUTURE_PAGES = 20
HERO_SPOTLIGHT_LIMIT = 5
EXCLUDED_TITLE_EXACT = {"committee meeting"}
EXCLUDED_TITLE_SUBSTRINGS = ("expiry",)
HIDDEN_HERO_TITLE_EXACT = {"computer nitrox course with instructor minh"}
HIDDEN_HERO_TITLE_PATTERNS = (re.compile(r"\btemplate\b", re.I),)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?:\+?\d[\d\s()./\-]{7,}\d)")
HIDDEN_FIELD_RE = re.compile(r"leader\s*phone|secondary\s*number", re.I)
HEALTH_SAFETY_RE = re.compile(r"\bhealth\b.*\bsafety\b", re.I)
NEXT_SECTION_RE = re.compile(
    r"^(trip organiser checklist|trip organizer checklist|trip organiser check list|trip info|trip details|dive sites\s*/\s*itinerary|participation requirements|gear hire policy|trip organiser checklist)\b",
    re.I,
)
KNOWN_SECTION_TITLES = (
    "trip organiser checklist",
    "trip organizer checklist",
    "trip organiser check list",
    "trip info",
    "trip details",
    "dive sites / itinerary",
    "itinerary",
    "participation requirements",
    "gear hire policy",
)
SECTION_HEADER_RE = re.compile(r"^\*{1,2}\s*(.*?)\s*\*{1,2}$")
HEADING_FIELD_RE = re.compile(r"\*\*([^*]+)\*\*\s*:\s*(.*)")
FIELD_RE = re.compile(r"(?i)^\s*([A-Za-z][\w ./'&()-]+?)\s*:\s*(.+?)\s*$")


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat()


def load_env_file(path: Path = DEFAULT_ENV) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


def make_headers() -> dict[str, str]:
    cookie = os.environ.get("TEAMAPP_COOKIE", "").strip()
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; MUUCCalendarBot/1.0)",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-AU,en;q=0.9",
        "Cache-Control": "no-cache",
    }
    if cookie:
        headers["Cookie"] = cookie
    return headers


def fetch_json(url: str, headers: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"GET {url} failed with HTTP {exc.code}: {detail}") from exc
    return json.loads(body.decode("utf-8"))


def csv_url_to_image_url(url: str) -> str:
    return url.replace("_csv_data=v1", "_img_data=v1")


def fetch_future_csv_pages(headers: dict[str, str]) -> list[tuple[int, str, dict[str, Any]]]:
    pages = []
    next_url: str | None = FUTURE_CSV_URL
    page = 1
    while next_url and page <= MAX_FUTURE_PAGES:
        payload = fetch_json(next_url, headers)
        pages.append((page, next_url, payload))
        next_url = payload.get("nextPageUrl")
        page += 1
    return pages


def download_bytes(url: str, headers: dict[str, str]) -> tuple[bytes | None, str | None]:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read(), response.headers.get("content-type")
    except Exception:
        return None, None


def image_dimensions(url: str) -> tuple[int, int]:
    params = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    try:
        width = int(params.get("w", ["0"])[0])
        height = int(params.get("h", ["0"])[0])
    except ValueError:
        return 0, 0
    return width, height


def find_event_image_urls(value: Any) -> list[str]:
    urls: list[str] = []
    if isinstance(value, str) and "image-assets.teamapp.com/uploads/images/" in value:
        urls.append(value)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key in {"navMenu", "bgImage"}:
                continue
            urls.extend(find_event_image_urls(item))
    elif isinstance(value, list):
        for item in value:
            urls.extend(find_event_image_urls(item))
    return urls


def best_event_image_url(detail_payload: dict[str, Any]) -> str | None:
    urls = find_event_image_urls(detail_payload.get("components", []))
    if not urls:
        return None
    return max(urls, key=lambda url: image_dimensions(url)[0] * image_dimensions(url)[1])


def fetch_detail_image_url(detail_url: str | None, headers: dict[str, str]) -> str | None:
    if not detail_url:
        return None
    try:
        payload = fetch_json(detail_url, headers)
    except Exception:
        return None
    return best_event_image_url(payload)


def event_date(event: dict[str, Any]) -> dt.date | None:
    value = event.get("start_date") or event.get("date")
    if not value:
        return None
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def starts_on_or_after(event: dict[str, Any], start_year: int) -> bool:
    date = event_date(event)
    return date is not None and date >= dt.date(start_year, 1, 1)


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def is_divider_line(line: str) -> bool:
    cleaned = line.strip()
    return bool(cleaned) and all(char in {"-", "—", "–", "―", "_", " "} for char in cleaned) and len(cleaned) >= 2


def normalize_section_title(value: str) -> str:
    cleaned = re.sub(r"^\*{1,3}\s*|\s*\*{1,3}$", "", value.strip())
    cleaned = re.sub(r"^#+\s*", "", cleaned)
    return cleaned.strip(" :")


def is_known_section_title(value: str) -> bool:
    title = normalize_section_title(value).lower()
    return title in KNOWN_SECTION_TITLES


def extract_section_title(line: str) -> str | None:
    if is_known_section_title(line):
        return normalize_section_title(line)
    markdown = SECTION_HEADER_RE.fullmatch(line)
    if markdown and is_known_section_title(markdown.group(1)):
        return normalize_section_title(markdown.group(1))
    return None


def parse_description(description: str) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    pending_heading: str | None = None

    def ensure_section(title: str = "Details") -> dict[str, Any]:
        nonlocal current
        if current is None:
            current = {"title": title, "body": [], "fields": []}
            sections.append(current)
        return current

    for raw_line in description.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        if is_divider_line(line):
            continue

        section_title = extract_section_title(line)
        heading_match = section_title is not None
        field_match = HEADING_FIELD_RE.fullmatch(line)
        if not field_match and ":" in line and not heading_match:
            field_match = FIELD_RE.fullmatch(line) if ":" in line else None

        if field_match:
            section = ensure_section(pending_heading or "Details")
            pending_heading = None
            label = field_match.group(1).strip()
            value = field_match.group(2).strip()
            section["fields"].append({"label": label, "value": value})
            continue

        if heading_match:
            title = section_title
            if title is None:
                continue
            title = normalize_section_title(title)
            if len(title) > 60:
                section = ensure_section(pending_heading or "Details")
                pending_heading = None
                section["body"].append(re.sub(r"\*\*([^*]+)\*\*", r"\1", line))
                continue
            current = {"title": title, "body": [], "fields": []}
            sections.append(current)
            pending_heading = title
            continue

        section = ensure_section(pending_heading or "Details")
        pending_heading = None
        section["body"].append(re.sub(r"\*\*([^*]+)\*\*", r"\1", line))

    return [
        section
        for section in sections
        if section["body"] or section["fields"]
    ]


def strip_markdown(value: str) -> str:
    return re.sub(r"[*_`#]", "", str(value or "")).strip()


def sanitize_sensitive_text(value: str | None) -> str:
    return PHONE_RE.sub("[redacted phone]", EMAIL_RE.sub("[redacted email]", str(value or "")))


def is_hidden_field_label(label: str | None) -> bool:
    return bool(HIDDEN_FIELD_RE.search(strip_markdown(label or "")))


def is_health_safety_heading(value: str | None) -> bool:
    return bool(HEALTH_SAFETY_RE.search(strip_markdown(value or "")))


def sanitize_description_lines(lines: list[str]) -> list[str]:
    sanitized: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        cleaned = strip_markdown(line)
        if is_health_safety_heading(cleaned):
            if sanitized and is_divider_line(strip_markdown(sanitized[-1])):
                sanitized.pop()
            index += 1
            while index < len(lines):
                current = strip_markdown(lines[index])
                next_line = strip_markdown(lines[index + 1]) if index + 1 < len(lines) else ""
                after_next = strip_markdown(lines[index + 2]) if index + 2 < len(lines) else ""
                if is_divider_line(current) and next_line and is_divider_line(after_next):
                    index -= 1
                    break
                if NEXT_SECTION_RE.search(current):
                    index -= 1
                    break
                index += 1
            index += 1
            continue
        if not is_hidden_field_label(line):
            sanitized.append(sanitize_sensitive_text(line))
        index += 1
    return sanitized


def sanitize_description(description: str) -> str:
    lines = description.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\r\n".join(sanitize_description_lines(lines)).strip()


def sanitize_description_sections(sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sanitized_sections: list[dict[str, Any]] = []
    for section in sections:
        if is_health_safety_heading(section.get("title")):
            continue
        sanitized_section = {
            **section,
            "title": sanitize_sensitive_text(section.get("title")),
            "fields": [
                {
                    **field,
                    "label": sanitize_sensitive_text(field.get("label")),
                    "value": sanitize_sensitive_text(field.get("value")),
                }
                for field in section.get("fields", [])
                if not is_hidden_field_label(field.get("label"))
            ],
            "body": sanitize_description_lines(section.get("body", [])),
        }
        if sanitized_section["body"] or sanitized_section["fields"]:
            sanitized_sections.append(sanitized_section)
    return sanitized_sections


def sanitize_event(event: dict[str, Any]) -> dict[str, Any]:
    event["event_name"] = sanitize_sensitive_text(event.get("event_name"))
    event["title"] = sanitize_sensitive_text(event.get("title"))
    event["description"] = sanitize_description(event.get("description") or "")
    event["description_sections"] = sanitize_description_sections(parse_description(event["description"]))
    return event


def connect(db_path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with connect(db_path) as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
                event_id INTEGER PRIMARY KEY,
                event_name TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT,
                start_time TEXT,
                end_time TEXT,
                description TEXT NOT NULL DEFAULT '',
                location_json TEXT,
                rsvp_json TEXT,
                source TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS event_images (
                event_id INTEGER PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
                image_url TEXT NOT NULL,
                image_blob BLOB,
                content_type TEXT,
                image_payload_json TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS raw_payloads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            """
        )


def extract_image_items(payload: dict[str, Any]) -> dict[int, dict[str, Any]]:
    items: dict[int, dict[str, Any]] = {}
    for section in payload.get("sections", []):
        for item in section.get("items", []):
            event_id = item.get("id")
            image_url = item.get("image")
            if isinstance(event_id, int) and isinstance(image_url, str) and image_url:
                items[event_id] = item
    return items


def upsert_events(
    con: sqlite3.Connection,
    events: list[dict[str, Any]],
    image_items: dict[int, dict[str, Any]],
    source: str,
    start_year: int,
    headers: dict[str, str],
    fetch_images: bool,
) -> tuple[int, int]:
    now = utc_now()
    event_count = 0
    image_count = 0
    for event in events:
        if not starts_on_or_after(event, start_year):
            continue
        event_id = event.get("reference_id") or event.get("event_id") or event.get("id")
        if event_id is None:
            continue
        event_id = int(event_id)
        con.execute(
            """
            INSERT INTO events (
                event_id, event_name, start_date, end_date, start_time, end_time,
                description, location_json, rsvp_json, source, raw_json,
                first_seen_at, last_seen_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(event_id) DO UPDATE SET
                event_name = excluded.event_name,
                start_date = excluded.start_date,
                end_date = excluded.end_date,
                start_time = excluded.start_time,
                end_time = excluded.end_time,
                description = excluded.description,
                location_json = excluded.location_json,
                rsvp_json = excluded.rsvp_json,
                source = excluded.source,
                raw_json = excluded.raw_json,
                last_seen_at = excluded.last_seen_at
            """,
            (
                event_id,
                str(event.get("event_name") or event.get("title") or "").strip(),
                str(event.get("start_date") or ""),
                event.get("end_date"),
                event.get("start_time"),
                event.get("end_time"),
                str(event.get("description") or ""),
                compact_json(event.get("location")),
                compact_json(event.get("rsvp")),
                source,
                compact_json(event),
                now,
                now,
            ),
        )
        event_count += 1

        image_item = image_items.get(event_id)
        if image_item:
            detail_image_url = fetch_detail_image_url(image_item.get("url"), headers)
            image_url = detail_image_url or image_item["image"]
            image_item = {**image_item, "selected_image": image_url}
            image_blob, content_type = (None, None)
            if fetch_images:
                image_blob, content_type = download_bytes(image_url, headers)
            con.execute(
                """
                INSERT INTO event_images (
                    event_id, image_url, image_blob, content_type, image_payload_json,
                    first_seen_at, last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(event_id) DO UPDATE SET
                    image_url = excluded.image_url,
                    image_blob = COALESCE(excluded.image_blob, event_images.image_blob),
                    content_type = COALESCE(excluded.content_type, event_images.content_type),
                    image_payload_json = excluded.image_payload_json,
                    last_seen_at = excluded.last_seen_at
                """,
                (
                    event_id,
                    image_url,
                    image_blob,
                    content_type,
                    compact_json(image_item),
                    now,
                    now,
                ),
            )
            image_count += 1
    return event_count, image_count


def ingest(db_path: Path, start_year: int, fetch_images: bool) -> dict[str, Any]:
    init_db(db_path)
    headers = make_headers()
    summary = {
        "db": str(db_path),
        "start_year": start_year,
        "starts_on_or_after": f"{start_year}-01-01",
        "sources": [],
        "events_upserted": 0,
        "images_upserted": 0,
    }
    with connect(db_path) as con:
        sources: list[tuple[str, dict[str, Any], dict[str, Any]]] = []

        past_csv_payload = fetch_json(PAST_CSV_URL, headers)
        past_img_payload = fetch_json(PAST_IMG_URL, headers)
        sources.append(("past_page_1", past_csv_payload, past_img_payload))

        for page, csv_url, csv_payload in fetch_future_csv_pages(headers):
            img_payload = fetch_json(csv_url_to_image_url(csv_url), headers)
            sources.append((f"future_page_{page}", csv_payload, img_payload))

        for source, csv_payload, img_payload in sources:
            con.execute(
                "INSERT INTO raw_payloads(source, fetched_at, payload_json) VALUES (?, ?, ?)",
                (source + "_csv", utc_now(), compact_json(csv_payload)),
            )
            con.execute(
                "INSERT INTO raw_payloads(source, fetched_at, payload_json) VALUES (?, ?, ?)",
                (source + "_img", utc_now(), compact_json(img_payload)),
            )
            image_items = extract_image_items(img_payload)
            events = csv_payload.get("data") or []
            event_count, image_count = upsert_events(con, events, image_items, source, start_year, headers, fetch_images)
            summary["sources"].append(
                {
                    "source": source,
                    "fetched_rows": len(events),
                    "image_items": len(image_items),
                    "events_upserted": event_count,
                    "images_upserted": image_count,
                }
            )
            summary["events_upserted"] += event_count
            summary["images_upserted"] += image_count
    return summary


def import_csv(db_path: Path, csv_path: Path, start_year: int) -> dict[str, Any]:
    init_db(db_path)
    count = 0
    now = utc_now()
    with csv_path.open(newline="", encoding="utf-8") as handle, connect(db_path) as con:
        for row in csv.DictReader(handle):
            if not starts_on_or_after(row, start_year):
                continue
            event_id = int(row["event_id"])
            raw = {
                "reference_id": event_id,
                "event_name": row["event_name"],
                "start_date": row["date"],
                "description": row["description"],
            }
            cursor = con.execute(
                """
                INSERT INTO events (
                    event_id, event_name, start_date, description, source, raw_json,
                    first_seen_at, last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(event_id) DO NOTHING
                """,
                (event_id, row["event_name"], row["date"], row["description"], "csv_import", compact_json(raw), now, now),
            )
            count += max(cursor.rowcount, 0)
    return {
        "db": str(db_path),
        "csv": str(csv_path),
        "start_year": start_year,
        "starts_on_or_after": f"{start_year}-01-01",
        "inserted": count,
    }


def rows_to_events(rows: list[sqlite3.Row], include_images: bool) -> list[dict[str, Any]]:
    events = []
    for row in rows:
        event = {
            "event_id": row["event_id"],
            "event_name": row["event_name"],
            "title": row["event_name"],
            "date": row["start_date"],
            "start_date": row["start_date"],
            "end_date": row["end_date"],
            "start_time": row["start_time"],
            "end_time": row["end_time"],
            "description": row["description"],
            "description_sections": parse_description(row["description"] or ""),
            "source": row["source"],
            "teamapp_url": f"https://muuc.teamapp.com/clubs/{CLUB_ID}/events/{row['event_id']}",
            "last_seen_at": row["last_seen_at"],
            "image_url": row["image_url"],
            "image_content_type": row["content_type"],
            "has_image_blob": bool(row["image_blob"]),
        }
        if include_images and row["image_blob"]:
            encoded = base64.b64encode(row["image_blob"]).decode("ascii")
            event["image_data_url"] = f"data:{row['content_type'] or 'image/jpeg'};base64,{encoded}"
        events.append(sanitize_event(event))
    return events


def is_excluded_title(title: str) -> bool:
    lowered = title.strip().lower()
    return lowered in EXCLUDED_TITLE_EXACT or any(substring in lowered for substring in EXCLUDED_TITLE_SUBSTRINGS)


def is_club_meeting(title: str) -> bool:
    return bool(re.match(r"^(weekly\s+)?club meeting\b", title.strip(), re.I))


def is_hidden_hero_title(title: str) -> bool:
    lowered = title.strip().lower()
    return lowered in HIDDEN_HERO_TITLE_EXACT or any(pattern.search(title) for pattern in HIDDEN_HERO_TITLE_PATTERNS)


def build_hero_spotlight_events(events: list[dict[str, Any]], today: dt.date | None = None) -> list[dict[str, Any]]:
    today = today or dt.datetime.now().date()
    hero_eligible = [
        event
        for event in events
        if not is_club_meeting(event.get("event_name", "")) and not is_hidden_hero_title(event.get("event_name", ""))
    ]
    future = sorted(
        [event for event in hero_eligible if (date := event_date(event)) is not None and date >= today],
        key=lambda event: (event["date"], event.get("start_time") or "", event["event_name"]),
    )
    recently_passed = sorted(
        [event for event in hero_eligible if (date := event_date(event)) is not None and date < today],
        key=lambda event: (event["date"], event.get("start_time") or "", event["event_name"]),
        reverse=True,
    )
    return [*future, *recently_passed][:HERO_SPOTLIGHT_LIMIT]


def query_events(db_path: Path, start_year: int = DEFAULT_START_YEAR, include_images: bool = False) -> dict[str, Any]:
    init_db(db_path)
    with connect(db_path) as con:
        rows = con.execute(
            """
            SELECT e.*, i.image_url, i.content_type, i.image_blob
            FROM events e
            LEFT JOIN event_images i ON i.event_id = e.event_id
            WHERE e.start_date >= ?
            ORDER BY e.start_date, e.start_time, e.event_name
            """,
            (f"{start_year}-01-01",),
        ).fetchall()
    events = [
        event
        for event in rows_to_events(rows, include_images)
        if not is_excluded_title(event["event_name"])
    ]
    generated_at = utc_now()
    return {
        "generated_at": generated_at,
        "start_year": start_year,
        "starts_on_or_after": f"{start_year}-01-01",
        "count": len(events),
        "hero_spotlight_events": build_hero_spotlight_events(events),
        "events": events,
    }


def export_static(db_path: Path, output_path: Path, start_year: int, include_images: bool) -> dict[str, Any]:
    data = query_events(db_path, start_year, include_images)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"output": str(output_path), "count": data["count"], "start_year": start_year}


class CalendarHandler(BaseHTTPRequestHandler):
    db_path: Path = DEFAULT_DB
    start_year: int = DEFAULT_START_YEAR

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/health":
            self.send_json({"ok": True, "time": utc_now()})
            return
        if parsed.path in {"/", "/events", "/events.json"}:
            start_year = int(params.get("start_year", params.get("year", [self.start_year]))[0])
            include_images = params.get("include_images", ["0"])[0] in {"1", "true", "yes"}
            self.send_json(query_events(self.db_path, start_year, include_images))
            return
        match = re.fullmatch(r"/events/(\d+)", parsed.path)
        if match:
            event_id = int(match.group(1))
            data = query_events(self.db_path, self.start_year, include_images=True)
            for event in data["events"]:
                if event["event_id"] == event_id:
                    self.send_json(event)
                    return
            self.send_json({"error": "event not found"}, HTTPStatus.NOT_FOUND)
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)


def serve(db_path: Path, host: str, port: int, start_year: int) -> None:
    handler = type("ConfiguredCalendarHandler", (CalendarHandler,), {"db_path": db_path, "start_year": start_year})
    server = ThreadingHTTPServer((host, port), handler)
    print(f"Serving {db_path} on http://{host}:{port}/events.json?start_year={start_year}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server", flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite database path.")
    parser.add_argument(
        "--year",
        "--start-year",
        dest="year",
        type=int,
        default=DEFAULT_START_YEAR,
        help="Starting year to keep; includes all future events with no end date.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest_parser = subparsers.add_parser("ingest", help="Fetch page 1 + future events and upsert into SQLite.")
    ingest_parser.add_argument(
        "--year",
        "--start-year",
        dest="year",
        type=int,
        default=argparse.SUPPRESS,
        help="Starting year to keep; includes all future events with no end date.",
    )
    ingest_parser.add_argument("--skip-image-downloads", action="store_true", help="Store image URLs/payloads only.")

    import_parser = subparsers.add_parser("import-csv", help="Seed the database from an existing events.csv.")
    import_parser.add_argument(
        "--year",
        "--start-year",
        dest="year",
        type=int,
        default=argparse.SUPPRESS,
        help="Starting year to keep; includes all future events with no end date.",
    )
    import_parser.add_argument("csv_path", type=Path)

    export_parser = subparsers.add_parser("export-static", help="Write public/data/events.json for GitHub Pages.")
    export_parser.add_argument(
        "--year",
        "--start-year",
        dest="year",
        type=int,
        default=argparse.SUPPRESS,
        help="Starting year to keep; includes all future events with no end date.",
    )
    export_parser.add_argument("--output", type=Path, default=DEFAULT_STATIC_EXPORT)
    export_parser.add_argument("--include-image-data", action="store_true", help="Embed image blobs as data URLs.")

    serve_parser = subparsers.add_parser("serve", help="Expose JSON API on localhost.")
    serve_parser.add_argument(
        "--year",
        "--start-year",
        dest="year",
        type=int,
        default=argparse.SUPPRESS,
        help="Starting year to keep; includes all future events with no end date.",
    )
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8765)

    show_parser = subparsers.add_parser("show", help="Print current JSON to stdout.")
    show_parser.add_argument(
        "--year",
        "--start-year",
        dest="year",
        type=int,
        default=argparse.SUPPRESS,
        help="Starting year to keep; includes all future events with no end date.",
    )
    return parser.parse_args()


def main() -> int:
    load_env_file()
    args = parse_args()
    started = time.time()
    if args.command == "ingest":
        result = ingest(args.db, args.year, fetch_images=not args.skip_image_downloads)
    elif args.command == "import-csv":
        result = import_csv(args.db, args.csv_path, args.year)
    elif args.command == "export-static":
        result = export_static(args.db, args.output, args.year, args.include_image_data)
    elif args.command == "serve":
        serve(args.db, args.host, args.port, args.year)
        return 0
    elif args.command == "show":
        print(json.dumps(query_events(args.db, args.year), ensure_ascii=False, indent=2))
        return 0
    else:
        raise AssertionError(args.command)
    result["elapsed_seconds"] = round(time.time() - started, 2)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
