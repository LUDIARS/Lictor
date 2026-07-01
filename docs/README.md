# Lictor — public docs site (GitHub Pages)

`docs/` 配下は GitHub Pages で公開する静的サイト。ビルド工程なし（プレーン
HTML / CSS / JS）。

| ページ | 内容 |
|---|---|
| `index.html` | サービスの役割・特徴・設計の概要 + spec↔code 整合性レビュー |
| `graph.html` | ドメイン / 機能リストと関連を示すインタラクティブなグラフビュー（Cytoscape.js）|
| `api.html`   | sidecar HTTP API のみのリファレンス。各エンドポイントをトグル展開して詳細・パラメータを確認 |

データソース:
- `assets/api-data.js` — API エンドポイント定義（真実は `src/sidecar.ts`）
- `assets/graph.js` — ドメイン / モジュール / 関連の定義

## 公開方法

`.github/workflows/pages.yml` が `docs/**` の push で走り、Pages へデプロイする。
初回のみリポジトリの **Settings → Pages → Source** を **「GitHub Actions」** に設定する。

公開 URL（既定）: `https://ludiars.github.io/Lictor/`

## ローカル確認

```sh
cd docs && python3 -m http.server 8000   # → http://localhost:8000
```
