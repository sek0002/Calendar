#!/usr/bin/env bash
set -euo pipefail

cd /opt/calendar

git fetch origin main
git reset --hard origin/main

node scripts/update-teamapp-cookie.mjs
python3 calendar_pipeline.py --year 2026 ingest
python3 calendar_pipeline.py --year 2026 export-static

systemctl restart muuc-calendar
