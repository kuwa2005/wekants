# wekants — WeKan の書き直し

このリポジトリは上流 WeKan への貢献ではない。JavaScript / Meteor / Blaze を捨て、次のスタックで独自に書き直す。

- **フロント:** Vite 8（Rolldown）+ TypeScript + React
- **API:** Node.js + TypeScript + Hono
- **ドメイン:** Rust (`crates/wekan-core`)。Node からは napi-rs (`packages/wekan-core-node`) で呼ぶ
- **データ:** PostgreSQL。Mongo / FerretDB / SQLite / DDP は使わない
- **実行:** Docker Compose（`compose.yaml`）

## v1 の範囲

表示言語は日本語です。ユーザー登録とログイン、ワークスペース、自分が所有するボード、リスト、カード、ドラッグでの並べ替え、Markdown、同じボードを開いている他セッションへの WebSocket 同期。

スイムレーン、チェックリスト、ラベル、共有、Rules、Admin、LDAP、添付は入れない。

## Markdown

カード本文は Markdown（GFM）として保存・描画する。ボードは `#` / `##` / `###` の `.md` ファイルとして import / export できる。リストへ `.md` を落とすとカードになる。

## ワークスペースの DnD

All Boards のベイ間ドラッグは **新規実装** である。legacy WeKan のワークスペース DnD はバグっていたので移植しない。並びは Rust の rank と同じ規則。

## レイアウト

- `apps/web` — SPA
- `apps/api` — HTTP と WebSocket
- `crates/wekan-core` — 権限・タイトル・rank・カード移動。I/O なし
- `packages/wekan-core-node` — napi バインディング
- `packages/shared` — 型と Markdown の parse/serialize
- `compose.yaml` — `db` / `api` / `web`
- `legacy/` — 旧 WeKan。参照専用。実行しない。機能仕様は `legacy/docs/Features/`

上流への Pull Request は出さない（`.cursor/rules/no-upstream-pr.mdc`）。
