# transcript リレー / pull

## 目的
ラップ中の CLI（Claude / Codex）の **transcript（JSONL）** を読み取り、Discord
リレーやダッシュボードへ転送・取得できるようにする。

## 振る舞い（[`../../src/transcript-tail.ts`](../../src/transcript-tail.ts)）
- 対象 JSONL を発見し claim ファイルで占有（複数候補がある場合に並走ラッパが
  別 JSONL を pick できる）。
- provider 差を吸収して frame 化（Claude JSONL と Codex JSONL の形式翻訳）。
- **pull**: `GET /v1/transcript?limit=N&raw=0|1`。`limit` 1–500（既定 50）。
  `raw=1` はパース済オブジェクト、既定は slim `lineToFrame` frame。返却は
  `{path, available, total_lines, returned, frames|lines}`。transcript-tail 非活性
  （Concordia 無 / pty 無）時は **503**。
- **push**: fire-and-forget で Discord リレー等へ送る経路（best-effort）。

## 注意
- 壊れた JSONL 行は捨て、空行は母数に含めない（`transcript-tail.test.ts` で固定）。
- dedup は message id（`msg_xxx`）基準。
