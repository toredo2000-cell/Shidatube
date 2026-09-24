# Shidatubeアナリティクス — 月次レポート機能（2026-09-24 追加）

## 経緯
週次レポート（`weekly_report.py`、毎週月曜自動実行）に加えて、月次レポートを追加。
理由: ライブ配信（月1〜2回）の効果や登録者の中長期トレンド、競合との差の推移は
週次だと波がぶれて見えにくいため。あわせて、広告の入れ方（ミッドロール配置等）を
データに基づいて検討できるよう、広告収益系の指標も月次レポートに組み込む方針とした。

## 追加・変更したファイル（analytics/ 以下）
- `monthly_report.py`（新規）: `data/` 配下の全日次スナップショットを日付キーで
  マージし、直近30日 vs 前30日でチャンネル全体・広告収益を比較。新着動画/ライブ配信の
  ファネル診断、競合の登録者数推移（約30日前比）も算出し、Claudeにレポート文を書かせる。
  YouTube APIは呼ばず、collect_snapshot.pyが貯めたCSVのみを読む。
- `monthly-report.yml`（新規）: GitHub Actions。毎月1日 09:30 JST 実行、
  `analytics/reports/monthly-YYYY-MM.md` をコミット。
- `collect_snapshot.py`（更新）: `ANALYTICS_REPORTS` に `analytics_revenue_daily`
  （estimatedRevenue, estimatedAdRevenue, grossRevenue, adImpressions, cpm,
  playbackBasedCpm）を追加。権限が無い場合はこのレポートだけ [WARN] でスキップし、
  他の取得は継続する（既存の `run_report` のフェイルセーフをそのまま利用）。
- `yt_common.py` / `auth_setup.py`（更新）: SCOPES に
  `yt-analytics-monetary.readonly` を追加。

## 広告収益データを使うために必要な手動対応（未完了）
1. 志田さん本人に、Miyoさんのアカウントへ YouTube Studio の
   「財務データの表示」権限を付与してもらう（通常の管理者権限だけでは収益データ不可）。
2. チャンネルがYouTubeパートナープログラム（収益化）に加入している必要がある。
3. ローカルで `auth_setup.py` を再実行し、新しい scope を含む
   `YT_REFRESH_TOKEN` を再発行（既存トークンには自動で追加されない）。
4. GitHub Secrets の `YT_REFRESH_TOKEN` を新しい値に更新。
5. 上記が揃うまでは、月次レポートの「広告収益の状況」セクションは
   「現時点で取得できません」と明記されるだけで、他のセクションは通常どおり生成される
   （実装済みのフェイルセーフ）。

## GitHubへの反映状況
- `events.csv`（action_taken記入例を追加したテンプレート）と `weekly_report.py` は
  git経由で直接pushしmainに反映済み（2026-09-24）。
- 今回の6ファイル（月次レポート一式）はチャットでユーザーに送付済み。GitHub Web UIの
  アップロード画面（`https://github.com/toredo2000-cell/Shidatube/upload/main/analytics`）
  からの反映が必要（このセッションの認証情報ではリポジトリへのpush権限が無く、
  ブラウザ側もGitHub未サインインのため、直接の反映ができなかった）。

## 未検討・今後の課題
- 広告の入れ方（配置・本数）の具体的な設計は、広告収益データが取得できるようになり、
  実データが数ヶ月分蓄積してから着手する想定。
