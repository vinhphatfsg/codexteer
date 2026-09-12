export const VERSION = "0.10.0";

export const topics = {
  monitor: {
    title: "Claude CodeのMonitorに変化を渡す",
    when: "Monitorで通知を受け、Claudeが差分を見てレビュー・検証・追加指示を判断する運用。",
    usage: ["watch <THREAD> --stream [--since CURSOR] [--poll-ms N] [--limit N] [--max-chars N] [--include-output]", "read <THREAD> [--since CURSOR]", "help send", "help checkpoint", "help history"],
    returns: "--streamは変化ごとに1行のJSONを返します。data.events、attention、cursorをClaudeが読み、必要なときだけ次の操作を選びます。",
    examples: ["codex-steer watch <THREAD> --stream --poll-ms 1000 --json", "codex-steer read <THREAD> --since <LAST-CURSOR> --json", "codex-steer send <THREAD> '失敗箇所を先に確認してください' --source claude-code --kind review --based-on <CURSOR> --json", "codex-steer history check <THREAD> <MESSAGE-ID> --json"],
    notes: ["Claudeに、例のwatchコマンドをMonitorで実行するよう依頼します。codex-steer側でClaudeやMonitorを起動・設定する処理はありません。", "既存のログ監視を続ける場合は、その通知後にread --sinceを呼ぶだけで使えます。watch --streamへの置換は任意です。", "--streamは常にJSON Linesです。初回は黙って基準を取り、同じ状態や定期的な生存確認を出力しません。開始時の状態も判断する場合は先にreadしてください。", "読み取り直後からの取りこぼしを避けるには、そのcursorをwatch --stream --sinceへ渡します。未取得ページは順に出力します。", "中断まで継続します。SIGINT/SIGTERMまたはMonitorのキャンセルで終了。--until/--timeout-msとは併用しません。切断・古いcursorではエラーを1行返して終了し、自動再接続・再送はしません。", "自分の送信が履歴へ現れただけなら追加送信せず、重複した指摘はhistory/instructionsで確認します。変更通知は新しい承認ではありません。", "検証結果はcheckpoint verify、誤った診断はsend --supersedes、複数AIの利用調整はresourceを使います。各コマンドの詳細はhelp checkpoint、help instructions、help resourceを参照してください。"],
  },
  resource: {
    title: "画面・Unity・Gitなどの利用予定をAI間で共有する",
    when: "複数AIの画面操作、ビルド、コミットが重ならないように調整するとき。",
    usage: ["resource acquire <NAME> --owner NAME [--ttl-ms N] [--thread THREAD] [--reason TEXT] [--condition TEXT]", "resource status <NAME>", "resource list", "resource renew <NAME> --token TOKEN [--ttl-ms N]", "resource release <NAME> --token TOKEN", "resource run <NAME> --owner NAME [--ttl-ms N] [--timeout-ms N] [--include-output] [--condition TEXT] -- <COMMAND> [ARGS...]"],
    returns: "所有者、期限、利用条件のメモ、tokenを返します。競合時は送信やコマンド実行を始めず失敗します。",
    examples: ["codex-steer resource acquire screen --owner claude-code --ttl-ms 120000 --condition 'ユーザーが今回の2分間の画面利用を許可済み' --json", "codex-steer resource run unity-project-a --owner codex --ttl-ms 600000 -- npm test", "codex-steer resource release screen --token <TOKEN> --json"],
    notes: ["同じCODEX_HOMEと同じリソース名を使う参加者間だけの協調用リースです。OSの画面やUnity自体を強制ロックしません。", "ttlの既定は10分、指定範囲は1000〜86400000ms。手動取得はプロセス終了後も期限まで残り、tokenで更新・解放します。古いtokenで新しい所有者の予約は消せません。", "runはコマンド実行中に自動更新し、終了時に解放します。更新に失敗したら自分が起動したコマンド群を終了します。コマンドは -- の後へ置き、シェル展開しません。", "--conditionは許可済み条件の記録です。入力アイドルや取得成功だけで画面利用の許可を生成しません。", "実行時間を制限する場合は--timeout-ms（最大86400000、既定0=制限なし）。runが異常終了した場合はリース期限後に再取得できます。"] },
  checkpoint: {
    title: "検証したソースと結果・成果物を結び付ける",
    when: "テスト結果が最終ソースのものか確認するとき、またはビルド前に検証の有効性を確認するとき。",
    usage: ["checkpoint capture <THREAD> <NAME> --path PATH [--path PATH ...] [--exclude PATH ...]", "checkpoint run <THREAD> <ID> [--timeout-ms N] [--include-output] -- <COMMAND> [ARGS...]", "checkpoint attach <THREAD> <ID> --artifact FILE [--artifact FILE ...]", "checkpoint verify <THREAD> <ID>", "checkpoint list <THREAD>", "checkpoint show <THREAD> <ID> [--include-output]"],
    returns: "captureはIDと入力ハッシュ、runは終了コードと入力変更、verifyは入力・最新実行・成果物の一致を返します。valid=falseならrun/verifyの終了コードは1です。",
    examples: ["codex-steer checkpoint capture <THREAD> tests --path src --path test --path package.json --path package-lock.json --json", "codex-steer checkpoint run <THREAD> <ID> -- npm test", "codex-steer checkpoint attach <THREAD> <ID> --artifact test-results.xml --json", "codex-steer send <THREAD> 'この検証結果で次へ進んでください' --checkpoint <ID> --json"],
    notes: ["--pathはファイルかディレクトリ。配下の追加・削除も検知します。.gitは除外。--excludeは実パスで、globではありません。出力先・キャッシュは入力から除外してください。ディレクトリのシンボリックリンクは実体を明示してください。", "コマンドはcaptureした作業場所で、シェル展開せず引数どおりに実行します。timeoutの既定0は制限なし、最大86400000ms。割り込み・timeoutは自分が起動したプロセス群を終了します。", "実行前後のハッシュと実行中のファイル監視を記録します。途中編集・監視エラーは有効な検証にしません。厳密な固定には隔離した入力を使ってください。", "成果物は最新の成功実行後に明示的にattachします。自動で生成元を証明するものではありません。URL・ディレクトリは成果物にできません（アプリはZIP等のファイルで指定）。", "validは選択した入力とコマンドの結果の整合性です。テスト範囲の十分性や配布許可は認定しません。ログ末尾32K文字はローカル保存し、--include-outputで表示します。", "--checkpointをsendに付けると送信直前にも照合し、無効なら送信を止めます。"] },
  instructions: {
    title: "現在有効な指示を確認し、古い指示を訂正する",
    when: "診断を撤回するとき、方針が変わったとき、長い会話で今の決定を確認するとき。",
    usage: ["instructions list <THREAD> [--all]", "send <THREAD> <NEW-MESSAGE> --supersedes <MESSAGE-ID> [--expires-at ISO-TIMESTAMP]", "instructions retract <THREAD> <MESSAGE-ID> --reason TEXT [--source NAME] [--based-on CURSOR] [--new-turn] [--dry-run]"],
    returns: "listは現在有効な指示の本文と、配送未確認の変更を返します。--allは置換済み・撤回済み・期限切れも含めます。",
    examples: ["codex-steer instructions list <THREAD> --json", "codex-steer send <THREAD> '先ほどの診断を訂正します。原因は復帰処理です' --supersedes <MESSAGE-ID> --kind review --source claude-code --json", "codex-steer instructions retract <THREAD> <MESSAGE-ID> --reason '再計測で仮説を否定できた' --json"],
    notes: ["IDはhistory listで確認します。同じタスクに送った指示だけを指定できます。", "置換・撤回は相手にもメッセージを送ります。元の履歴は削除しません。--dry-runは送信・保存しません。", "受付不明なら旧指示を確定撤回しません。history checkで保存を確認するまでpending_changesへ表示し、重ねて置換しません。", "--expires-atは時差付きISO日時。期限は補助側の有効一覧に適用され、相手の処理を自動停止するものではありません。", "受付・保存確認は、相手が方針変更を理解した証明ではありません。必要ならhistory markで明示的な応答を記録してください。"],
  },
  history: {
    title: "送った指示の配送と対応状況を追う",
    when: "受付不明の送信を確認するとき、または未対応の指摘を洗い出すとき。",
    usage: ["history list <THREAD> [--pending] [--include-text]", "history show <THREAD> <MESSAGE-ID> [--include-text]", "history check <THREAD> [MESSAGE-ID] [--include-text]", "history mark <THREAD> <MESSAGE-ID> --status acknowledged|applied|dismissed --note TEXT [--evidence REF ...] [--by NAME]"],
    returns: "delivery_statusは受付、verification.status=storedは受信履歴との一致、responseは記録者が申告した対応状況です。これらを別々に返します。",
    examples: ["codex-steer history list <THREAD> --pending --json", "codex-steer history check <THREAD> <MESSAGE-ID> --json", "codex-steer history mark <THREAD> <MESSAGE-ID> --status applied --note '対象の回帰テストが通過' --evidence test-results.xml --by reviewer --json"],
    notes: ["この版以降のapp-server送信をCODEX_HOME/codex-steerに保存します。本文はローカルの0600ファイルに保存し、表示は --include-text 指定時のみ。", "IDは送信結果のmessage_id/client_message_idです。unknownでもIDを保存します。checkは照合だけで再送しません。", "not_observedは未配送の証明ではありません。storedもモデルの理解や反映を証明しません。", "appliedの申告には根拠参照が必須です。根拠の妥当性を自動認定する機能ではありません。UI方式は追跡対象外です。"],
  },
  overview: {
    title: "別のAIと、Codexタスクの進行を共有する",
    when: "タスクを探す → 現状を読む → 指示を送る → 変化を確認する、という順で使います。",
    usage: ["threads list [--desktop-only] [--limit N]", "status <THREAD>", "read <THREAD> [--since CURSOR] [--limit N]", "watch <THREAD> [--since CURSOR] [--until change|idle|attention]", "send <THREAD> <MESSAGE...> [--new-turn] [--dry-run]", "doctor [--backend app-server|ui]", "desktop start [--dry-run]", "thread resolve <THREAD>", "open <THREAD>", "debug-ui <THREAD> [--wait-ms N]", "help <COMMAND>"],
    returns: "各コマンドに --json を付けると、AIやスクリプトが扱えるJSONを返します。",
    examples: ["codex-steer threads list --desktop-only --json", "codex-steer read <THREAD> --json", "codex-steer help send"],
    use_cases: [
      { need: "今の状態・前回からの変化を確認", command: "help read / help status" },
      { need: "Claude CodeのMonitorから使う", command: "help monitor" },
      { need: "根拠や仮説を付けて指示する", command: "help send" },
      { need: "届いたか・対応されたかを確認", command: "help history" },
      { need: "古い診断を訂正・撤回", command: "help instructions" },
      { need: "テストしたソースと成果物を照合", command: "help checkpoint" },
      { need: "画面・Unityなどの利用を調整", command: "help resource" },
    ],
    notes: ["THREADにはUUIDまたはcodex://threads/...を指定します。", "コマンド別のhelpには、使い所・出力・例・制約を載せています。help自体も --json に対応します。"],
  },
  read: {
    title: "直近の発言・コマンド・変更ファイルを読む",
    when: "レビューや追加指示を送る前、または前回の観測から何が変わったかを確認するとき。",
    usage: ["read <THREAD> [--since CURSOR] [--limit N] [--max-chars N] [--include-output] [--full-history]"],
    returns: "events、状態、次回用cursor。初回は直近50件。--sinceは未取得の新規・更新項目を古い順に返します。has_moreなら返されたcursorで続けて読めます。",
    examples: ["codex-steer read <THREAD> --json", "codex-steer read <THREAD> --since <CURSOR> --include-output --json", "codex-steer read <THREAD> --full-history --since <V1-CURSOR> --json"],
    notes: ["--limitは1〜1000（既定50）、--max-charsは100〜20000（既定2000）。",
      "通常は直近のページと、追跡中の実行項目だけを取得します。長文タスクでも毎回の全取得を避けられます。初回だけは実行中ターンを調べ、表示範囲より前のコマンドも追跡します。",
      "観測対象は履歴APIに現れた項目です。Codexの版によっては実行開始通知の後、コマンドが完了してから履歴に現れる場合があります。",
      "has_more:trueならchanged:falseでも、返されたcursorで続きを読んでください。読み終えてから判断・送信します。running_commands_complete:falseは差分の読み残しがある状態です。",
      "history_scope=tail-and-tracked-itemsはターン列・末尾・追跡項目の確認です。過去全文の書き換え検出には --full-history を使います（表示件数は同じ、取得は遅くなります）。古い形式のタスクも全取得になります。",
      "旧v1 cursorの未読差分を継続するには --full-history。高速方式に切り替える場合は --since を外して現状をレビューし、新しいcursorを保存します。v1とv2は混在できません。",
      "omitted_older_events:nullは省略した古い項目の件数が未集計です。件数のための全取得は行いません。",
      "内部推論は出力しません。コマンド出力・差分本文は --include-output 時のみ表示します。",
      "観測でタスクを再開・送信・前面化しません。巻き戻しや追跡位置の不一致を検出したcursorは拒否するので、原因を確認してから --since を外して読み直してください。"],
  },
  status: {
    title: "実行中・停止中・承認待ちを確認する",
    when: "今ステアできるか、新規ターンが必要か、ユーザーの応答が必要かを判断するとき。",
    usage: ["status <THREAD> [--full-history]"],
    returns: "status、active_turn_id、attention、実行中コマンド、cursor。状態が取得できない場合はunknownとします。",
    examples: ["codex-steer status <THREAD> --json"],
    notes: ["readと同じページ取得方式を使い、返したcursorから read --since へ進めます。初回の実行中コマンド探索と --full-history の詳細は help read へ。", "notLoadedは保存済みタスクが未ロードという意味です。statusはロードしません。", "承認や質問には回答しません。attentionはApp Serverが報告した状態で、本文から推測しません。"],
  },
  watch: {
    title: "変化・完了・ユーザー対応待ちまで待つ",
    when: "同じログを繰り返し読まず、次のレビューが必要なタイミングを待ちたいとき。",
    usage: ["watch <THREAD> [--since CURSOR] [--until change|idle|attention] [--timeout-ms N] [--poll-ms N] [--limit N] [--max-chars N] [--include-output] [--full-history]", "watch <THREAD> --stream [--since CURSOR] [--poll-ms N] [--limit N] [--max-chars N] [--include-output] [--full-history]"],
    returns: "通常は条件成立または時間切れで1回返します（reason、timed_out、events、cursor）。--streamは変化ごとに1行のJSONを出し続けます。",
    examples: ["codex-steer watch <THREAD> --since <CURSOR> --json", "codex-steer watch <THREAD> --until idle --timeout-ms 60000 --json"],
    notes: ["既定はchange、30秒待ち、1秒間隔。timeoutは0〜60000ms、pollは250〜10000ms。", "readと同じ差分取得を使います。--full-history は毎回の全取得になるため、通常の監視は既定の方式を使ってください。旧cursorの移行と確認範囲は help read へ。", "--sinceなしのchangeは現在を基準に次の変化を待ちます。idle/attentionは既に成立していればすぐ返します。", "--streamは中断までJSON Linesで変化だけを通知します。--until/--timeout-msと併用不可。Claude Code向けの手順はhelp monitorへ。", "読み取り専用のポーリングです。自動送信・再開・承認回答・常駐登録は行いません。"],
  },
  send: {
    title: "実行中タスクに方針やレビューを伝える",
    when: "宛先と送る内容が決まったとき。停止中のタスクを続けるときだけ --new-turn を使います。",
    usage: ["send <THREAD> <MESSAGE...> [--new-turn] [--dry-run] [--backend app-server|ui]", "send <THREAD> <MESSAGE...> [--source NAME] [--kind decision|review|hypothesis|suggestion] [--evidence FILE-OR-URL ...] [--based-on CURSOR] [--supersedes MESSAGE-ID] [--expires-at ISO-TIMESTAMP] [--checkpoint ID]", "<THREAD> <MESSAGE...> [sendと同じオプション]"],
    returns: "acceptedはサーバーの受付です。処理完了や画面への表示を保証するものではありません。",
    examples: ["codex-steer send <THREAD> '失敗したテストの原因を先に確認してください' --dry-run --json", "codex-steer send <THREAD> '競合が原因か確認してください' --source claude --kind hypothesis --evidence results.xml --based-on <CURSOR> --json", "codex-steer send <THREAD> '続けてください' --new-turn --json", "printf '%s\\n' '理由' '変更方針' | codex-steer send <THREAD> -"],
    notes: ["MESSAGEに - を指定すると標準入力を読みます。本文中のオプション名は -- の後に置いてください。", "--kindはdecision=ユーザー決定の伝達、review=レビュー、hypothesis=未確定の仮説、suggestion=任意提案です。指定時は送信者・種類・根拠を本文の前に表示します。無指定なら従来の本文をそのまま送ります。", "decisionは送信者の分類で、新しいユーザー承認を作りません。元のユーザー指示を根拠として示してください。", "--based-onはread/statusのcursor。has_more:trueなら読み終えてから指定します。観測位置以降の新しいユーザー入力やターン変更があれば送信を止めます。通常の進捗報告だけでは止めません。根拠ファイルも送信直前にハッシュ照合します。URLは参照のみです。", "dry-runではファイル根拠を読めますが、接続・鮮度確認・保存・送信は行いません。鮮度確認と送信の間の変更を原子的には防げません。", "既定はapp-server。UI操作は --backend ui を明示した場合だけです。--keep-focusと--wait-msはUI専用です。", "unknownは受付未確認です。history checkで確認し、自動再送しないでください。"],
  },
  doctor: { title: "接続と起動条件を診断する", when: "接続できないとき、または初回設定後。", usage: ["doctor [--backend app-server|ui]"], returns: "readyと各チェック結果。", examples: ["codex-steer doctor --json"], notes: ["Desktopの再起動や設定変更は行いません。readyは接続条件の確認です。"] },
  desktop: { title: "共有接続を有効にしてDesktopを起動する", when: "現在の作業を終え、Desktopを終了した後の起動時。", usage: ["desktop start [--dry-run]"], returns: "起動結果。", examples: ["codex-steer desktop start --dry-run --json", "codex-steer desktop start"], notes: ["起動中のDesktopは終了させません。通常起動への復旧は、終了後にDock等から開き直します。"] },
  threads: { title: "送信先のタスクを探す", when: "宛先の正確なIDを確認するとき。", usage: ["threads list [--desktop-only] [--limit N]"], returns: "ローカルタスクのID、作業場所、更新日時。", examples: ["codex-steer threads list --desktop-only --limit 20 --json"], notes: ["CODEX_HOMEに従います。本文は読みません。"] },
  thread: { title: "タスクURLをIDに変換する", when: "コピーしたURLをスクリプトで利用するとき。", usage: ["thread resolve <THREAD>"], returns: "正規化したthread_idとdeep_link。", examples: ["codex-steer thread resolve codex://threads/<UUID> --json"], notes: ["IDの書式を確認します。タスクの存在確認はstatusを使ってください。"] },
  open: { title: "タスクをDesktopで開く", when: "ユーザーが画面でタスクを見たいとき。", usage: ["open <THREAD>"], returns: "開いたタスクのURL。", examples: ["codex-steer open <THREAD>"], notes: ["画面を操作する明示的なコマンドです。"] },
  "debug-ui": { title: "UI送信のために画面構造を調べる", when: "明示的なUI方式を診断するとき。", usage: ["debug-ui <THREAD> [--wait-ms N]"], returns: "Accessibilityの診断情報。", examples: ["codex-steer debug-ui <THREAD> --wait-ms 1500"], notes: ["画面を操作します。通常のバックグラウンド送信には不要です。"] },
};

export function helpData(topic = "overview") {
  const data = topics[topic];
  if (!data) throw new Error(`Unknown help topic: ${topic}. Run codex-steer help.`);
  return { version: VERSION, topic, ...data, ...(topic === "overview" ? { usage: [...data.usage, "history list|show|check|mark <THREAD> ...", "instructions list|retract <THREAD> ...", "checkpoint capture|run|attach|verify|list|show <THREAD> ...", "resource acquire|status|list|renew|release|run ..."] } : {}) };
}

export function renderHelp(data) {
  return [`codex-steer ${data.version} — ${data.title}`, "", `使い所: ${data.when}`, ...(data.use_cases ? ["", "目的から選ぶ:", ...data.use_cases.map(x => `  ${x.need} → codex-steer ${x.command}`)] : []), "", "使い方:", ...data.usage.map(x => `  codex-steer ${x} [--json]`), "", `確認できること: ${data.returns}`, "", "例:", ...data.examples.map(x => `  ${x}`), "", ...data.notes.map(x => `• ${x}`)].join("\n");
}
