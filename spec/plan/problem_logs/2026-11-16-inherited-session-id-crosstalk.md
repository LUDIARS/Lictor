# 2026-11-16 Cc 再起動後に inject が同じ cwd の別セッションへ誤配された

- Actio: actio:f34a9a40-7888-42d4-9768-89b0e69f9809
- 症状: 2026-11-16 21:00 JST 頃 Concordia 再起動後、Cc が lictor-9f9a75a2 宛てに送った inject (HTTP 200) が、同じ cwd (`E:/Document/Ars/Concordia`) で動く lictor-87a363c0 の会話に入った。

## 調査

- WebSocket の再接続 (`LivenessHandle`) は、生成時に受け取った id を保持して再接続する。process.env や cwd から id を引き直す経路は無い。
- 受信側 (`event-reactor.ts`) も `target_session_id === ownSessionId` で照合している。
- 漏れは `wrap.ts` の子 env 組み立てにあった。`LICTOR_SESSION_ID` / `CONCORDIA_SESSION_ID` は Concordia 登録が成功したときだけ上書きされていた。Concordia の再起動中に Lictor を起動して登録に失敗すると、起動元 (別の Lictor セッションのシェル、またはそこから再起動した Concordia) から継承した **別セッションの id** がそのまま wrapped claude に渡る。
- wrapped claude の SessionStart hook (`claude-transcript-<id>.txt` を書く) や concordia skill / `lictor cli` は、この env の id を自分の id として使う。そのため、継承した id のセッションとして振る舞ってしまう (transcript の束縛先の上書き、別 id での報告など)。

## 対処

- `src/session-identity-env.ts` の `pinSessionIdentityEnv` を追加した。子 env の識別キーを、自プロセスが登録した id に固定する。未登録なら継承値を削除する。
- `wrap.ts` の子 env 組み立てをこの関数に通す。
- 回帰テスト: `tests/session-identity-env.test.ts`。契約: C-5。

## 残り (別タスク候補)

- Concordia 未登録で起動した Lictor は、その後 Concordia が復帰しても再登録しない (無連携のまま動く)。
- `CONCORDIA_DELEGATION_RUN_ID` / spawn 識別子も process.env から継承して register に載せるので、委託セッション内から別の Lictor を起動すると、同じ run の子として登録されうる。
