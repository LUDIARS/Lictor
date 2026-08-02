export type VestigiumModule = {
  // 戻り値を `void | Promise<void>` にしてあるのは、 install が非同期化されても
  // reject を下の try/catch で受け止められるようにするため (await し損ねた rejection は
  // unhandled になり、 縮退どころか session control ごと落とし得る)。
  install(options: {
    serviceCode: string;
    captureConsole: boolean;
    pinoTransport: boolean;
  }): void | Promise<void>;
};

// `: string` (not a literal type) は意図的。 tsc に specifier を静的解決させないことで、
// gitignore されている `lib/vestigium/dist/*.d.ts` の有無に build が依存しなくなる。
// literal に戻すと、この module が吸収しようとしている 「dist が無い」 状態が
// そのまま typecheck 失敗として再発する。
const VESTIGIUM_SPECIFIER: string = "@ludiars/vestigium";

/**
 * Observability must not be a hard dependency of the session-control CLI.
 *
 * `@ludiars/vestigium` is a local submodule package whose ignored dist can be
 * absent briefly after checkout/update. A static import made every command,
 * including `lictor cli task set`, fail before it could reach the sidecar.
 *
 * 読み込み・install のどちらで失敗しても縮退する (観測が無いだけで session control は
 * 継続する)。 縮退理由は `LICTOR_DEBUG=1` のときだけ stderr に出す — hook 経路の
 * stdout/stderr を汚さないため。
 *
 * 縮退条件は spec/setup/setup.md「観測 (Vestigium) は best-effort」、 呼び出し境界
 * (短命な `lictor cli ...` からは読まない) は spec/feature/task-protocol.md
 * 「CLI entrypoint の責務境界」 を正本とする。
 *
 * @param load テスト用の差し替え口。 既定は実 package の dynamic import。
 *
 * @implements SETUP-VESTIGIUM-OPTIONAL (spec/setup/setup.md)
 */
export async function installVestigiumBestEffort(
  load: () => Promise<unknown> = () => import(VESTIGIUM_SPECIFIER),
): Promise<void> {
  try {
    const module = (await load()) as VestigiumModule;
    await module.install({
      serviceCode: "lictor",
      captureConsole: true,
      pinoTransport: false,
    });
  } catch (error) {
    if (process.env.LICTOR_DEBUG === "1") {
      // 縮退理由は必ず 1 行。 module 解決エラーの message は複数行になることがあるため
      // 潰す (hook 経路の stderr を行単位で読む側を壊さない)。 stderr は端末に直結する
      // ので C0/DEL も落とす — escape sequence を素通りさせない (osc.ts と同じ扱い)。
      const reason = (error instanceof Error ? error.message : String(error))
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
      try {
        process.stderr.write(`[lictor] Vestigium unavailable; continuing without log capture: ${reason}\n`);
      } catch {
        // stderr may already be closed (parent terminal gone / EPIPE)。 縮退の
        // 通知が session control を落とすのは本末転倒なので握り潰す (osc.ts と同じ)。
      }
    }
  }
}
