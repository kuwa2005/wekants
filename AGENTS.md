# wekants

このリポジトリは WeKan のフォークを **TypeScript + Rust + Vite 8 + Node.js で書き直す** 作業場である。上流 `wekan/wekan` へ PR を出さない。詳細は `REWRITE.md` と `.cursor/rules/no-upstream-pr.mdc`。

- 本番コードは `apps/`、`crates/`、`packages/` だけ。
- `legacy/` は参照専用。`legacy/build.sh`、`meteor`、WeKan のリリース手順は実行しない。
- ブランチの統合はローカル merge。GitHub の Pull Request は作らない。
- ユーザーが明示したときだけローカル commit する。push はユーザーが行う。
