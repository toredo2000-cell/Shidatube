"""OAuth の初回認可（ローカルで1回だけ実行）。

Studio で管理者権限を付与されている Google アカウントでログインし、
自動実行に使うリフレッシュトークンを取得します。

事前準備:
  1. Google Cloud で YouTube Data API v3 / YouTube Analytics API を有効化
  2. OAuth クライアント（種類: デスクトップアプリ）を作成し、JSON を
     client_secret.json として同じフォルダに保存
  3. OAuth 同意画面の公開ステータスを「本番環境」にする
     （「テスト」のままだとリフレッシュトークンが7日で失効します）
  4. 広告収益データ（月次レポート）を使う場合は、事前に志田さんご本人に、
     Miyoさんのアカウントへ YouTube Studio の「財務データの表示」権限を
     付与してもらってください（通常の管理者権限だけでは収益データは見えません）。
     この権限が無い状態で実行しても認可自体は通りますが、収益レポートの
     取得だけが失敗し、月次レポートにその旨が明記されます。

実行:
  pip install -r requirements.txt
  python auth_setup.py [client_secret.json]

表示された3つの値を、GitHub Actions の Secrets（または環境変数）に登録します。
  YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN
値はファイルに保存せず、画面表示のみです。リポジトリにはコミットしないでください。

注意: 既に一度この認可を済ませている場合でも、yt-analytics-monetary.readonly の
scope を新たに追加したときは、この認可をやり直して YT_REFRESH_TOKEN を発行し
直す必要があります（既存のリフレッシュトークンには新しい scope が自動的には
追加されません）。GitHub Secrets の YT_REFRESH_TOKEN を新しい値に更新してください。
"""
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
]


def main(client_secret_path: str = "client_secret.json") -> None:
    flow = InstalledAppFlow.from_client_secrets_file(client_secret_path, SCOPES)
    # access_type=offline / prompt=consent で、確実にリフレッシュトークンを発行させる
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")

    if not creds.refresh_token:
        sys.exit("リフレッシュトークンが取得できませんでした。"
                 "Google アカウントのアクセス許可から当該アプリを一度削除して再実行してください。")

    print("\n=== 以下を Secrets / 環境変数に登録してください ===")
    print(f"YT_CLIENT_ID={creds.client_id}")
    print(f"YT_CLIENT_SECRET={creds.client_secret}")
    print(f"YT_REFRESH_TOKEN={creds.refresh_token}")


if __name__ == "__main__":
    main(*sys.argv[1:2])
