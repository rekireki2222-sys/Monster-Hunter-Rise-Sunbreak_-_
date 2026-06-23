# 狩猟次元 クラウドセーブ API（Cloudflare Workers + KV）

別の端末・ブラウザからでも「復元ID」でセーブを呼び出せるようにするための、最小構成の保存サーバーです。
アプリ本体（`hunting_dimension_runtime/`）とは独立しています。

## 仕組み（KV：キーバリュー）
- 1ユーザー = 1セーブJSON。KV に `save:<id>` として `{ key, data, updatedAt }` を保存。
- **読み取り（復元）** は `id` を知っていれば可能（`key` 不要）。
- **書き込み（保存）** は払い出された秘密の `key` が必要（他人の誤上書き・荒らしを防止）。

## エンドポイント
| メソッド | パス | 説明 |
|---|---|---|
| `POST` | `/api/save` | 新規発行。body=セーブJSON → `{ id, key }` を返す |
| `PUT`  | `/api/save/:id` | 既存更新。ヘッダ `X-Save-Key: <key>` が一致した時のみ上書き |
| `GET`  | `/api/save/:id` | 復元。`data`（セーブJSON）を返す |

## デプロイ手順

### A. コマンド（wrangler）で行う場合
```bash
# 1) Cloudflare にログイン
npx wrangler login

# 2) KV ネームスペースを作成（出力された id を控える）
npx wrangler kv namespace create SAVES

# 3) wrangler.toml の id = "ここにKVネームスペースID" を、控えた id に書き換える

# 4) デプロイ（このフォルダで実行）
npx wrangler deploy
```
デプロイ後に表示される URL（例: `https://hd-save-api.あなたのサブドメイン.workers.dev`）を控えます。

### B. Cloudflare ダッシュボードで行う場合
1. **Workers & Pages → Create → Worker** で Worker を作成（名前 `hd-save-api` など）。
2. エディタに `worker.js` の内容を貼り付けてデプロイ。
3. **Storage & Databases → KV** で名前空間を作成。
4. 作成した Worker の **Settings → Variables and Bindings → KV Namespace Bindings** で
   `Variable name = SAVES` として上記 KV をバインド。
5. Worker の URL を控えます。

## アプリ側の設定
1. 狩猟次元アプリを開き、**「履歴・所持状況」ページ → クラウド保存カード → 「クラウドAPIの設定」** を開く。
2. 上で控えた Worker の URL を貼り付けて「URLを保存」。
3. 「クラウドに保存」を押すと **復元ID** が発行されます（必ず控えてください）。
4. 別端末では、その **復元ID** を入力して「クラウドから復元」。
   - 別端末からも**上書き保存**したい場合は、保存時に発行された **書込キー** も入力します。

## セキュリティ / 運用メモ
- 認証なしのため **復元IDを知っている人はデータを読めます**（書き込みは `key` 必須）。
  人に教えなければ実質的な漏洩リスクは低めですが、機密情報は入れない前提でご利用ください。
- より厳しくするなら `worker.js` の `ALLOW_ORIGIN` を自分のサイトのオリジンに限定し、
  GET にも `key` を要求するよう拡張できます。
- 上限・レート制限・保存期間は `worker.js` 冒頭の定数（`MAX_BYTES` / `RATE_MAX` / `TTL_SECONDS`）で調整可能。
- 無料枠の目安: KV は読み多めの個人用途なら十分収まります（書き込み/日 など最新の無料枠は Cloudflare の料金ページをご確認ください）。
