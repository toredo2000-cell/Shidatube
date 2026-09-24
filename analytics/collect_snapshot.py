"""Shidatube 日次スナップショット取得。

取得内容:
  [Data API]      自チャンネル＋競合の チャンネル統計 / 直近動画の再生数・高評価・コメント数
  [Analytics API] 自チャンネルの
      - 日別推移 / 動画別 / 流入元 / 国別 / 年齢・性別 / 検索語 / 関連動画経由
      - 形式別（Shorts・通常・ライブ）の推移、登録者と非登録者の視聴比率
      - 動画ごとの公開後の伸び方（公開日〜28日の日次）
      - 動画ごとの維持率曲線
      - 日別の広告収益・CPM（yt-analytics-monetary.readonly scope が必要。未許可の
        場合はこのレポートだけ [WARN] を出してスキップし、他の取得は継続する）
      - 日別×流入元（insightTrafficSourceType）の視聴回数・視聴時間。
        ADVERTISING の行が、Google広告経由の視聴回数・視聴時間にあたる
        （出稿していない期間はその日の行自体が存在しないか0件になる）。
        events.csv に type=ad_campaign で出稿期間を記録しておくと、週次/月次
        レポート側でこの日別データと突き合わせて「広告流入で伸びた分」と
        「オーガニックな伸び」を切り分けやすくなる。
  [Reporting API] 動画ごとのサムネイル・インプレッション数とインプレッションCTR
      （Studio 画面でしか見えないと思われがちだが、バルクレポートで自動取得できる。
       詳細は reach_reports.py を参照）
  [集計]          own_video_summary.csv
      動画ごとに上記すべてを1行へ統合。週次診断（伸びた/伸びなかった動画の比較）の元データ。

出力: data/YYYY-MM-DD/*.csv

環境変数:
  YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN  auth_setup.py で取得した値（必須）
  SHIDATUBE_CHANNEL_ID   志田さんチャンネルの ID（UC で始まる文字列・必須）
  LOOKBACK_DAYS          Analytics/Reporting の集計期間（既定 28）
  MAX_VIDEOS_PER_CHANNEL チャンネルごとに取得する直近動画数（既定 50）
  MAX_VELOCITY_VIDEOS    公開後の日次推移を取る自チャンネル動画数（既定 60・新しい順）
  MAX_RETENTION_VIDEOS   維持率曲線を取る自チャンネル動画数（既定 20・新しい順）
  COMPETITORS_CSV        競合リスト（既定 competitors.csv）
  OUT_DIR                出力先（既定 data）

注意:
  * Analytics/Reporting の day は米国太平洋時間で集計されます（日本時間とは日付がずれる場合があります）。
  * 直近2日分は集計が確定していないため、期間の終端は「今日の2日前」にしています。
  * dimensions / filters の一部の組み合わせは API 側で未対応の可能性があります。
    その場合は [WARN] を表示して続行し、該当列は空欄になります。
  * インプレッション・CTR のレポートジョブは初回作成から最大48時間、データが出ません。
"""
import datetime as dt
import os
import statistics
import sys
from pathlib import Path

from googleapiclient.errors import HttpError

import yt_common as yc
import reach_reports

OWN_CHANNEL_ID = os.environ.get("SHIDATUBE_CHANNEL_ID", "")
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "28"))
MAX_VIDEOS = int(os.environ.get("MAX_VIDEOS_PER_CHANNEL", "50"))
MAX_VELOCITY_VIDEOS = int(os.environ.get("MAX_VELOCITY_VIDEOS", "60"))
MAX_RETENTION_VIDEOS = int(os.environ.get("MAX_RETENTION_VIDEOS", "20"))
COMPETITORS_CSV = Path(os.environ.get("COMPETITORS_CSV", "competitors.csv"))
OUT_ROOT = Path(os.environ.get("OUT_DIR", "data"))

VELOCITY_DAYS = 28            # 公開日から何日分の日次推移を取るか
CONTENT_TYPE_LOOKBACK = 90    # 形式（Shorts等）判定のために見る期間


def load_competitors() -> list:
    import csv
    if not COMPETITORS_CSV.exists():
        return []
    with COMPETITORS_CSV.open(encoding="utf-8-sig") as f:
        lines = [ln for ln in f if ln.strip() and not ln.lstrip().startswith("#")]
    return list(csv.DictReader(lines))


# ---------------------------------------------------------------- Data API
def fetch_channels(data, channel_ids):
    """チャンネル統計と、アップロード再生リスト ID を取得。"""
    rows, uploads = [], {}
    for chunk in yc.chunked(channel_ids, 50):
        resp = data.channels().list(
            part="snippet,statistics,contentDetails", id=",".join(chunk), maxResults=50
        ).execute()
        for it in resp.get("items", []):
            st = it.get("statistics", {})
            rows.append({
                "channel_id": it["id"],
                "title": it["snippet"]["title"],
                "subscribers": st.get("subscriberCount", ""),  # 非公開設定だと空
                "total_views": st.get("viewCount", ""),
                "video_count": st.get("videoCount", ""),
            })
            uploads[it["id"]] = it["contentDetails"]["relatedPlaylists"]["uploads"]
    return rows, uploads


def fetch_recent_video_ids(data, playlist_id, limit):
    ids, token = [], None
    while len(ids) < limit:
        resp = data.playlistItems().list(
            part="contentDetails", playlistId=playlist_id,
            maxResults=min(50, limit - len(ids)), pageToken=token,
        ).execute()
        ids += [it["contentDetails"]["videoId"] for it in resp.get("items", [])]
        token = resp.get("nextPageToken")
        if not token:
            break
    return ids


def fetch_video_details(data, video_ids, channel_id, label, category, snapshot_date):
    rows = []
    for chunk in yc.chunked(video_ids, 50):
        resp = data.videos().list(
            part="snippet,contentDetails,statistics,liveStreamingDetails",
            id=",".join(chunk), maxResults=50,
        ).execute()
        for it in resp.get("items", []):
            sn, st = it["snippet"], it.get("statistics", {})
            dur = yc.parse_duration(it["contentDetails"].get("duration", ""))
            rows.append({
                "snapshot_date": snapshot_date,
                "channel_id": channel_id,
                "channel_label": label,
                "category": category,
                "video_id": it["id"],
                "title": sn["title"],
                "published_at": sn["publishedAt"],
                "duration_sec": dur,
                "format_guess": yc.guess_format(it, dur),
                "views": st.get("viewCount", ""),
                "likes": st.get("likeCount", ""),
                "comments": st.get("commentCount", ""),
                "url": f"https://www.youtube.com/watch?v={it['id']}",
            })
    return rows


# ---------------------------------------------------------------- Analytics API
def run_report(analytics, name, start, end, **params):
    """1レポートの失敗（権限不足・未対応の組み合わせ等）で全体を止めないよう、警告して続行する。"""
    try:
        resp = analytics.reports().query(
            ids=f"channel=={OWN_CHANNEL_ID}", startDate=start, endDate=end, **params
        ).execute()
    except HttpError as e:
        print(f"  [WARN] Analytics '{name}' 取得失敗: HTTP {e.resp.status} {e}", file=sys.stderr)
        return None
    cols = [c["name"] for c in resp.get("columnHeaders", [])]
    rows = [dict(zip(cols, r)) for r in resp.get("rows", [])]
    return cols, rows


ANALYTICS_REPORTS = {
    "analytics_channel_daily": dict(
        dimensions="day", sort="day",
        metrics="views,estimatedMinutesWatched,averageViewDuration,"
                "subscribersGained,subscribersLost,likes,comments,shares"),
    "analytics_channel_daily_by_type": dict(
        dimensions="day,creatorContentType", sort="day",
        metrics="views,estimatedMinutesWatched,subscribersGained"),
    "analytics_by_video": dict(
        dimensions="video", sort="-views", maxResults=200,
        metrics="views,estimatedMinutesWatched,averageViewDuration,"
                "averageViewPercentage,subscribersGained,likes,comments,shares"),
    "analytics_traffic_source": dict(
        dimensions="insightTrafficSourceType", sort="-views",
        metrics="views,estimatedMinutesWatched"),
    "analytics_search_terms": dict(
        dimensions="insightTrafficSourceDetail", sort="-views", maxResults=25,
        filters="insightTrafficSourceType==YT_SEARCH",
        metrics="views,estimatedMinutesWatched"),
    "analytics_related_sources": dict(
        dimensions="insightTrafficSourceDetail", sort="-views", maxResults=25,
        filters="insightTrafficSourceType==RELATED_VIDEO",
        metrics="views,estimatedMinutesWatched"),
    "analytics_subscribed_status": dict(
        dimensions="subscribedStatus",
        metrics="views,estimatedMinutesWatched"),
    "analytics_country": dict(
        dimensions="country", sort="-views", maxResults=25,
        metrics="views,estimatedMinutesWatched"),
    "analytics_demographics": dict(
        dimensions="ageGroup,gender", sort="ageGroup,gender",
        metrics="viewerPercentage"),
    "analytics_revenue_daily": dict(
        dimensions="day", sort="day",
        metrics="estimatedRevenue,estimatedAdRevenue,grossRevenue,"
                "adImpressions,cpm,playbackBasedCpm"),
    "analytics_traffic_source_daily": dict(
        dimensions="day,insightTrafficSourceType", sort="day",
        metrics="views,estimatedMinutesWatched"),
}


def fetch_content_types(analytics, end):
    """動画ごとの形式（SHORTS / VIDEO_ON_DEMAND / LIVE_STREAM）を API から判定する試み。

    注: creatorContentType は video フィルターとの組み合わせ（400: Invalid value）も、
    video との2次元クエリ（400: The query is not supported）も、いずれも
    YouTube Analytics API では拒否されることを確認済み。creatorContentType は
    channel × day のような集計としてのみ使え、動画単位の内訳には使えない模様。
    そのため常に空を返し、build_summary() 側の簡易判定（duration_sec と
    liveStreamingDetails の有無による heuristic）にすべて委ねる。"""
    return {}


def fetch_subscribed_split(analytics, start, end):
    """動画ごとの、非登録者による視聴の割合を試みる。

    注: video と subscribedStatus の組み合わせは YouTube Analytics API が
    サポートしていない（"The query is not supported" エラーになることを確認済み）。
    そのためチャンネル全体の値（analytics_subscribed_status.csv）のみ取得でき、
    動画単位の内訳は API では取得できない。将来 API が対応した場合のために
    関数は残すが、常に空を返す。"""
    return [], {}


def build_velocity(analytics, own_videos, end):
    """動画ごとの公開後の日次推移と、公開後2日/7日/28日の累計再生数。"""
    metrics = "views,estimatedMinutesWatched,subscribersGained,likes,comments,shares"
    metric_names = metrics.split(",")
    daily_rows, summary = [], {}
    for v in own_videos[:MAX_VELOCITY_VIDEOS]:
        vid, pub = v["video_id"], yc.pt_date(v["published_at"])
        stop = min(end, pub + dt.timedelta(days=VELOCITY_DAYS - 1))
        if pub > stop:  # 公開から2日未満は集計が未確定
            continue
        res = run_report(
            analytics, f"video_daily:{vid}", pub.isoformat(), stop.isoformat(),
            dimensions="day", sort="day", filters=f"video=={vid}", metrics=metrics)
        if res is None:
            continue
        views_by_idx = {}
        for r in res[1]:
            idx = (dt.date.fromisoformat(r["day"]) - pub).days
            daily_rows.append({"video_id": vid, "day": r["day"], "day_index": idx,
                               **{k: r.get(k) for k in metric_names}})
            views_by_idx[idx] = yc.num(r.get("views")) or 0
        observed = (end - pub).days + 1  # 集計済みの日数
        summary[vid] = {
            label: (sum(views_by_idx.get(i, 0) for i in range(n)) if observed >= n else "")
            for label, n in (("views_first2d", 2), ("views_first7d", 7), ("views_first28d", 28))
        }
    return daily_rows, summary


def build_retention(analytics, own_videos, end):
    """動画ごとの維持率曲線と、10% / 50% / 90% 地点の視聴維持率。"""
    curve_rows, summary = [], {}
    for v in own_videos[:MAX_RETENTION_VIDEOS]:
        vid, pub = v["video_id"], yc.pt_date(v["published_at"])
        if pub > end:
            continue
        res = run_report(
            analytics, f"retention:{vid}", pub.isoformat(), end.isoformat(),
            dimensions="elapsedVideoTimeRatio", filters=f"video=={vid}",
            metrics="audienceWatchRatio,relativeRetentionPerformance")
        if res is None or not res[1]:
            continue
        rows = sorted(res[1], key=lambda r: float(r["elapsedVideoTimeRatio"]))
        for r in rows:
            curve_rows.append({
                "video_id": vid,
                "elapsed_ratio": r["elapsedVideoTimeRatio"],
                "audience_watch_ratio": r.get("audienceWatchRatio"),
                "relative_retention_performance": r.get("relativeRetentionPerformance"),
            })

        def at(ratio, rows=rows):
            r = min(rows, key=lambda x: abs(float(x["elapsedVideoTimeRatio"]) - ratio))
            return r.get("audienceWatchRatio", "")

        rel = [x for x in (yc.num(r.get("relativeRetentionPerformance")) for r in rows) if x is not None]
        summary[vid] = {
            "ret_10pct": at(0.1), "ret_50pct": at(0.5), "ret_90pct": at(0.9),
            "relative_retention_avg": round(statistics.mean(rel), 3) if rel else "",
        }
    return curve_rows, summary


SUMMARY_FIELDS = [
    "video_id", "title", "published_at", "duration_sec", "content_type", "content_type_source",
    "url", "views_total", "likes_total", "comments_total",
    "thumbnail_impressions", "thumbnail_ctr",
    "views_first2d", "views_first7d", "views_first28d", "first7d_vs_median",
    "win_views", "win_minutes_watched", "win_avg_view_duration_sec", "win_avg_view_pct",
    "win_subs_gained", "win_subs_per_1k_views", "pct_views_nonsubscriber",
    "ret_10pct", "ret_50pct", "ret_90pct", "relative_retention_avg",
]


def build_summary(own_videos, by_video_rows, ctype_map, velocity, retention, nonsub, reach):
    """動画ごとの指標を1行に統合。first7d_vs_median は同じ形式の中央値に対する比率。"""
    win = {r["video"]: r for r in by_video_rows}
    fallback = {"short": "SHORTS", "live": "LIVE_STREAM"}
    out = []
    for v in own_videos:
        vid, w = v["video_id"], win.get(v["video_id"], {})
        api_type = ctype_map.get(vid)
        views, subs = yc.num(w.get("views")), yc.num(w.get("subscribersGained"))
        row = {
            "video_id": vid, "title": v["title"], "published_at": v["published_at"],
            "duration_sec": v["duration_sec"],
            "content_type": api_type or fallback.get(v["format_guess"], "VIDEO_ON_DEMAND"),
            "content_type_source": "api" if api_type else "heuristic",
            "url": v["url"], "views_total": v["views"], "likes_total": v["likes"],
            "comments_total": v["comments"],
            "win_views": w.get("views", ""),
            "win_minutes_watched": w.get("estimatedMinutesWatched", ""),
            "win_avg_view_duration_sec": w.get("averageViewDuration", ""),
            "win_avg_view_pct": w.get("averageViewPercentage", ""),
            "win_subs_gained": w.get("subscribersGained", ""),
            "win_subs_per_1k_views":
                round(subs / views * 1000, 2) if views and subs is not None else "",
            "pct_views_nonsubscriber": nonsub.get(vid, ""),
        }
        row.update({k: "" for k in ("thumbnail_impressions", "thumbnail_ctr")})
        row.update(reach.get(vid, {}))
        row.update({k: "" for k in ("views_first2d", "views_first7d", "views_first28d")})
        row.update(velocity.get(vid, {}))
        row.update({k: "" for k in ("ret_10pct", "ret_50pct", "ret_90pct", "relative_retention_avg")})
        row.update(retention.get(vid, {}))
        out.append(row)

    medians = {}
    for ct in {r["content_type"] for r in out}:
        vals = [r["views_first7d"] for r in out
                if r["content_type"] == ct and isinstance(r["views_first7d"], (int, float))]
        if len(vals) >= 3:  # 母数が少ないうちは比較しない
            medians[ct] = statistics.median(vals)
    for r in out:
        med, val = medians.get(r["content_type"]), r["views_first7d"]
        r["first7d_vs_median"] = round(val / med, 2) if med and isinstance(val, (int, float)) else ""
    return out


# ---------------------------------------------------------------- main
def main() -> int:
    missing = [k for k in ("YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN",
                           "SHIDATUBE_CHANNEL_ID") if not os.environ.get(k)]
    if missing:
        print(f"環境変数が未設定です: {', '.join(missing)}", file=sys.stderr)
        return 2

    today = dt.date.today()
    snapshot_date = today.isoformat()
    out_dir = OUT_ROOT / snapshot_date
    data, analytics, reporting = yc.build_services()

    # 対象チャンネル: 自チャンネル + 競合
    targets = [{"channel_id": OWN_CHANNEL_ID, "label": "Shidatube", "category": "own"}]
    targets += [
        {"channel_id": r["channel_id"].strip(), "label": r.get("label", ""),
         "category": r.get("category", "")}
        for r in load_competitors() if r.get("channel_id", "").strip()
    ]
    meta = {t["channel_id"]: t for t in targets}

    print("[1/4] Data API")
    ch_rows, uploads = fetch_channels(data, list(meta))
    for r in ch_rows:
        r["snapshot_date"] = snapshot_date
        r["label"] = meta[r["channel_id"]]["label"]
        r["category"] = meta[r["channel_id"]]["category"]
    yc.write_csv(out_dir / "channels.csv", ch_rows,
              ["snapshot_date", "channel_id", "label", "category", "title",
               "subscribers", "total_views", "video_count"])

    video_rows = []
    for cid, pl in uploads.items():
        t = meta[cid]
        vids = fetch_recent_video_ids(data, pl, MAX_VIDEOS)
        video_rows += fetch_video_details(
            data, vids, cid, t["label"], t["category"], snapshot_date)
    yc.write_csv(out_dir / "videos.csv", video_rows,
              ["snapshot_date", "channel_id", "channel_label", "category", "video_id",
               "title", "published_at", "duration_sec", "format_guess",
               "views", "likes", "comments", "url"])

    missing_ch = set(meta) - {r["channel_id"] for r in ch_rows}
    if missing_ch:
        print(f"  [WARN] 取得できなかったチャンネル ID: {sorted(missing_ch)}", file=sys.stderr)

    print("[2/4] Analytics API（自チャンネル）")
    end = today - dt.timedelta(days=2)  # Analytics は集計反映に1〜2日の遅れがある
    start = end - dt.timedelta(days=LOOKBACK_DAYS - 1)
    ok, results = 0, {}
    for name, params in ANALYTICS_REPORTS.items():
        result = run_report(analytics, name, start.isoformat(), end.isoformat(), **params)
        if result is None:
            continue
        cols, rows = result
        results[name] = rows
        yc.write_csv(out_dir / f"{name}.csv", rows, cols)
        ok += 1
    print(f"  Analytics: {ok}/{len(ANALYTICS_REPORTS)} レポート取得成功 "
          f"（期間 {start} 〜 {end}）")

    print("[3/4] Reporting API（サムネイル・インプレッション / CTR）")
    reach_daily, reach_summary = reach_reports.sync_and_aggregate(
        reporting, out_dir, OUT_ROOT, start, end)
    yc.write_csv(out_dir / "analytics_reach_daily.csv", reach_daily,
              ["date", "video_id", "thumbnail_impressions", "thumbnail_ctr"])

    print("[4/4] 動画別の詳細と統合")
    own_videos = sorted((r for r in video_rows if r["channel_id"] == OWN_CHANNEL_ID),
                        key=lambda r: r["published_at"], reverse=True)

    ctype_map = fetch_content_types(analytics, end)
    sub_rows, nonsub = fetch_subscribed_split(analytics, start.isoformat(), end.isoformat())
    if sub_rows:
        yc.write_csv(out_dir / "analytics_by_video_subscribed.csv", sub_rows,
                  ["video", "subscribedStatus", "views"])

    daily_rows, velocity = build_velocity(analytics, own_videos, end)
    yc.write_csv(out_dir / "analytics_video_daily.csv", daily_rows,
              ["video_id", "day", "day_index", "views", "estimatedMinutesWatched",
               "subscribersGained", "likes", "comments", "shares"])

    curve_rows, retention = build_retention(analytics, own_videos, end)
    yc.write_csv(out_dir / "analytics_retention_curve.csv", curve_rows,
              ["video_id", "elapsed_ratio", "audience_watch_ratio",
               "relative_retention_performance"])

    summary = build_summary(own_videos, results.get("analytics_by_video", []),
                            ctype_map, velocity, retention, nonsub, reach_summary)
    yc.write_csv(out_dir / "own_video_summary.csv", summary, SUMMARY_FIELDS)

    # Analytics が全滅 = 権限またはトークンの問題。自動実行で気付けるよう非0で終了
    return 0 if ok > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
