/**
 * ask マーカーの JSON 抽出 + 寛容パース。
 *
 * 背景: ask マーカー (```ask + JSON) はモデルが**手で書く**テキストなので、
 * 厳格 JSON.parse は現実の出力で頻繁に落ちる。とくにこの環境は Windows パスが
 * 多く、`"E:\Document\Ars"` のようなバックスラッシュ未エスケープ (`\D` は JSON の
 * 不正エスケープ) が混ざると例外になり、質問カードが**無言で消える**。
 *
 * そこで 2 段構えにする:
 *   1. `extractAskJsonText` — フェンス位置から **brace マッチで balanced な {...} を
 *      切り出す**。正規表現の非貪欲 `([\s\S]*?)```` と違い、文字列値の中に ``` が
 *      入っても途中で切れない。
 *   2. `parseLenientJson` — まず厳格 JSON.parse。失敗したら `repairJson` で
 *      よくある崩れ (未エスケープ `\`、生制御文字、全角クォート区切り、末尾カンマ) を
 *      補正して再パース。
 *
 * いずれも純関数。失敗時のログ出力は呼び出し側 (ask-marker) の責務。
 */

/**
 * `text` 中の最初の ```ask フェンス以降から、balanced な JSON オブジェクト
 * (`{ ... }`) の生文字列を切り出す。フェンスが無い / 開き波括弧が無い /
 * 波括弧が閉じない場合は null。
 *
 * 文字列リテラル ("...") の中の `{` `}` ` ``` ` はカウントしないので、
 * 値の中にコードフェンスやエスケープが入っても正しく終端を見つけられる。
 */
export function extractAskJsonText(text: string): string | null {
  const fence = /```ask[^\n]*\n/.exec(text);
  if (!fence) return null;
  const from = fence.index + fence[0].length;
  const objStart = text.indexOf("{", from);
  if (objStart === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = objStart; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(objStart, i + 1);
    }
  }
  return null; // 閉じ波括弧に到達しなかった (途中で切れた出力)
}

/** JSON 文字列で有効なエスケープ後続文字。 */
const VALID_ESCAPE = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * 手書き JSON によくある崩れを **可能な範囲で** 構文的に補正する。
 * 文字列リテラル状態を 1 パスで追いながら、
 *   - 不正なバックスラッシュエスケープ (`\D` 等) → `\\D` に二重化 (Windows パス対策)
 *   - 文字列内の生の制御文字 (改行/タブ/CR 等) → 対応するエスケープに変換
 * を行い、最後に末尾カンマを除去する。区切りに使われた全角ダブルクォート
 * (“ ”) は半角 " に正規化する (値の中の全角クォートはそのまま残す)。
 *
 * あくまで best-effort。直せない崩れは呼び出し側で null として扱う。
 */
export function repairJson(raw: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    let ch = raw[i];
    // 区切りに使われた全角ダブルクォート (“ ”) は半角 " として扱う (開閉どちらも)。
    // repairJson は厳格パース失敗後にだけ走るので、全角クォート=区切り誤りとみなす。
    if (ch === "“" || ch === "”") ch = '"';
    if (!inStr) {
      if (ch === '"') {
        out += ch;
        inStr = true;
        continue;
      }
      out += ch;
      continue;
    }
    // ── 文字列リテラル内 ──
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next !== undefined && VALID_ESCAPE.has(next)) {
        out += ch + next;
        i++;
      } else {
        // 不正エスケープ (Windows パスの \D 等) → バックスラッシュを二重化。
        out += "\\\\";
      }
      continue;
    }
    if (ch === '"') {
      out += ch;
      inStr = false;
      continue;
    }
    // 生の制御文字 (< 0x20) は JSON 文字列では非許可 → エスケープ。
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += ch;
  }
  // 末尾カンマ ( , } / , ] ) を除去。文字列補正後なので構造カンマのみに効く。
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * 厳格 JSON.parse → 失敗したら repairJson して再パース。
 * どちらも失敗したら null (例外は投げない)。
 */
export function parseLenientJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to repair */
  }
  try {
    return JSON.parse(repairJson(raw));
  } catch {
    return null;
  }
}
