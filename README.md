# wekants

WeKan を TypeScript + Rust + Vite 8 + Node.js で書き直しているフォークです。上流には送りません。実行環境は Docker、データベースは PostgreSQL です。

詳細は [REWRITE.md](REWRITE.md)。旧 Meteor アプリは [legacy/](legacy/) にあり、参照専用です。

## 起動

開発用の Postgres パスワードは Compose 内のローカル既定値です。上書きするときは環境変数で渡してください。

```bash
docker compose up --build
```

ブラウザは `http://127.0.0.1:8080`。

ホストでフロントだけ動かす場合は、先に `docker compose up -d db` してから:

```bash
export DATABASE_URL=postgres://wekants:wekants@127.0.0.1:5432/wekants
pnpm install
pnpm build:core
pnpm dev
```

## テスト

```bash
docker compose up -d db
export DATABASE_URL=postgres://wekants:wekants@127.0.0.1:5432/wekants_test
cargo test
pnpm --filter @wekants/api test
```
