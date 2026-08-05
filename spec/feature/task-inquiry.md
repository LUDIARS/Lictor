# completion 通知からのお伺い送信

Lictor は作業完了の意味判断を行わない。Concordia の completion ブラックボックスが
`taskflow.completion_detected` を通知し、その `session_id` が自身と一致した場合だけ
`POST /v1/inquiry` を送る。

送信 category は固定語彙 `タスク`。context は active repo、branch、未commit差分の有無、
通知に含まれる直近PR、現在taskを固定順で機械的に整形する。Cc が未更新で404を返す場合や
一時停止中は best-effort で握り、wrapped CLI の処理を止めない。

設計正本は Concordia `spec/feature/inquiry.md` §6。
