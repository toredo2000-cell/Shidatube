"""サムネイル・インプレッション / インプレッションCTR の自動取得。

YouTube Studio の画面にしかないと思われがちだが、Analytics API とは別の
「YouTube Reporting API」（バルクレポート用）に channel_reach_basic_* という
システム管理レポートがあり、動画別・日別のインプレッション数とインプレッション
CTR（video_thumbnail_impressions / video_thumbnail_impressions_ctr）が含まれる。
追加のスコープ authorize は不要（yt-analytics.readonly で足りる）。

仕組み:
  1. reportTypes.list() で channel_reach_basic_* の最新版レポートタイプ ID を探す
  2. jobs.list() に該当ジョブが無ければ jobs.create() で作成
     （作成した日から過去30日分もさかのぼって生成される。以後は毎日自動生成）
  3. jobs.reports.list() で生成済みレポート（1日1件、CSV）を確認し、
     まだ持っていないものだけを downloadUrl から取得
  4. 生の CSV は data/_reach_raw/ にキャッシュ（同じレポートを取り直さないため）
  5. 直近 LOOKBACK_DAYS 分を集計し、動画ごとの合計インプレッションと
     加重平均CTRを返す（summary への統合用）

注意:
  * レポートは太平洋時間の日次で生成され、ジョブ作成後 最大48時間 は
    データが出てこない（Google 公式の説明）。運用開始直後の数日は空になる。
  * ジョブは一度作れば以後放置でよい（このスクリプトが毎回自動で存在確認する）。
"""
import csv
import gzip
import io
import sys
from pathlib import Path

from google.auth.transport.requests import AuthorizedSession
from googleapiclient.errors import HttpError

import yt_common as yc

REPORT_TYPE_PREFIX = "channel_reach_basic"
RAW_DIR_NAME = "_reach_raw"
JOB_NAME = "shidatube_channel_reach"


def _latest_report_type_id(reporting) -> str | None:
    """channel_reach_basic_a1 / a2 ... のうち、最新版の reportTypeId を返す。"""
    try:
        resp = reporting.reportTypes().list(includeSystemManaged=True).execute()
    except HttpError as e:
        print(f"  [WARN] reportTypes.list 失敗: HTTP {e.resp.status} {e}", file=sys.stderr)
        return None
    candidates = [t["id"] for t in resp.get("reportTypes", [])
                  if t["id"].startswith(REPORT_TYPE_PREFIX) and not t.get("deprecateTime")]
    return sorted(candidates)[-1] if candidates else None


def _ensure_job(reporting) -> str | None:
    """既存ジョブがあれば再利用し、無ければ新規作成してジョブ ID を返す。"""
    rt_id = _latest_report_type_id(reporting)
    if not rt_id:
        print(f"  [WARN] {REPORT_TYPE_PREFIX}* レポートタイプが見つかりません"
              "（アカウントで Reporting API が使えない可能性があります）", file=sys.stderr)
        return None

    try:
        jobs = reporting.jobs().list(includeSystemManaged=True).execute().get("jobs", [])
    except HttpError as e:
        print(f"  [WARN] jobs.list 失敗: HTTP {e.resp.status} {e}", file=sys.stderr)
        return None

    for j in jobs:
        if j.get("reportTypeId", "").startswith(REPORT_TYPE_PREFIX):
            return j["id"]

    try:
        job = reporting.jobs().create(
            body={"reportTypeId": rt_id, "name": JOB_NAME}).execute()
    except HttpError as e:
        print(f"  [WARN] jobs.create 失敗: HTTP {e.resp.status} {e}", file=sys.stderr)
        return None
    print(f"  レポートジョブを新規作成しました（{rt_id}）。"
          "データが出そろうまで最大48時間かかります。")
    return job["id"]


def _download_new_reports(reporting, job_id: str, raw_dir: Path) -> list:
    """未取得のレポートを downloadUrl から取得し、raw_dir に CSV としてキャッシュ。
    戻り値は今回・過去分すべて含む、raw_dir にある全 CSV のパス一覧。"""
    raw_dir.mkdir(parents=True, exist_ok=True)
    try:
        reports = reporting.jobs().reports().list(jobId=job_id).execute().get("reports", [])
    except HttpError as e:
        print(f"  [WARN] jobs.reports.list 失敗: HTTP {e.resp.status} {e}", file=sys.stderr)
        reports = []

    session = AuthorizedSession(yc.build_credentials())
    new_count = 0
    for r in reports:
        dest = raw_dir / f"{r['id']}.csv"
        if dest.exists():
            continue
        resp = session.get(r["downloadUrl"])
        if resp.status_code != 200:
            print(f"  [WARN] レポート {r['id']} のダウンロード失敗: HTTP {resp.status_code}",
                  file=sys.stderr)
            continue
        raw = resp.content
        if raw[:2] == b"\x1f\x8b":  # gzip の場合があるため展開
            raw = gzip.decompress(raw)
        dest.write_bytes(raw)
        new_count += 1
    if new_count:
        print(f"  新規レポート {new_count} 件をダウンロードしました")
    return sorted(raw_dir.glob("*.csv"))


def sync_and_aggregate(reporting, out_dir: Path, out_root: Path,
                        lookback_start, lookback_end) -> tuple[list, dict]:
    """レポートを最新化し、[lookback_start, lookback_end] の日次行と、
    動画ごとの集計（合計インプレッション・加重平均CTR）を返す。
    取得できない場合は ([], {}) を返し、呼び出し側は空欄のまま続行する。"""
    job_id = _ensure_job(reporting)
    if not job_id:
        return [], {}

    csv_paths = _download_new_reports(reporting, job_id, out_root / RAW_DIR_NAME)
    if not csv_paths:
        print("  [INFO] レポートはまだ生成されていません（ジョブ作成直後は最大48時間かかります）")
        return [], {}

    daily_rows, totals = [], {}
    seen = set()  # (video_id, date) の重複除去用（レポート期間が重なることがある）
    for path in csv_paths:
        with path.open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                d = row.get("date", "")
                if not (lookback_start.isoformat() <= d <= lookback_end.isoformat()):
                    continue
                vid = row.get("video_id", "")
                key = (vid, d)
                if not vid or key in seen:
                    continue
                seen.add(key)
                impressions = yc.num(row.get("video_thumbnail_impressions")) or 0
                ctr = yc.num(row.get("video_thumbnail_impressions_ctr"))
                daily_rows.append({
                    "date": d, "video_id": vid,
                    "thumbnail_impressions": impressions,
                    "thumbnail_ctr": ctr,
                })
                t = totals.setdefault(vid, {"impressions": 0.0, "weighted_ctr_sum": 0.0})
                t["impressions"] += impressions
                if ctr is not None:
                    t["weighted_ctr_sum"] += impressions * ctr

    summary = {
        vid: {
            "thumbnail_impressions": round(t["impressions"]),
            "thumbnail_ctr": round(t["weighted_ctr_sum"] / t["impressions"], 4)
                             if t["impressions"] else "",
        }
        for vid, t in totals.items()
    }
    daily_rows.sort(key=lambda r: (r["video_id"], r["date"]))
    return daily_rows, summary
