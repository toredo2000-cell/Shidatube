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
    # 2026-09-26時点、下記スコープは一時的に外している。
    #
    # 広告収益（estimatedRevenue等）の取得に必要な scope だが、追加した際に
    # auth_setup.py を再実行して YT_REFRESH_TOKEN を発行し直すのを忘れており、
    # 既存のリフレッシュトークンがこの scope を含まないまま日次収集ジョブが
    # 実行され続けた結果、Credentials のリフレッシュ自体が invalid_scope で
    # 拒否され、日次データ取得が全滅する障害が発生した（このコメントの追加は
    # その場しのぎの復旧）。
    #
    # 広告収益データを再び取得したくなったら、以下の手順で復旧すること:
    #   1. 志田さんご本人に、Miyoさんのアカウントへ YouTube Studio の
    #      「財務データの表示」権限を付与してもらう。
    #   2. この行のコメントアウトを外す。
    #   3. auth_setup.py をローカルで再実行し、新しい YT_REFRESH_TOKEN を発行、
    #      GitHub Secrets の YT_REFRESH_TOKEN を新しい値に更新する
    #      （既存のリフレッシュトークンには新しい scope が自動追加されないため、
    #      再認可を飛ばすと今回と同じ invalid_scope 障害が再発する）。
    # "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
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
