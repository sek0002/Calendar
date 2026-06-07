# MUUC Calendar Pipeline

This project pulls MUUC TeamApp event data starting from 2026, stores it in SQLite, exposes it as JSON on localhost, and provides a static interactive calendar page that can be hosted on GitHub Pages.

## Setup

Create a local `.env` file from the example:

```sh
cp .env.example .env
```

Then edit `.env` and set `TEAMAPP_COOKIE` to the full TeamApp `Cookie` header value. The real `.env` file is ignored by git.

The script uses only the Python standard library and loads `.env` automatically.

## Ingest

Cron-friendly command:

```sh
cd /Users/sekkevin/LocalR/Calendar
python3 calendar_pipeline.py ingest --year 2026
```

`--year 2026` means “keep events from `2026-01-01` onward.” Future years are included when TeamApp exposes them.

The ingest command fetches only:

- past events page 1
- current/future events
- matching image list payloads

Rows are upserted by `event_id`, so repeated runs append/update without duplicates.

To seed the database from the existing CSV:

```sh
python3 calendar_pipeline.py import-csv events.csv --year 2026
```

Example crontab entry for hourly refresh:

```cron
0 * * * * cd /Users/sekkevin/LocalR/Calendar && python3 calendar_pipeline.py ingest --year 2026 >> cron.log 2>&1
```

## Local JSON API

```sh
python3 calendar_pipeline.py serve --year 2026 --port 8765
```

Endpoints:

- `http://127.0.0.1:8765/health`
- `http://127.0.0.1:8765/events.json?start_year=2026`
- `http://127.0.0.1:8765/events.json?start_year=2026&include_images=1`

The API enables CORS so a GitHub Pages-hosted frontend can read it from the same machine.

## Static GitHub Pages Export

Generate a static JSON snapshot:

```sh
python3 calendar_pipeline.py export-static --year 2026
```

Push the `public/` directory to GitHub Pages. The page tries the local API first and then falls back to `public/data/events.json`.

You can override the backend URL with a query parameter:

```text
https://yourname.github.io/yourrepo/?api=http://127.0.0.1:8765/events.json?start_year=2026
```
