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
     伸びた/伸びなかった動画、流入元、events.csv の出来事、競合の現況を集計する。
  3. 集計結果をJSONにまとめ、Claude (Sonnet) に渡してMarkdownレポートを書かせる。
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


def build_stats(snapshot_dir: Path, latest_date: dt.date) -> dict:
    summary = read_csv(snapshot_dir / "own_video_summary.csv")
    daily = read_csv(snapshot_dir / "analytics_channel_daily.csv")
    traffic = read_csv(snapshot_dir / "analytics_traffic_source.csv")
    search_terms = read_csv(snapshot_dir / "analytics_search_terms.csv")
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

    new_video_diagnostics = [
        {"title": r["title"], "url": r["url"], "published_at": r["published_at"],
         "content_type": r["content_type"], "diagnosis": diagnose_video(r, medians)}
        for r in new_videos[:10]
    ]

    scored = [r for r in summary if r.get("first7d_vs_median")]
    scored.sort(key=lambda r: num(r["first7d_vs_median"]) or 0, reverse=True)
    top_movers = [{"title": r["title"], "content_type": r["content_type"],
                   "vs_median": num(r["first7d_vs_median"]), "views_first7d": r["views_first7d"]}
                  for r in scored[:3]]
    bottom_movers = [{"title": r["title"], "content_type": r["content_type"],
                      "vs_median": num(r["first7d_vs_median"]), "views_first7d": r["views_first7d"]}
                     for r in scored[-3:]] if len(scored) > 3 else []

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
        "top_movers": top_movers,
        "bottom_movers": bottom_movers,
        "traffic_sources": traffic_summary,
        "top_search_terms": [r.get("insightTrafficSourceDetail") for r in
                             sorted(search_terms, key=lambda r: num(r.get("views")) or 0,
                                    reverse=True)[:8]],
        "events_this_week": recent_events,
        "competitors": competitors_summary,
        "previous_week_actions": previous_week_actions,
        "data_notes": [
            "thumbnail_impressions / thumbnail_ctr は、レポートジョブ作成から48時間経過するまで"
            "空欄になります（値が空の動画は、その旨を明記し、数値を創作しないでください）。",
            "pct_views_nonsubscriber は API の仕様上、動画単位では取得できません。",
            "previous_week_actions の各項目の logged_as_taken は、events.csv に"
            "type=action_taken として記録があるかどうかのみを表す。記録が無い場合、"
            "実行しなかったと断定せず「記録が無いため実行有無は不明」と扱うこと。",
        ],
    }


SYSTEM_PROMPT = """\
あなたはYouTubeチャンネルの運営者向けに、週次の分析レポートを作成するアナリストです。
読み手は、YouTubeチャンネル「Shidatube」（プロレスラーの分析・実況系チャンネル）を
自ら運営する担当者です。

厳守事項:
- 渡されたJSONデータに含まれる数値のみを使用し、そこにない数値を作り出さないこと。
- データが空欄・欠損している項目は、正直に「まだデータがありません」等と明記すること。
  特に thumbnail_impressions / thumbnail_ctr が空の場合、無理に評価しないこと。
- 「露出（インプレッション）→クリック率→視聴維持率→登録への転換」という段階(ファネル)に
  沿って、伸びた動画・伸びなかった動画がどの段階で差がついたかを診断すること。
- 仮説は「〜の可能性がある」「〜と考えられる」のように、断定を避けた表現にすること。
- 出力は日本語のMarkdown。見出し(##)を使い、読みやすく簡潔にまとめること。
  過度に長くせず、要点を絞ること。
- 文体は丁寧で落ち着いたトーンとし、「We」は使わないこと。過度に協力的・迎合的な
  表現は避けること。
- 最後に「来週試すこと」として、具体的で実行可能な打ち手を2〜4個、箇条書きで挙げること。
  データに基づかない一般論（「もっと投稿頻度を増やしましょう」等の使い古された助言）は
  避け、今回のデータから導ける具体的な提案にすること。
- 「要点を絞ること」は、1見出しあたりの分量を絞る意味であり、見出しそのものを省略して
  よいという意味ではない。以下の8つの見出しは、対応するデータが乏しい場合でも必ず
  すべて出力すること。該当データが無い場合は「対象となる動画がありませんでした」等、
  その旨を1〜2行で明記すること（見出しごと省略しない）。
- previous_week_actions が渡されている場合、「先週の振り返り」で、先週提案した各施策
  について、今週の数字（該当する動画・コンテンツ形式の指標）がどう動いたかを照合する
  こと。logged_as_taken が true の項目は「実行された前提」で効果を評価してよいが、
  false（events.csvに記録が無い）の項目は、実行されたかどうか自体が不明である旨を
  明記し、効果を断定しないこと。previous_week_actions が無い（初回など）場合は、
  「先週の提案データがないため、今回は振り返りを省略します」と1行だけ書くこと。

レポートの構成（この8つの見出しを、この順番ですべて出力すること）:
## 今週のサマリー
## 先週の振り返り
## 新着動画の診断
## 伸びた動画・伸びなかった動画
## 流入経路
## 出来事との関連
## 競合の状況
## 来週試すこと

「## 来週試すこと」の直後には、人間向けの箇条書きに加えて、必ず以下の形式の
JSONコードブロックを1つだけ出力すること（これは来週のレポート生成が、今週の
提案を機械的に読み取るために使う。本文中の他の場所にJSONブロックを含めないこと）:

```json
{"actions": [{"id": "英数字とハイフンの短いID", "action": "やることの要約（日本語、1文）", "metric_to_watch": "確認すべき指標（日本語、簡潔に）", "target": "対象の動画タイトルやコンテンツ形式（任意、無ければ空文字）"}]}
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
        max_tokens=8000,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text")
    if resp.stop_reason == "max_tokens":
        print("  [WARN] レポートが max_tokens で打ち切られました（続きが欠けています）",
              file=sys.stderr)
        text += "\n\n> ⚠️ 出力上限に達したため、レポートが途中で打ち切られています。"
    missing = [h for h in ("## 今週のサマリー", "## 先週の振り返り", "## 新着動画の診断",
                           "## 伸びた動画・伸びなかった動画", "## 流入経路", "## 出来事との関連",
                           "## 競合の状況", "## 来週試すこと")
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
