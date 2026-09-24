"""週次診断レポートの自動生成。

設計方針:
  数値の計算はすべて Python 側で行い、Claude には「計算済みの数値」だけを渡して
  文章化（診断・仮説・来週の打ち手）させる。AIに数値そのものを計算させないことで、
  誤った数字が出るのを防ぐ。

処理の流れ:
  1. analytics/data/ 以下から、最新のスナップショット（日付フォルダ）を1つ読む。
     Analytics API のレポートはどれも直近28日分をまとめて含んでいるため、
     1回分のスナップショットだけで「今週 vs 先週」の比較ができる。
  2. チャンネル全体の週次推移、新着動画の段階別診断（露出→クリック→維持→登録）、
     広告/オーガニックを切り分けた伸び（organic_top_movers等）、登録転換の上位動画、
     新規/再訪の近似指標、Shorts/VOD/LIVEのフォーマット別役割、Paid Media（広告経由
     視聴の日別推移・広告出稿記録・広告影響動画）、流入元、events.csv の出来事、
     競合の現況を集計する。
  3. 集計結果をJSONにまとめ、Claude (Sonnet) に渡して、「今週のサマリー」
     「Organic Growth」「Subscriber Conversion」「New vs Returning Viewers」
     「Shorts / VOD / LIVE」「コンテンツ分析」「Paid Media」「今週わかったこと」
     「来週試すこと」「今後4週間への示唆」の10セクション構成でMarkdownレポートを
     書かせる（広告影響のある動画をオーガニックヒットとして扱わない、事実と仮説を
     分けて仮説には確度を付ける、といったルールをSYSTEM_PROMPTで強制する）。
  4. analytics/reports/weekly-YYYY-MM-DD.md に保存する。

環境変数:
  ANTHROPIC_API_KEY   Anthropic の API キー（DRY_RUN=1 の場合は不要）
  DATA_DIR            スナップショットの場所（既定 data）
  REPORTS_DIR         レポートの出力先（既定 reports）
  COMPETITORS_CSV     競合リスト（既定 competitors.csv）
  EVENTS_CSV          出来事の記録（既定 events.csv）
  DRY_RUN             1 を指定すると、API を呼ばずに構築したプロンプトを標準出力に
                       表示して終了する（内容の確認・課金なしのテスト用）
  ANTHROPIC_MODEL     使用モデル（既定 claude-sonnet-5）
"""
import csv
import datetime as dt
import json
import os
import re
import statistics
import sys
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
REPORTS_DIR = Path(os.environ.get("REPORTS_DIR", "reports"))
COMPETITORS_CSV = Path(os.environ.get("COMPETITORS_CSV", "competitors.csv"))
EVENTS_CSV = Path(os.environ.get("EVENTS_CSV", "events.csv"))
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
DRY_RUN = os.environ.get("DRY_RUN") == "1"

WEEK_DAYS = 7

FORMAT_LABELS = {
    "SHORTS": "Shorts",
    "VIDEO_ON_DEMAND": "VOD",
    "LIVE_STREAM": "LIVE",
}

# analytics_channel_daily_by_type.csv の creatorContentType はYouTube Analytics APIの
# 生の値（camelCase）で返る。own_video_summary.csv 側の content_type（SHORTS等、
# 大文字+アンダースコアのheuristic値）とは表記が異なるため、別のマップで変換する。
CREATOR_CONTENT_TYPE_LABELS = {
    "shorts": "Shorts",
    "videoOnDemand": "VOD",
    "liveStream": "LIVE",
    "creatorContentTypeUnspecified": "不明（未分類）",
    "posts": "コミュニティ投稿等（Posts。動画ではないため他の指標と単純比較しないこと）",
}


# ---------------------------------------------------------------- I/O helpers
def read_csv(path: Path) -> list:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_previous_actions(current_date: dt.date):
    """直近の週次レポート（現在より前の日付）から、末尾のJSONブロック
    （前回の「来週試すこと」の機械可読版）を取り出す。

    形式が壊れている・見つからない場合は None を返し、呼び出し側は
    「前回の提案なし」として扱う（レポート生成自体は止めない）。"""
    if not REPORTS_DIR.exists():
        return None
    candidates = []
    for p in REPORTS_DIR.glob("weekly-*.md"):
        try:
            d = dt.date.fromisoformat(p.stem.removeprefix("weekly-"))
        except ValueError:
            continue
        if d < current_date:
            candidates.append((d, p))
    if not candidates:
        return None
    prev_date, prev_path = max(candidates, key=lambda t: t[0])
    text = prev_path.read_text(encoding="utf-8")
    blocks = re.findall(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if not blocks:
        return None
    try:
        parsed = json.loads(blocks[-1])
    except json.JSONDecodeError:
        print(f"  [WARN] {prev_path} 末尾のJSONブロックの解析に失敗しました", file=sys.stderr)
        return None
    return {"report_date": prev_date.isoformat(), "actions": parsed.get("actions", [])}


def find_action_followups(actions: list, events: list, period: list) -> list:
    """前回提案した各施策について、events.csv に action_taken として
    記録があるかどうかを機械的に突き合わせる（実行有無の唯一の確認手段）。"""
    taken = [e for e in events if e.get("type") == "action_taken"
            and period[0] <= e.get("date", "") <= period[1]]
    out = []
    for a in actions:
        matched = [e["description"] for e in taken
                  if a.get("id", "") and a["id"] in e.get("related_video_id", "") + e.get("description", "")]
        out.append({**a, "logged_as_taken": bool(matched),
                    "execution_note": matched[0] if matched else None})
    return out


def find_latest_snapshot() -> Path:
    dates = sorted(p for p in DATA_DIR.iterdir()
                   if p.is_dir() and len(p.name) == 10 and p.name[4] == "-")
    if not dates:
        sys.exit(f"{DATA_DIR} にスナップショットが見つかりません。"
                 "先に collect_snapshot.py を実行してください。")
    return dates[-1]


# ---------------------------------------------------------------- 集計
def channel_week_over_week(daily_rows: list) -> dict:
    """analytics_channel_daily.csv（直近28日の日次）から、直近7日と、その前の7日を比較。"""
    rows = sorted((r for r in daily_rows if r.get("day")), key=lambda r: r["day"])
    fields = ["views", "estimatedMinutesWatched", "subscribersGained",
              "subscribersLost", "likes", "comments", "shares"]

    def sum_window(window):
        return {f: sum(num(r.get(f)) or 0 for r in window) for f in fields}

    if len(rows) < WEEK_DAYS * 2:
        this_week = sum_window(rows[-WEEK_DAYS:]) if rows else {f: 0 for f in fields}
        return {"this_week": this_week, "last_week": None, "note":
                "先週分の比較に必要な日数（14日分）がまだ蓄積されていません。",
                "period_this_week": [rows[0]["day"], rows[-1]["day"]] if rows else None}

    this_week = sum_window(rows[-WEEK_DAYS:])
    last_week = sum_window(rows[-WEEK_DAYS * 2:-WEEK_DAYS])
    delta_pct = {}
    for f in fields:
        # 文字列化して % を明示することで、AI側で単位を落とさせない
        if last_week[f]:
            pct = round((this_week[f] - last_week[f]) / abs(last_week[f]) * 100, 1)
            delta_pct[f] = f"{'+' if pct >= 0 else ''}{pct}%"
        else:
            delta_pct[f] = None
    return {"this_week": this_week, "last_week": last_week, "delta_pct": delta_pct,
            "period_this_week": [rows[-WEEK_DAYS]["day"], rows[-1]["day"]],
            "period_last_week": [rows[-WEEK_DAYS * 2]["day"], rows[-WEEK_DAYS - 1]["day"]]}


def content_type_medians(summary_rows: list, field: str) -> dict:
    by_type = {}
    for r in summary_rows:
        v = num(r.get(field))
        if v is not None:
            by_type.setdefault(r.get("content_type", ""), []).append(v)
    return {ct: statistics.median(vals) for ct, vals in by_type.items() if len(vals) >= 3}


def diagnose_video(row: dict, medians: dict) -> dict:
    """1本の動画について、露出→クリック→維持→登録の各段階を中央値と比較。"""
    diag = {}
    checks = [
        ("impressions", "thumbnail_impressions", "露出（インプレッション）"),
        ("ctr", "thumbnail_ctr", "クリック率（CTR）"),
        ("retention", "ret_50pct", "視聴維持率（50%地点）"),
        ("subs_conv", "win_subs_per_1k_views", "登録への転換（再生1000回あたりの登録者増）"),
    ]
    for key, field, label in checks:
        val = num(row.get(field))
        med = medians.get(field, {}).get(row.get("content_type", ""))
        if val is None or med is None or med == 0:
            diag[key] = {"label": label, "value": row.get(field, ""), "vs_median": None}
            continue
        ratio = round(val / med, 2)
        diag[key] = {"label": label, "value": val, "content_type_median": round(med, 4),
                     "vs_median_ratio": ratio}
    if row.get("first7d_vs_median"):
        diag["overall_vs_median"] = num(row["first7d_vs_median"])
    return diag


def ad_influence_label(row: dict) -> str:
    """広告影響の有無を、動画1本の集計行(own_video_summary.csvの1行)から判定する。

    ad_data_status が "ok" 以外（"unavailable"=取得失敗 / "not_checked"=対象外）の
    場合は、広告影響が無かったと断定せず、必ず「広告影響：未確認」とする。"""
    status = row.get("ad_data_status", "")
    if status != "ok":
        return "広告影響：未確認"
    paid = num(row.get("win_paid_views")) or 0
    if paid > 0:
        return "広告影響あり"
    return "オーガニック（広告影響なし・確認済み）"


def organic_movers(summary_rows: list, limit: int = 3) -> tuple:
    """広告影響が確認済み(ad_data_status=="ok")の動画に限定して、オーガニック再生数
    (win_organic_views、集計期間28日)を同じcontent_typeの中央値と比較したランキング。
    first7d_vs_median（広告分も混ざりうる）とは別軸の指標として扱うこと。"""
    confirmed = [r for r in summary_rows if r.get("ad_data_status") == "ok"]
    medians = content_type_medians(confirmed, "win_organic_views")
    scored = []
    for r in confirmed:
        med = medians.get(r.get("content_type", ""))
        val = num(r.get("win_organic_views"))
        if med and val is not None and med > 0:
            scored.append({
                "title": r["title"], "content_type": r.get("content_type"),
                "win_organic_views": val,
                "vs_content_type_median_organic": round(val / med, 2),
            })
    scored.sort(key=lambda r: r["vs_content_type_median_organic"], reverse=True)
    top = scored[:limit]
    bottom = scored[-limit:] if len(scored) > limit else []
    return top, bottom


def subscriber_conversion_leaders(summary_rows: list, n: int = 5) -> list:
    """Subscribers per 1,000 Views が高い動画（再生数が極端に少ない外れ値を除く）。"""
    scored = [r for r in summary_rows
             if num(r.get("win_subs_per_1k_views")) is not None
             and (num(r.get("win_views")) or 0) >= 50]
    scored.sort(key=lambda r: num(r["win_subs_per_1k_views"]), reverse=True)
    return [{
        "title": r["title"], "content_type": r.get("content_type"),
        "win_subs_per_1k_views": num(r["win_subs_per_1k_views"]),
        "win_subs_gained": num(r.get("win_subs_gained")),
        "win_views": num(r.get("win_views")),
        "ad_influence": ad_influence_label(r),
    } for r in scored[:n]]


def format_weekly_breakdown(daily_by_type_rows: list, period: list) -> dict:
    """analytics_channel_daily_by_type.csv（day, creatorContentType別）を今週の期間で
    絞り込み、フォーマット別（Shorts/VOD/LIVE）の視聴回数・登録者増加を集計する。"""
    start, end = period
    by_fmt = {}
    for r in daily_by_type_rows:
        day = r.get("day", "")
        if not (start <= day <= end):
            continue
        fmt = r.get("creatorContentType") or "UNKNOWN"
        d = by_fmt.setdefault(fmt, {"views": 0.0, "subscribers_gained": 0.0})
        d["views"] += num(r.get("views")) or 0
        d["subscribers_gained"] += num(r.get("subscribersGained")) or 0
    total_views = sum(d["views"] for d in by_fmt.values()) or 1
    out = {}
    for fmt, d in by_fmt.items():
        out[CREATOR_CONTENT_TYPE_LABELS.get(fmt, fmt)] = {
            "views": round(d["views"], 1),
            "subscribers_gained": round(d["subscribers_gained"], 1),
            "subs_per_1k_views": round(d["subscribers_gained"] / d["views"] * 1000, 2) if d["views"] else None,
            "share_of_week_views_pct": round(d["views"] / total_views * 100, 1),
        }
    return out


def shorts_referral_spillover(summary_rows: list, limit: int = 8) -> list:
    """SHORTS以外の動画で、Shorts棚経由の視聴(win_shorts_referred_views)が確認された
    ものを抽出する。Shorts→VOD/LIVEの視聴導線が発生しているかの直接的な材料。"""
    out = []
    for r in summary_rows:
        if r.get("content_type") == "SHORTS":
            continue
        v = num(r.get("win_shorts_referred_views"))
        if v and v > 0:
            out.append({
                "title": r["title"], "content_type": r.get("content_type"),
                "shorts_referred_views": v, "win_views": num(r.get("win_views")),
            })
    out.sort(key=lambda x: x["shorts_referred_views"], reverse=True)
    return out[:limit]


def subscribed_status_summary(rows: list):
    """New vs Returning Viewersの代替指標。YouTube Analytics APIには「新規/再訪視聴者」
    の直接的なディメンションが無いため、代わりにチャンネル全体のsubscribedStatus
    （登録者/非登録者の視聴)を「既存ファン寄り/新規寄り」の近似値として使う。
    非登録者＝新規とは限らない（未登録の既存ファンも含む）ため、この点を明記すること。"""
    if not rows:
        return None
    total = sum(num(r.get("views")) or 0 for r in rows) or 1
    out = {}
    for r in rows:
        status = r.get("subscribedStatus", "")
        views = num(r.get("views")) or 0
        out[status] = {"views": views, "share_pct": round(views / total * 100, 1)}
    return out


def video_traffic_breakdown(traffic_rows: list) -> dict:
    """analytics_video_traffic.csv（動画ごとの流入元内訳）を動画ID単位にまとめる。"""
    by_video = {}
    for r in traffic_rows:
        vid = r.get("video_id")
        by_video.setdefault(vid, []).append({
            "source": r.get("insightTrafficSourceType"),
            "views": num(r.get("views")),
        })
    for lst in by_video.values():
        lst.sort(key=lambda x: x["views"] or 0, reverse=True)
    return by_video


def build_video_detail(row: dict, medians: dict, traffic_by_video: dict) -> dict:
    """1本の動画について、指定された10セクション構成の「動画ごとの分析」で
    求められている項目を取得可能な範囲で1つにまとめる。データが無い項目は
    "データなし"/"未確認" と明記し、推測しない。"""
    vid = row["video_id"]
    organic_ok = row.get("ad_data_status") == "ok"
    return {
        "video_id": vid, "title": row["title"], "url": row["url"],
        "published_at": row["published_at"],
        "format": FORMAT_LABELS.get(row.get("content_type"), row.get("content_type") or "データなし"),
        "views_window_28d": num(row.get("win_views")) if row.get("win_views") not in (None, "") else "データなし",
        "organic_views_window_28d": num(row.get("win_organic_views")) if organic_ok else "未確認",
        "paid_views_window_28d": num(row.get("win_paid_views")) if organic_ok else "未確認",
        "shorts_referred_views_window_28d":
            num(row.get("win_shorts_referred_views")) if organic_ok else "未確認",
        "ad_influence": ad_influence_label(row),
        "thumbnail_impressions": row.get("thumbnail_impressions") or "データなし",
        "thumbnail_ctr": row.get("thumbnail_ctr") or "データなし",
        "avg_view_duration_sec": row.get("win_avg_view_duration_sec") or "データなし",
        "avg_view_percentage": row.get("win_avg_view_pct") or "データなし",
        "subscribers_gained_window_28d": row.get("win_subs_gained") if row.get("win_subs_gained") not in (None, "") else "データなし",
        "subs_per_1k_views": row.get("win_subs_per_1k_views") if row.get("win_subs_per_1k_views") not in (None, "") else "データなし",
        "views_first_48h": row.get("views_first2d") if row.get("views_first2d") not in (None, "") else "データなし",
        "views_first_7d": row.get("views_first7d") if row.get("views_first7d") not in (None, "") else "データなし",
        "views_first_28d": row.get("views_first28d") if row.get("views_first28d") not in (None, "") else "データなし",
        "traffic_sources_window_28d": traffic_by_video.get(vid) or "未確認",
        "search_terms": "動画単位の検索キーワードはAPI仕様上取得できません（チャンネル全体の"
                       "検索語は top_search_terms を参照してください）",
        "diagnosis_vs_content_type_median": diagnose_video(row, medians),
    }


def paid_vs_organic_daily(traffic_daily_rows: list) -> list:
    """analytics_traffic_source_daily.csv（day×insightTrafficSourceType）から、
    日別のADVERTISING経由視聴とそれ以外（オーガニック）の視聴を分けた時系列を作る。
    広告停止後のOrganic Viewsの推移を見るための素材（集計期間全体、通常28日分）。"""
    by_day = {}
    for r in traffic_daily_rows:
        day = r.get("day", "")
        if not day:
            continue
        d = by_day.setdefault(day, {"paid_views": 0.0, "organic_views": 0.0})
        v = num(r.get("views")) or 0
        if r.get("insightTrafficSourceType") == "ADVERTISING":
            d["paid_views"] += v
        else:
            d["organic_views"] += v
    return [{"day": day, "paid_views": round(vals["paid_views"], 1),
             "organic_views": round(vals["organic_views"], 1)}
            for day, vals in sorted(by_day.items())]


def paid_influenced_videos(summary_rows: list, n: int = 8) -> list:
    """広告経由の視聴が確認された動画（ad_data_status=="ok" かつ win_paid_views>0）を
    広告視聴数の多い順に抽出。広告経由視聴者の登録転換や、広告終了後のオーガニック
    波及を評価する際の対象リスト。"""
    scored = [r for r in summary_rows if r.get("ad_data_status") == "ok"
             and (num(r.get("win_paid_views")) or 0) > 0]
    scored.sort(key=lambda r: num(r["win_paid_views"]) or 0, reverse=True)
    return [{
        "title": r["title"], "content_type": r.get("content_type"),
        "win_paid_views": num(r.get("win_paid_views")),
        "win_organic_views": num(r.get("win_organic_views")),
        "win_traffic_total_views": num(r.get("win_traffic_total_views")),
        "win_subs_per_1k_views": num(r.get("win_subs_per_1k_views")),
    } for r in scored[:n]]


def revenue_summary(revenue_rows: list, period: list):
    """analytics_revenue_daily.csv（yt-analytics-monetary.readonlyスコープが必要）を
    今週の期間で集計。スコープ未許可・データ無しの場合は None を返す（0円と断定しない）。"""
    if not revenue_rows:
        return None
    start, end = period
    this_week = [r for r in revenue_rows if start <= r.get("day", "") <= end]
    if not this_week:
        return None
    def s(field):
        return round(sum(num(r.get(field)) or 0 for r in this_week), 2)
    return {
        "period": [start, end],
        "estimated_revenue": s("estimatedRevenue"),
        "estimated_ad_revenue": s("estimatedAdRevenue"),
        "gross_revenue": s("grossRevenue"),
        "ad_impressions": s("adImpressions"),
    }


def build_stats(snapshot_dir: Path, latest_date: dt.date) -> dict:
    summary = read_csv(snapshot_dir / "own_video_summary.csv")
    daily = read_csv(snapshot_dir / "analytics_channel_daily.csv")
    daily_by_type = read_csv(snapshot_dir / "analytics_channel_daily_by_type.csv")
    traffic = read_csv(snapshot_dir / "analytics_traffic_source.csv")
    traffic_daily = read_csv(snapshot_dir / "analytics_traffic_source_daily.csv")
    video_traffic = read_csv(snapshot_dir / "analytics_video_traffic.csv")
    search_terms = read_csv(snapshot_dir / "analytics_search_terms.csv")
    subscribed_status = read_csv(snapshot_dir / "analytics_subscribed_status.csv")
    revenue_daily = read_csv(snapshot_dir / "analytics_revenue_daily.csv")
    channels = read_csv(snapshot_dir / "channels.csv")
    videos = read_csv(snapshot_dir / "videos.csv")
    events = read_csv(EVENTS_CSV)
    competitors_meta = read_csv(COMPETITORS_CSV)

    own_channel = next((c for c in channels if c.get("category") == "own"), {})
    wow = channel_week_over_week(daily)
    # レポートの対象期間は、Analytics APIの集計遅延（2日）を反映した実際のデータ期間
    # （wow の period_this_week）を正とする。無ければ暫定でスナップショット基準の週を使う。
    period = wow.get("period_this_week") or [
        (latest_date - dt.timedelta(days=WEEK_DAYS)).isoformat(), latest_date.isoformat()]
    week_cutoff = period[0]

    new_videos = sorted(
        (r for r in summary if r.get("published_at", "") >= week_cutoff),
        key=lambda r: r["published_at"], reverse=True)

    medians = {f: content_type_medians(summary, f)
              for f in ("thumbnail_impressions", "thumbnail_ctr",
                        "ret_50pct", "win_subs_per_1k_views")}

    traffic_by_video = video_traffic_breakdown(video_traffic)
    new_video_diagnostics = [
        build_video_detail(r, medians, traffic_by_video) for r in new_videos[:10]
    ]

    # 総再生数ベースの伸び（広告分を含みうる。§6コンテンツ分析・単独の判断材料にしないこと）
    scored = [r for r in summary if r.get("first7d_vs_median")]
    scored.sort(key=lambda r: num(r["first7d_vs_median"]) or 0, reverse=True)
    top_movers = [{"title": r["title"], "content_type": r["content_type"],
                   "vs_median": num(r["first7d_vs_median"]), "views_first7d": r["views_first7d"],
                   "ad_influence": ad_influence_label(r)}
                  for r in scored[:3]]
    bottom_movers = [{"title": r["title"], "content_type": r["content_type"],
                      "vs_median": num(r["first7d_vs_median"]), "views_first7d": r["views_first7d"],
                      "ad_influence": ad_influence_label(r)}
                     for r in scored[-3:]] if len(scored) > 3 else []

    # オーガニック確定分のみのランキング（§2 Organic Growth の主材料）
    organic_top_movers, organic_bottom_movers = organic_movers(summary)

    total_traffic_views = sum(num(r.get("views")) or 0 for r in traffic) or 1
    traffic_top = sorted(traffic, key=lambda r: num(r.get("views")) or 0, reverse=True)[:6]
    traffic_summary = [
        {"source": r["insightTrafficSourceType"],
         "views": num(r.get("views")),
         "share_pct": round((num(r.get("views")) or 0) / total_traffic_views * 100, 1)}
        for r in traffic_top
    ]

    recent_events = [e for e in events if week_cutoff <= e.get("date", "") <= latest_date.isoformat()]

    prev = load_previous_actions(latest_date)
    previous_week_actions = None
    if prev:
        previous_week_actions = {
            "report_date": prev["report_date"],
            "actions": find_action_followups(prev["actions"], events, period),
        }

    competitor_label = {c["channel_id"]: c for c in competitors_meta}
    competitors_summary = []
    for c in channels:
        if c.get("category") == "own":
            continue
        latest_video = max(
            (v for v in videos if v.get("channel_id") == c["channel_id"]),
            key=lambda v: v.get("published_at", ""), default=None)
        competitors_summary.append({
            "label": c.get("label") or c.get("title"),
            "category": competitor_label.get(c["channel_id"], {}).get("category", ""),
            "subscribers": c.get("subscribers"),
            "video_count": c.get("video_count"),
            "latest_video_title": latest_video["title"] if latest_video else None,
            "latest_video_views": latest_video["views"] if latest_video else None,
        })

    # Paid Media（§7）: 広告経由/オーガニックの日別推移＋出稿記録＋動画別の広告影響
    daily_paid_vs_organic = paid_vs_organic_daily(traffic_daily)
    if daily_paid_vs_organic:
        ad_window = [daily_paid_vs_organic[0]["day"], daily_paid_vs_organic[-1]["day"]]
    else:
        ad_window = period
    ad_campaign_events = [e for e in events if e.get("type") == "ad_campaign"
                          and ad_window[0] <= e.get("date", "") <= ad_window[1]]
    paid_media = {
        "channel_daily_paid_vs_organic_views": daily_paid_vs_organic,
        "daily_data_window": ad_window,
        "ad_campaign_events": ad_campaign_events,
        "video_level_paid_influence": paid_influenced_videos(summary),
        "revenue_this_week": revenue_summary(revenue_daily, period),
        "notes": [
            "channel_daily_paid_vs_organic_views は、insightTrafficSourceType="
            "ADVERTISING（広告経由）とそれ以外（オーガニック）を日別に分けた、"
            "チャンネル全体の再生数の時系列（通常直近28日分）。広告停止前後の"
            "オーガニック再生数の変化を見る材料として使うこと。",
            "ad_campaign_events は events.csv の type=ad_campaign（自由記述）。出稿期間・"
            "目標・予算感が記載されている前提だが、構造化されていないため、正確な開始/終了日"
            "が読み取れない場合は無理に断定しないこと。",
            "revenue_this_week が null の場合、広告収益データ（yt-analytics-monetary.readonly"
            "スコープ）が未取得・未許可であることを意味する。0円だったとは書かないこと。",
        ],
    }

    return {
        "report_date": latest_date.isoformat(),
        "period": period,
        "own_channel": {
            "title": own_channel.get("title"),
            "subscribers": own_channel.get("subscribers"),
            "total_views": own_channel.get("total_views"),
            "video_count": own_channel.get("video_count"),
        },
        "week_over_week": wow,
        "new_videos_this_week": new_video_diagnostics,
        "top_movers_total_views": top_movers,
        "bottom_movers_total_views": bottom_movers,
        "organic_top_movers": organic_top_movers,
        "organic_bottom_movers": organic_bottom_movers,
        "subscriber_conversion_leaders": subscriber_conversion_leaders(summary),
        "new_vs_returning_proxy": {
            "by_subscribed_status": subscribed_status_summary(subscribed_status),
            "note": "YouTube Analytics APIには「新規/再訪視聴者」を直接示すディメンションが"
                   "無いため、登録者(SUBSCRIBED)/非登録者(UNSUBSCRIBED)の視聴比率を近似指標"
                   "として使う。非登録者＝新規視聴者とは限らない（未登録の既存ファンを含む）"
                   "ことを必ず明記すること。チャンネル全体の値であり、動画単位では出せない。",
        },
        "format_weekly": format_weekly_breakdown(daily_by_type, period),
        "shorts_referral_spillover": shorts_referral_spillover(summary),
        "traffic_sources": traffic_summary,
        "top_search_terms": [r.get("insightTrafficSourceDetail") for r in
                             sorted(search_terms, key=lambda r: num(r.get("views")) or 0,
                                    reverse=True)[:8]],
        "paid_media": paid_media,
        "events_this_week": recent_events,
        "competitors": competitors_summary,
        "previous_week_actions": previous_week_actions,
        "data_notes": [
            "thumbnail_impressions / thumbnail_ctr は、レポートジョブ作成から48時間経過するまで"
            "空欄になります（値が空の動画は、その旨を明記し、数値を創作しないでください）。",
            "pct_views_nonsubscriber は API の仕様上、動画単位では取得できません。",
            "win_ で始まる項目（win_views, win_organic_views, win_paid_views 等）は、いずれも"
            "同じ集計期間（通常直近28日）の合計値。views_first7d 等の「公開後n日」系の値とは"
            "期間の基準が異なるため、同列に比較しないこと。",
            "ad_data_status が \"ok\" 以外（\"unavailable\"=取得失敗 / \"not_checked\"=対象外）の"
            "動画は、win_organic_views / win_paid_views が「未確認」であり、広告影響が無かった"
            "という意味ではない。ad_influence フィールドの表示をそのまま使うこと。",
            "previous_week_actions の各項目の logged_as_taken は、events.csv に"
            "type=action_taken として記録があるかどうかのみを表す。記録が無い場合、"
            "実行しなかったと断定せず「記録が無いため実行有無は不明」と扱うこと。",
        ],
    }


SYSTEM_PROMPT = """\
あなたはYouTubeチャンネル「Shidatube」の運営・グロース分析担当です。
Shidatubeは、プロレスラー志田光がゲーム・プロレス・イベント・コラボなどを発信する
チャンネルです。読み手は、Shidatubeを自ら運営する担当者（志田さん・Miyoさん）です。

毎週のYouTube Analyticsデータを分析し、「数字の報告」ではなく、今後どのコンテンツを
増やす・改善する・減らすべきかを判断できる週次レポートを作成してください。

【最重要ルール：広告とオーガニックを混同しない】
広告出稿された動画は、総再生数や vs_median が高くても、それだけを理由に
「企画が成功した」「人気が高い」「今後増やすべき」と判断しないこと。
渡されたJSONには、動画ごとに ad_influence（"広告影響あり" / "広告影響：未確認" /
"オーガニック（広告影響なし・確認済み）"）というフィールドが既に付与されている。
- "広告影響あり" の動画は、広告によって再生数が増えた可能性があるため、
  オーガニックで成功したとは判定しないこと。
- "広告影響：未確認" の動画は、広告の影響が無かったと断定しないこと。必ず
  「広告影響：未確認」とそのまま明記すること。
- top_movers_total_views / bottom_movers_total_views は広告分を含みうる総再生数
  ベースの参考値。オーガニックな伸び・不振の判断には、代わりに organic_top_movers /
  organic_bottom_movers（ad_data_status=="ok" の動画に限定した、オーガニック再生数
  win_organic_views の中央値比）を主に使うこと。
- 広告を使用した動画と使用していない動画の総再生数を、そのまま横並びで比較しないこと。

【分析の目的】
以下を毎週明らかにすること:
1. 新規視聴者を獲得できたコンテンツは何か
2. 視聴者を登録者に転換できたコンテンツは何か（subscriber_conversion_leaders を参照）
3. 既存視聴者が再訪したコンテンツは何か
4. Shorts → VOD/LIVE という視聴導線が発生しているか（shorts_referral_spillover を参照）
5. ゲームタイトル/IPの力で伸びたのか、出演者の力なのか、企画フォーマットの力なのか
6. 広告による再生増加なのか、オーガニックで伸びたのか
7. Shidatube独自の強みがどこに現れているか

【動画ごとの分析】
new_videos_this_week の各動画には、Format / Views / Organic Views / Paid Views /
Impressions / CTR / Average View Duration / Average Percentage Viewed /
Subscribers Gained / Subscribers per 1,000 Views / 流入元内訳 / 公開後48時間・7日間の
推移 / ad_influence が、取得できた範囲で含まれている。データが存在しない項目は
"データなし" または "未確認" と明記されているので、そのまま使い、推測で埋めないこと。
動画単位の検索キーワードはAPI仕様上取得できない（search_terms フィールドの説明の通り）。

【コンテンツ要因を分解する】（主に §6 コンテンツ分析で使う）
動画が伸びた・伸びなかった理由を、以下の要素に分けて考察すること。
A. IP / ゲームタイトル（例：龍が如く、SILENT HILL など。タイトルから読み取れる範囲で）
B. 出演者（例：志田光、対談相手・ゲストなど。タイトルから読み取れる範囲で）
C. 企画（例：インタビュー、対決、ゲーム実況、リアクション、イベントレポートなど）
D. パッケージ（タイトルの付け方から推測できる範囲で）
E. 配信形式（Shorts / VOD / LIVE。format_weekly を参照）
F. 外部要因（events_this_week のイベント、検索需要、広告出稿など）
単一要因で断定せず、「データから確認できること」と「仮説」を明確に分けること。

【判断上の注意】
- 再生数だけで成功/失敗を判断しないこと。
- 広告動画をオーガニックヒットとして扱わないこと。
- ShortsとVODとLIVEを同じ基準で評価しないこと（format_weekly で別々に見る）。
- イベント週（events_this_week に記録がある週）の急増を通常成長と判断しないこと。
- 1本だけの結果から「このジャンルが強い」と断定しないこと。
- 相関と因果を混同しないこと。
- データ不足の場合は無理に結論を出さないこと（"データなし"/"未確認" はそのまま書く）。
- 仮説には必ず「確度：高 / 中 / 低」を付けること。

厳守事項（体裁・トーン）:
- 渡されたJSONデータに含まれる数値のみを使用し、そこにない数値を作り出さないこと。
- 「事実」と「仮説」を明確に分けること。事実は渡されたデータから直接読み取れることに
  限り、仮説には必ず確度（高/中/低）を付けること。
  例）事実：Kenny Omegaインタビューは登録転換率がチャンネル中央値より高い。
      仮説（確度：中）：「プロレスラー×ゲームIP×本人ならではの体験・知識」の組み合わせが
      登録につながりやすい可能性がある。
- 仮説の文中でも「〜の可能性がある」「〜と考えられる」のように、断定を避けた表現に
  すること。
- 出力は日本語のMarkdown。見出し(##)を使い、読みやすく簡潔にまとめること。
  過度に長くせず、要点を絞ること。
- 文体は丁寧で落ち着いたトーンとし、「We」は使わないこと。過度に協力的・迎合的な
  表現は避けること。
- 提案する打ち手は、運営側（志田さん・Miyoさん）だけでコントロールできるものを
  優先すること。特定ゲストの参加やコラボの実現など、他者の都合に依存する要素を
  主な打ち手にする場合は、実現可能性が低いことを明記した上で、同じ効果を狙える
  外部要因に依存しない代替案（既存素材の編集、コメント企画、軽いリアクション形式
  など）も必ず併記すること。
- ある動画が伸びた要因を「形式」（対談・コラボ等）だけに帰属させないこと。その動画が
  持つ他の要素（テーマ性、話題性、ゲストの知名度、公開タイミングなど）も候補として
  検討し、運営側で再現しやすい要因（例：特定ジャンルの掛け合わせというテーマ性）を
  優先して打ち手に落とし込むこと。
- 「要点を絞ること」は、1見出しあたりの分量を絞る意味であり、見出しそのものを省略して
  よいという意味ではない。以下の10個の見出しは、対応するデータが乏しい場合でも必ず
  すべて出力すること。該当データが無い場合は「対象となる動画がありませんでした」等、
  その旨を1〜2行で明記すること（見出しごと省略しない）。
- previous_week_actions が渡されている場合、先週提案した各施策について、今週の数字
  （該当する動画・コンテンツ形式の指標）がどう動いたかを、関連する見出し（主に
  「今週のサマリー」）の中で簡潔に触れること。専用の見出しは設けない。logged_as_taken
  が true の項目は「実行された前提」で効果を評価してよいが、false（events.csvに記録が
  無い）の項目は、実行されたかどうか自体が不明である旨を明記し、効果を断定しないこと。
  previous_week_actions が無い（初回など）場合は、この振り返りには触れなくてよい。

レポートの構成（この10個の見出しを、この順番ですべて出力すること）:
## 今週のサマリー
重要な変化を3〜5点。単なる数字の増減ではなく「なぜ重要なのか」まで説明する。
previous_week_actions があれば、ここで簡潔に振り返りを触れる。

## Organic Growth
広告の影響を除いて（ad_influence を踏まえて）、オーガニックで伸びた動画・企画を
organic_top_movers / organic_bottom_movers を中心に分析する。

## Subscriber Conversion
登録者獲得に貢献した動画を、subscriber_conversion_leaders（Subscribers per 1,000
Viewsが高い動画）を中心に分析する。

## New vs Returning Viewers
new_vs_returning_proxy を使い、新規獲得と既存ファン維持を分けて評価する。この指標が
チャンネル全体の近似値であり、動画単位や厳密な新規/再訪の区別ではないことを明記する。

## Shorts / VOD / LIVE
format_weekly と shorts_referral_spillover を使い、各フォーマットが新規獲得／登録
転換／ファン維持のどの役割を果たしているかを分析する。

## コンテンツ分析
「ゲームIP」「出演者」「企画」「パッケージ」「フォーマット」「外部要因」（A〜F）の
どの要因が成果に寄与した可能性が高いかを、事実と仮説を分けて分析する。

## Paid Media
paid_media を使い、広告を使用した動画について、広告によって何が増えたか／広告経由
視聴者が登録したか／広告終了後にOrganicへ波及したかを可能な範囲で分析する。データが
不足している場合（revenue_this_week が null など）は、その旨を明記する。

## 今週わかったこと
「事実」と「仮説（確度付き）」を分けて、今週のデータから言えることをまとめる。

## 来週試すこと
最大3つまで。各項目について、必ず「仮説」「実施内容」「見るKPI」
「成功/失敗をどう判断するか」をセットで書くこと。

## 今後4週間への示唆
単週の数字に引っ張られず、Shidatubeとして今後増やすべき企画、検証すべき企画、
優先度を下げる企画を提案する。

「## 来週試すこと」の直後には、人間向けの記述に加えて、必ず以下の形式のJSONコード
ブロックを1つだけ出力すること（これは来週のレポート生成が、今週の提案を機械的に
読み取るために使う。本文中の他の場所にJSONブロックを含めないこと。actionsは最大3件）:

```json
{"actions": [{"id": "英数字とハイフンの短いID", "hypothesis": "仮説（日本語、1文）", "action": "実施内容の要約（日本語、1文）", "metric_to_watch": "見るKPI（日本語、簡潔に）", "success_criteria": "成功/失敗をどう判断するか（日本語、簡潔に）", "target": "対象の動画タイトルやコンテンツ形式（任意、無ければ空文字）"}]}
```
"""


def build_user_prompt(stats: dict) -> str:
    return (
        "以下は、Shidatubeチャンネルの週次分析データです（JSON形式）。\n"
        "このデータをもとに、指示された構成でレポートを作成してください。\n\n"
        f"```json\n{json.dumps(stats, ensure_ascii=False, indent=2)}\n```"
    )


def call_claude(system_prompt: str, user_prompt: str) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    resp = client.messages.create(
        model=MODEL,
        max_tokens=12000,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text")
    if resp.stop_reason == "max_tokens":
        print("  [WARN] レポートが max_tokens で打ち切られました（続きが欠けています）",
              file=sys.stderr)
        text += "\n\n> ⚠️ 出力上限に達したため、レポートが途中で打ち切られています。"
    missing = [h for h in ("## 今週のサマリー", "## Organic Growth", "## Subscriber Conversion",
                           "## New vs Returning Viewers", "## Shorts / VOD / LIVE",
                           "## コンテンツ分析", "## Paid Media", "## 今週わかったこと",
                           "## 来週試すこと", "## 今後4週間への示唆")
              if h not in text]
    if missing:
        print(f"  [WARN] 見出しが欠けています: {missing}", file=sys.stderr)
    return text


def main() -> int:
    snapshot_dir = find_latest_snapshot()
    latest_date = dt.date.fromisoformat(snapshot_dir.name)
    stats = build_stats(snapshot_dir, latest_date)
    user_prompt = build_user_prompt(stats)

    if DRY_RUN:
        print("=== SYSTEM PROMPT ===")
        print(SYSTEM_PROMPT)
        print("=== USER PROMPT ===")
        print(user_prompt)
        print(f"\n[DRY_RUN] 概算トークン数（文字数/3で概算）: "
              f"約{(len(SYSTEM_PROMPT) + len(user_prompt)) // 3}トークン")
        return 0

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("環境変数 ANTHROPIC_API_KEY が未設定です。", file=sys.stderr)
        return 2

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = REPORTS_DIR / f"weekly-{latest_date.isoformat()}.md"
    try:
        report_text = call_claude(SYSTEM_PROMPT, user_prompt)
    except Exception as e:  # API失敗時も、集計済みデータだけは残す
        fallback = REPORTS_DIR / f"weekly-{latest_date.isoformat()}-data-only.json"
        fallback.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[ERROR] Claude API 呼び出しに失敗しました: {e}", file=sys.stderr)
        print(f"  集計済みデータのみ {fallback} に保存しました。", file=sys.stderr)
        return 1

    header = (f"# Shidatube 週次レポート（{stats['period'][0]} 〜 {stats['period'][1]}）\n\n")
    out_path.write_text(header + report_text, encoding="utf-8")
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
