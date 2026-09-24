"""月次診断レポートの自動生成。

設計方針:
  週次レポートが「直近1週間で何が起きたか」を素早く拾って次のアクションに繋げる
  ためのものである一方、月次レポートは「チャンネル全体が中長期的に伸びているか」
  「競合との差がどう動いているか」「広告収益がどう推移しているか」を、日次
  スナップショットの積み上げから確認するためのもの。

  1回分のスナップショット（analytics_channel_daily.csv 等）は直近28日分しか
  持たないため、単独では「今月 vs 先月」（60日分）の比較ができない。そこで
  data/ 以下の全スナップショットを日付キーでマージし、28日を超える連続した
  日次系列を作ってから比較する（同じ日が複数スナップショットに含まれる場合は、
  より新しいスナップショット＝より確定に近い値を採用する）。

  週次レポートと同様、数値の計算はすべて Python 側で行い、Claude には
  「計算済みの数値」だけを渡して文章化（診断・仮説・来月の重点）させる。

処理の流れ:
  1. analytics/data/ 以下の全スナップショットをマージし、直近WINDOW_DAYS日と
     その前WINDOW_DAYS日で、チャンネル全体の推移・広告収益を比較する。
  2. 直近WINDOW_DAYS日に公開された動画・ライブ配信を、週次と同じ基準
     （形式別中央値との比較）で診断する。
  3. 競合チャンネルの登録者数を、約WINDOW_DAYS日前のスナップショットと比較する。
  4. 集計結果をJSONにまとめ、Claude (Sonnet) に渡してMarkdownレポートを書かせる。
  5. analytics/reports/monthly-YYYY-MM.md に保存する。

広告収益データについて:
  analytics_revenue_daily.csv は、yt-analytics-monetary.readonly scope での
  再認可と、YouTube Studio側でMiyoさんのアカウントに「財務データの表示」権限が
  付与されていることの両方が揃って初めて collect_snapshot.py が取得できる
  （yt_common.py / auth_setup.py 参照）。揃っていない間は該当CSVが作られず、
  このレポートは「広告収益データは現時点で取得できません」と明記するだけで、
  他の集計・レポート生成は通常どおり続行する。

環境変数:
  ANTHROPIC_API_KEY    Anthropic の API キー（DRY_RUN=1 の場合は不要）
  DATA_DIR             スナップショットの場所（既定 data）
  REPORTS_DIR          レポートの出力先（既定 reports）
  COMPETITORS_CSV      競合リスト（既定 competitors.csv）
  EVENTS_CSV           出来事の記録（既定 events.csv）
  DRY_RUN              1 を指定すると、API を呼ばずに構築したプロンプトを標準出力に
                        表示して終了する（内容の確認・課金なしのテスト用）
  ANTHROPIC_MODEL       使用モデル（既定 claude-sonnet-5）
  MONTHLY_WINDOW_DAYS   月次比較に使う日数（既定 30）

  ※ このスクリプト自体は YouTube API を直接呼ばない（collect_snapshot.py が
    貯めたCSVを読むだけ）ため、YT_CLIENT_ID 等の認証情報は不要。
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

WINDOW_DAYS = int(os.environ.get("MONTHLY_WINDOW_DAYS", "30"))

REVENUE_FIELDS = ["estimatedRevenue", "estimatedAdRevenue", "grossRevenue",
                   "adImpressions", "cpm", "playbackBasedCpm"]
REVENUE_RATE_FIELDS = {"cpm", "playbackBasedCpm"}  # 合計ではなく平均を取る項目


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


def list_snapshots() -> list:
    """data/ 以下の日付フォルダ（YYYY-MM-DD）を昇順で返す。"""
    if not DATA_DIR.exists():
        return []
    return sorted(p for p in DATA_DIR.iterdir()
                  if p.is_dir() and len(p.name) == 10 and p.name[4] == "-")


def merge_daily(snapshots: list, filename: str, key: str = "day") -> list:
    """複数スナップショットの同名CSVを key でマージし、28日を超える連続した
    日次系列を作る。同じ key が複数スナップショットに存在する場合、より新しい
    スナップショット（＝より確定に近いAnalyticsデータ）の値で上書きする。"""
    merged = {}
    for snap in snapshots:  # 引数は昇順である前提。後から読むほど新しい＝優先
        for row in read_csv(snap / filename):
            k = row.get(key)
            if k:
                merged[k] = row
    return sorted(merged.values(), key=lambda r: r[key])


def snapshot_on_or_before(snapshots: list, target_date: dt.date):
    """target_date 以前で最も新しいスナップショットを返す（無ければ None）。
    「約1ヶ月前」の比較基準として使う。"""
    candidates = [s for s in snapshots if dt.date.fromisoformat(s.name) <= target_date]
    return candidates[-1] if candidates else None


# ---------------------------------------------------------------- 集計: チャンネル全体
def channel_month_over_month(daily_rows: list) -> dict:
    """マージ済みの日次系列から、直近WINDOW_DAYS日と、その前WINDOW_DAYS日を比較する
    （週次レポートの channel_week_over_week と同じ考え方を月次の日数に拡張したもの）。"""
    rows = [r for r in daily_rows if r.get("day")]
    fields = ["views", "estimatedMinutesWatched", "subscribersGained",
              "subscribersLost", "likes", "comments", "shares"]

    def sum_window(window):
        return {f: sum(num(r.get(f)) or 0 for r in window) for f in fields}

    if len(rows) < WINDOW_DAYS * 2:
        this_month = sum_window(rows[-WINDOW_DAYS:]) if rows else {f: 0 for f in fields}
        return {"this_month": this_month, "last_month": None, "note":
                f"前月比の算出に必要な日数（{WINDOW_DAYS * 2}日分）がまだ蓄積されて"
                "いません。日次データの蓄積が進めば、次回以降の月次レポートから"
                "前月比が表示されます。",
                "period_this_month": [rows[0]["day"], rows[-1]["day"]] if rows else None}

    this_month = sum_window(rows[-WINDOW_DAYS:])
    last_month = sum_window(rows[-WINDOW_DAYS * 2:-WINDOW_DAYS])
    delta_pct = {}
    for f in fields:
        if last_month[f]:
            pct = round((this_month[f] - last_month[f]) / abs(last_month[f]) * 100, 1)
            delta_pct[f] = f"{'+' if pct >= 0 else ''}{pct}%"
        else:
            delta_pct[f] = None
    return {"this_month": this_month, "last_month": last_month, "delta_pct": delta_pct,
            "period_this_month": [rows[-WINDOW_DAYS]["day"], rows[-1]["day"]],
            "period_last_month": [rows[-WINDOW_DAYS * 2]["day"], rows[-WINDOW_DAYS - 1]["day"]]}


def revenue_month_over_month(revenue_rows: list) -> dict:
    """analytics_revenue_daily.csv をマージした系列から広告収益を前月比で比較する。
    scope/権限が未許可でCSV自体が存在しない場合は available=False を返す。"""
    rows = [r for r in revenue_rows if r.get("day")]
    if not rows:
        return {"available": False, "reason":
                "広告収益データが1件も取得できていません。yt-analytics-monetary.readonly "
                "scopeでの再認可、またはYouTube Studio側での財務データ閲覧権限の付与が"
                "まだの可能性があります（auth_setup.py / yt_common.py のコメント参照）。"
                "チャンネルが収益化（YouTubeパートナープログラム）されていない場合も"
                "同様にデータは取得できません。"}

    def sum_window(window):
        out = {}
        for f in REVENUE_FIELDS:
            vals = [num(r.get(f)) for r in window if num(r.get(f)) is not None]
            if not vals:
                out[f] = None
            elif f in REVENUE_RATE_FIELDS:
                out[f] = round(statistics.mean(vals), 2)
            else:
                out[f] = round(sum(vals), 2)
        return out

    if len(rows) < WINDOW_DAYS * 2:
        return {"available": True, "this_month": sum_window(rows[-WINDOW_DAYS:]),
                "last_month": None,
                "note": "前月比の算出に必要な日数がまだ蓄積されていません。",
                "period_this_month": [rows[0]["day"], rows[-1]["day"]]}

    this_month = sum_window(rows[-WINDOW_DAYS:])
    last_month = sum_window(rows[-WINDOW_DAYS * 2:-WINDOW_DAYS])
    delta_pct = {}
    for f in REVENUE_FIELDS:
        a, b = this_month.get(f), last_month.get(f)
        if a is not None and b:
            pct = round((a - b) / abs(b) * 100, 1)
            delta_pct[f] = f"{'+' if pct >= 0 else ''}{pct}%"
        else:
            delta_pct[f] = None
    return {"available": True, "this_month": this_month, "last_month": last_month,
            "delta_pct": delta_pct,
            "period_this_month": [rows[-WINDOW_DAYS]["day"], rows[-1]["day"]],
            "period_last_month": [rows[-WINDOW_DAYS * 2]["day"], rows[-WINDOW_DAYS - 1]["day"]],
            "caveat": "広告収益は確定までに数週間〜数ヶ月かかる推定値。直近の日ほど"
                      "後から上振れ・下振れする可能性がある。"}


# ---------------------------------------------------------------- 集計: 動画単位
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


# ---------------------------------------------------------------- 集計: 全体
def build_stats(snapshots: list, latest_date: dt.date) -> dict:
    latest_snapshot = snapshots[-1]
    summary = read_csv(latest_snapshot / "own_video_summary.csv")
    channels = read_csv(latest_snapshot / "channels.csv")
    traffic = read_csv(latest_snapshot / "analytics_traffic_source.csv")
    search_terms = read_csv(latest_snapshot / "analytics_search_terms.csv")
    events = read_csv(EVENTS_CSV)
    competitors_meta = read_csv(COMPETITORS_CSV)

    daily = merge_daily(snapshots, "analytics_channel_daily.csv")
    revenue_daily = merge_daily(snapshots, "analytics_revenue_daily.csv")
    mom = channel_month_over_month(daily)
    revenue = revenue_month_over_month(revenue_daily)

    period = mom.get("period_this_month") or [
        (latest_date - dt.timedelta(days=WINDOW_DAYS)).isoformat(), latest_date.isoformat()]
    window_cutoff = period[0]

    own_channel = next((c for c in channels if c.get("category") == "own"), {})

    # 約WINDOW_DAYS日前に最も近いスナップショット（競合・自チャンネルの登録者数推移の基準）
    baseline_snap = snapshot_on_or_before(
        [s for s in snapshots if s != latest_snapshot],
        latest_date - dt.timedelta(days=WINDOW_DAYS))
    baseline_channels = ({c["channel_id"]: c for c in read_csv(baseline_snap / "channels.csv")}
                         if baseline_snap else {})

    def subs_change(channel_id, subs_now):
        base = baseline_channels.get(channel_id)
        subs_before = num(base.get("subscribers")) if base else None
        if subs_now is None or subs_before is None:
            return None
        return int(subs_now - subs_before)

    own_subs_now = num(own_channel.get("subscribers"))

    new_videos = sorted(
        (r for r in summary if r.get("published_at", "") >= window_cutoff),
        key=lambda r: r["published_at"], reverse=True)

    medians = {f: content_type_medians(summary, f)
              for f in ("thumbnail_impressions", "thumbnail_ctr",
                        "ret_50pct", "win_subs_per_1k_views")}

    new_video_diagnostics = [
        {"title": r["title"], "url": r["url"], "published_at": r["published_at"],
         "content_type": r["content_type"], "diagnosis": diagnose_video(r, medians)}
        for r in new_videos[:15]
    ]

    live_streams_this_month = [
        {"title": r["title"], "url": r["url"], "published_at": r["published_at"],
         "views_total": r.get("views_total"), "likes_total": r.get("likes_total"),
         "win_subs_gained": r.get("win_subs_gained"),
         "win_avg_view_pct": r.get("win_avg_view_pct")}
        for r in new_videos if r.get("content_type") == "LIVE_STREAM"
    ]

    scored = [r for r in summary if r.get("first7d_vs_median")]
    scored.sort(key=lambda r: num(r["first7d_vs_median"]) or 0, reverse=True)
    top_movers = [{"title": r["title"], "content_type": r["content_type"],
                   "vs_median": num(r["first7d_vs_median"]), "views_first7d": r["views_first7d"]}
                  for r in scored[:5]]
    bottom_movers = [{"title": r["title"], "content_type": r["content_type"],
                      "vs_median": num(r["first7d_vs_median"]), "views_first7d": r["views_first7d"]}
                     for r in scored[-5:]] if len(scored) > 5 else []

    total_traffic_views = sum(num(r.get("views")) or 0 for r in traffic) or 1
    traffic_top = sorted(traffic, key=lambda r: num(r.get("views")) or 0, reverse=True)[:6]
    traffic_summary = [
        {"source": r["insightTrafficSourceType"],
         "views": num(r.get("views")),
         "share_pct": round((num(r.get("views")) or 0) / total_traffic_views * 100, 1)}
        for r in traffic_top
    ]

    events_this_month = [e for e in events
                         if window_cutoff <= e.get("date", "") <= latest_date.isoformat()]

    competitor_label = {c["channel_id"]: c for c in competitors_meta}
    competitors_summary = []
    for c in channels:
        if c.get("category") == "own":
            continue
        competitors_summary.append({
            "label": c.get("label") or c.get("title"),
            "category": competitor_label.get(c["channel_id"], {}).get("category", ""),
            "subscribers": c.get("subscribers"),
            "subscribers_change_vs_month_ago": subs_change(c["channel_id"], num(c.get("subscribers"))),
            "video_count": c.get("video_count"),
        })

    return {
        "report_month": latest_date.strftime("%Y-%m"),
        "period": period,
        "own_channel": {
            "title": own_channel.get("title"),
            "subscribers": own_channel.get("subscribers"),
            "subscribers_change_vs_month_ago": subs_change(own_channel.get("channel_id", ""), own_subs_now),
            "total_views": own_channel.get("total_views"),
            "video_count": own_channel.get("video_count"),
        },
        "month_over_month": mom,
        "revenue": revenue,
        "new_videos_this_month": new_video_diagnostics,
        "live_streams_this_month": live_streams_this_month,
        "top_movers": top_movers,
        "bottom_movers": bottom_movers,
        "traffic_sources": traffic_summary,
        "top_search_terms": [r.get("insightTrafficSourceDetail") for r in
                             sorted(search_terms, key=lambda r: num(r.get("views")) or 0,
                                    reverse=True)[:8]],
        "events_this_month": events_this_month,
        "competitors": competitors_summary,
        "data_notes": [
            "thumbnail_impressions / thumbnail_ctr は、レポートジョブ作成から48時間経過するまで"
            "空欄になります（値が空の動画は、その旨を明記し、数値を創作しないでください）。",
            "pct_views_nonsubscriber は API の仕様上、動画単位では取得できません。",
            "subscribers_change_vs_month_ago は、約30日前に最も近いスナップショットとの差分。"
            "登録者数が非公開設定のチャンネルは比較できず null になります。",
            "revenue.available が false の場合、広告収益データは今回のレポートでは"
            "一切取得できていない。0円だった、とは解釈しないこと。",
        ],
    }


SYSTEM_PROMPT = """\
あなたはYouTubeチャンネルの運営者向けに、月次の分析レポートを作成するアナリストです。
読み手は、YouTubeチャンネル「Shidatube」（プロレスラーの分析・実況系チャンネル）を
自ら運営する担当者です。月次レポートの役割は、週次レポート（毎週配信）では見えにくい
中長期のトレンド、ライブ配信の効果、競合との差の推移、広告収益の状況を確認することです。

厳守事項:
- 渡されたJSONデータに含まれる数値のみを使用し、そこにない数値を作り出さないこと。
- データが空欄・欠損している項目は、正直に「まだデータがありません」等と明記すること。
  特に thumbnail_impressions / thumbnail_ctr が空の場合、無理に評価しないこと。
- revenue.available が false の場合、「広告収益データは現時点で取得できません」と
  明記し、原因（権限・scope未設定の可能性、または未収益化の可能性）を1〜2行で
  説明すること。数値を推測したり、0円のように扱ったりしないこと。
  revenue.available が true でも last_month が無い場合は、前月比を出さず
  今月の値のみを示すこと。
- month_over_month.last_month が無い場合も同様に、前月比を出さず「まだ比較できる
  データが無い」旨を明記すること。
- 新着動画・ライブ配信は「露出（インプレッション）→クリック率→視聴維持率→登録への
  転換」というファネルに沿って、伸びた/伸びなかった要因のどの段階で差がついたかを
  診断すること。
- 仮説は「〜の可能性がある」「〜と考えられる」のように、断定を避けた表現にすること。
- 出力は日本語のMarkdown。見出し(##)を使い、読みやすく簡潔にまとめること。
  過度に長くせず、要点を絞ること。
- 文体は丁寧で落ち着いたトーンとし、「We」は使わないこと。過度に協力的・迎合的な
  表現は避けること。
- 「要点を絞ること」は、1見出しあたりの分量を絞る意味であり、見出しそのものを省略して
  よいという意味ではない。以下の8つの見出しは、対応するデータが乏しい場合でも必ず
  すべて出力すること。該当データが無い場合は「対象となる動画がありませんでした」等、
  その旨を1〜2行で明記すること（見出しごと省略しない）。
- 「来月の重点」は、データに基づかない一般論（「もっと投稿頻度を増やしましょう」等の
  使い古された助言）を避け、今回のデータから導ける具体的な打ち手を3〜5個、
  箇条書きで挙げること。広告収益データが取得できている場合は、広告の入れ方
  （配置・本数など）についての示唆もここに含めてよい。
- 提案する打ち手は、運営側（志田さん・Miyoさん）だけでコントロールできるものを
  優先すること。特定ゲストの参加やコラボの実現など、他者の都合に依存する要素を
  主な打ち手にする場合は、実現可能性が低いことを明記した上で、同じ効果を狙える
  外部要因に依存しない代替案も必ず併記すること。
- ある動画・期間が伸びた要因を「形式」（対談・コラボ等）だけに帰属させないこと。
  その背後にある他の要素（テーマ性、話題性、ゲストの知名度、公開タイミングなど）
  も候補として検討し、運営側で再現しやすい要因を優先して打ち手に落とし込むこと。

レポートの構成（この8つの見出しを、この順番ですべて出力すること）:
## 今月のサマリー
## チャンネル全体の推移（対前月）
## 新着動画・ライブ配信の診断
## 伸びた動画・伸びなかった動画
## 流入経路
## 広告収益の状況
## 競合の動き
## 来月の重点
"""


def build_user_prompt(stats: dict) -> str:
    return (
        "以下は、Shidatubeチャンネルの月次分析データです（JSON形式）。\n"
        "このデータをもとに、指示された構成でレポートを作成してください。\n\n"
        f"```json\n{json.dumps(stats, ensure_ascii=False, indent=2)}\n```"
    )


def call_claude(system_prompt: str, user_prompt: str) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    resp = client.messages.create(
        model=MODEL,
        max_tokens=8000,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text")
    if resp.stop_reason == "max_tokens":
        print("  [WARN] レポートが max_tokens で打ち切られました（続きが欠けています）",
              file=sys.stderr)
        text += "\n\n> ⚠️ 出力上限に達したため、レポートが途中で打ち切られています。"
    missing = [h for h in ("## 今月のサマリー", "## チャンネル全体の推移（対前月）",
                           "## 新着動画・ライブ配信の診断", "## 伸びた動画・伸びなかった動画",
                           "## 流入経路", "## 広告収益の状況", "## 競合の動き", "## 来月の重点")
              if h not in text]
    if missing:
        print(f"  [WARN] 見出しが欠けています: {missing}", file=sys.stderr)
    return text


def main() -> int:
    snapshots = list_snapshots()
    if not snapshots:
        sys.exit(f"{DATA_DIR} にスナップショットが見つかりません。"
                 "先に collect_snapshot.py を実行してください。")
    latest_date = dt.date.fromisoformat(snapshots[-1].name)
    stats = build_stats(snapshots, latest_date)
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
    out_path = REPORTS_DIR / f"monthly-{stats['report_month']}.md"
    try:
        report_text = call_claude(SYSTEM_PROMPT, user_prompt)
    except Exception as e:  # API失敗時も、集計済みデータだけは残す
        fallback = REPORTS_DIR / f"monthly-{stats['report_month']}-data-only.json"
        fallback.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[ERROR] Claude API 呼び出しに失敗しました: {e}", file=sys.stderr)
        print(f"  集計済みデータのみ {fallback} に保存しました。", file=sys.stderr)
        return 1

    header = f"# Shidatube 月次レポート（{stats['period'][0]} 〜 {stats['period'][1]}）\n\n"
    out_path.write_text(header + report_text, encoding="utf-8")
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
