"""collect_snapshot.py / reach_reports.py で共有するヘルパー。"""
import csv
import datetime as dt
import os
import re
from pathlib import Path
from zoneinfo import ZoneInfo

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]

PT = ZoneInfo("America/Los_Angeles")  # Analytics / Reporting の日次集計のタイムゾーン
_DURATION_RE = re.compile(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?")


def chunked(items, size):
    items = list(items)
    for i in range(0, len(items), size):
        yield items[i:i + size]


def parse_duration(iso: str) -> int:
    m = _DURATION_RE.fullmatch(iso or "")
    if not m:
        return 0
    h, mi, s = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + s


def guess_format(item: dict, duration_sec: int) -> str:
    """形式の簡易判定（API の creatorContentType が使えない場合の代替）。
    ライブは liveStreamingDetails の有無で判定。3分以下=short は目安です。"""
    if "liveStreamingDetails" in item:
        return "live"
    if duration_sec <= 180:
        return "short"
    if duration_sec <= 12 * 60:
        return "mid"
    return "long"


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def pt_date(iso_ts: str) -> dt.date:
    """UTC の ISO タイムスタンプを、Analytics/Reporting の集計単位である太平洋時間の日付に変換。"""
    t = dt.datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    return t.astimezone(PT).date()


def write_csv(path: Path, rows: list, fieldnames: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as f:  # Excel でも文字化けしにくい BOM 付き
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"  wrote {path} ({len(rows)} rows)")


def build_credentials() -> Credentials:
    return Credentials(
        token=None,
        refresh_token=os.environ["YT_REFRESH_TOKEN"],
        client_id=os.environ["YT_CLIENT_ID"],
        client_secret=os.environ["YT_CLIENT_SECRET"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=SCOPES,
    )


def build_services():
    """youtube (Data API v3) / youtubeAnalytics (Analytics API v2) /
    youtubereporting (Reporting API v1、バルクレポート) の3サービスを返す。"""
    creds = build_credentials()
    data = build("youtube", "v3", credentials=creds, cache_discovery=False)
    analytics = build("youtubeAnalytics", "v2", credentials=creds, cache_discovery=False)
    reporting = build("youtubereporting", "v1", credentials=creds, cache_discovery=False)
    return data, analytics, reporting
