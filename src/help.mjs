import { supervisionSteps } from "./prompt.mjs";

export { VERSION } from "./version.mjs";
import { VERSION } from "./version.mjs";

const supervisionExecutionNotes = [
  "CLI本体と依存をCODEX_HOME/codex-steer/runtimes/<version>-<sha256>へ検証して保存し、そのコピーへの実行コマンドを本文に埋め込みます。supervise promptもこの保存処理を行います。同じ内容は検証して再利用し、既存のコピーは上書き・自動削除しません。保存・検証に失敗した場合は本文を出力せず、Claudeも起動しません。",
  "同じPC・同じCODEX_HOMEで使い、監督中は保存したコピーを保持してください。元のnpxキャッシュやチェックアウトを更新・削除しても、監督は保存した内容を使います。ヘルプ中のcodex-steer表記も、引用とオプションを含む指定の実行コマンドに置き換えてください。",
  "Node本体はコピーせず、開始時の実体への絶対パスと--require-node-versionを各コマンドに埋め込みます。Nodeの版が変われば操作前にNODE_VERSION_MISMATCHで停止します。同じ版のNodeの改変や共有ライブラリまで固定するものではないため、元のNodeは保持してください。保存先やNodeが使えなければ介入を止めて報告し、意図した環境から生成し直すよう指示します。",
];

export const topics = {
  supervise: {
    title: "指定したCodexタスクの監督役としてClaudeを起動する",
    when: "対象タスクのIDを指定して、Claude Codeを監督役の対話セッションとして起動するとき。",
    usage: ["supervise <THREAD> --agent claude [-- <AGENT-ARGS...>]"],
    json_output: false,
    returns: "Claudeの標準入力・標準出力・標準エラーと終了コードを引き継ぎます。codex-steerの出力は混ぜません。",
    examples: ["codex-steer supervise <THREAD> --agent claude", "codex-steer supervise <THREAD> --agent claude -- --model <MODEL> --effort <LEVEL>"],
    notes: [...supervisionExecutionNotes,
      "--agentは必須で、現在はclaudeに対応します。PATH上の実行ファイルを、現在の作業ディレクトリと環境変数を引き継いで起動します。シェルのaliasやfunctionは使いません。", "最初の -- より後ろは全てClaudeの引数です。順序・空文字・空白・改行を保ち、--help/--version/--jsonもcodex-steer側では解釈しません。シェルで再展開しないため、呼び出し元のシェルで必要な引用をしてください。", "渡された追加引数の後ろにClaude側の -- と対象ID入りの監督プロンプトを一つの引数として付加します。追加引数の意味・組み合わせの妥当性はClaudeが判断します。", "不正なID形式、--agentの不足・未対応値、区切り前の未知の引数では起動しません。Claudeが未導入・実行不可などの起動失敗は理由を標準エラーへ出して終了コード1です。Desktopの接続と対象タスクの存在は、起動した監督役が最初に確認します。", "SIGINT/SIGTERM/SIGHUPは起動したClaudeへ転送します。シグナルで終了した場合の終了コードは128+シグナル番号です。", "対話起動のsupervise <THREAD> --agent claudeでは--jsonは非対応です。help supervise --jsonでヘルプを取得でき、supervise prompt <THREAD> --jsonで起動せず監督役（オーケストレーター）向けの本文を取得できます。"],
  },
  "supervise prompt": {
    title: "監督役（オーケストレーター）向けのプロンプトを出力する",
    when: "Claude Codeなどの監督役へ渡す、対象タスク入りの初期プロンプト本文を取得・確認するとき。",
    usage: ["supervise prompt <THREAD>"],
    returns: "通常はプロンプト本文だけを標準出力へ返します。--jsonではdata.thread_id、data.prompt、保存先・版・ハッシュ・再利用の有無を示すdata.deployment、Nodeのパスと版を示すdata.nodeを返します。",
    examples: ["codex-steer supervise prompt <THREAD>", "codex-steer supervise prompt codex://threads/<UUID> --json", "codex-steer supervise <THREAD> --agent claude"],
    notes: [...supervisionExecutionNotes,
      "出力は監督役（オーケストレーター）へ渡す初期指示です。THREADはUUIDまたはcodex://threads/...。IDの書式を確認して正規化し、本文へ埋め込みます。Desktopへの接続・履歴取得・送信・Claudeの起動・設定変更は行いません。タスクの存在と接続は監督開始時に確認します。", "Claudeを起動する場合はsupervise <THREAD> --agent claudeを使います。追加の起動引数は -- の後ろへ渡してください。", "生成される本文はhelp monitorと同じ監督手順です。ユーザーの目的・制約の範囲内で自律介入し、Monitorが使えない場合は短いwatchで観測します。", "生成した本文を既存のClaudeセッションへ貼り付けても使えます。監督停止はそのセッションへ指示してください。プロンプトはCLIやOSの権限設定を変更しません。"],
  },
  monitor: {
    title: "Codexタスクを観測・介入・結果確認の順で監督する",
    when: "ユーザーから対象と範囲を委任され、Claudeなどが継続して進捗を観測し、必要な軌道修正を判断する運用。",
    usage: ["supervise prompt <THREAD>", "watch <THREAD> --stream [--since CURSOR] [--poll-ms N] [--limit N] [--max-chars N] [--include-output]", "read <THREAD> [--since CURSOR]", "help supervise", "help send", "help checkpoint", "help history"],
    returns: "--streamは作業差分（data.type=observation）と接続状態（data.type=connection）をJSON Linesで返します。差分のevents、attention、cursorを読み、必要なときだけ次の操作を選びます。",
    examples: ["codex-steer watch <THREAD> --stream --since <CURSOR> --include-output --json", "codex-steer read <THREAD> --since <LAST-CURSOR> --include-output --json", "codex-steer send <THREAD> '失敗箇所を先に確認してください' --source claude-code --kind review --based-on <CURSOR> --json", "codex-steer history check <THREAD> <MESSAGE-ID> --json"],
    notes: [...supervisionSteps(), "--streamは常にJSON Linesです。初回にwatchingを通知し、平常時は差分だけを出力します。観測成功後の一時切断は1→2→4→8→最大10秒間隔で、接続・初期化・読み取りを含め60秒まで復帰を試みます。初回失敗はすぐ終了します。SIGINT/SIGTERMまたはMonitorのキャンセルで停止し、--until/--timeout-msとは併用しません。", "無効cursorはneeds_review、復帰上限・権限・プロトコル等の異常はfailedを含むok:falseのJSONを返し、終了コード1です。観測の再接続は送信の再試行を行いません。", "既存のログ監視を続け、その通知後にread --sinceを呼ぶ運用も可能です。複数AIの共有リソース利用調整はhelp resourceを参照してください。"],
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
    usage: ["supervise <THREAD> --agent claude [-- <AGENT-ARGS...>]", "supervise prompt <THREAD>", "threads list [--desktop-only] [--limit N]", "status <THREAD>", "read <THREAD> [--since CURSOR] [--limit N]", "watch <THREAD> [--since CURSOR] [--until change|idle|attention]", "send <THREAD> <MESSAGE...> [--new-turn] [--dry-run] [--no-sound]", "doctor [--backend app-server|ui]", "desktop start [--dry-run]", "thread resolve <THREAD>", "open <THREAD>", "debug-ui <THREAD> [--wait-ms N]", "help <COMMAND>"],
    returns: "対話起動のsupervise <THREAD> --agent claudeを除き、各コマンドに --json を付けると、AIやスクリプトが扱えるJSONを返します。supervise promptもJSONに対応します。",
    examples: ["codex-steer supervise <THREAD> --agent claude", "codex-steer threads list --desktop-only --json", "codex-steer read <THREAD> --json", "codex-steer help send"],
    use_cases: [
      { need: "Claudeを対象タスクの監督役にする", command: "help supervise / help monitor" },
      { need: "監督役（オーケストレーター）向けのプロンプトを取得", command: "help supervise prompt" },
      { need: "今の状態・前回からの変化を確認", command: "help read / help status" },
      { need: "Claude CodeのMonitorから使う", command: "help monitor" },
      { need: "根拠や仮説を付けて指示する", command: "help send" },
      { need: "届いたか・対応されたかを確認", command: "help history" },
      { need: "古い診断を訂正・撤回", command: "help instructions" },
      { need: "テストしたソースと成果物を照合", command: "help checkpoint" },
      { need: "画面・Unityなどの利用を調整", command: "help resource" },
    ],
    notes: ["THREADにはUUIDまたはcodex://threads/...を指定します。", "監督役の対話起動: codex-steer supervise <THREAD> --agent claude [-- <AGENT-ARGS...>]。superviseの標準入出力と終了コードはClaudeのものです。", "コマンド別のhelpには、使い所・出力・例・制約を載せています。help自体も --json に対応します。"],
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
    returns: "通常は条件成立または時間切れで1回返します（reason、timed_out、events、cursor）。--streamはdata.type=observationの差分とdata.type=connectionの接続状態をJSON Linesで返します。",
    examples: ["codex-steer watch <THREAD> --since <CURSOR> --json", "codex-steer watch <THREAD> --until idle --timeout-ms 60000 --json"],
    notes: ["既定はchange、30秒待ち、1秒間隔。timeoutは0〜60000ms、pollは250〜10000ms。", "readと同じ差分取得を使います。--full-history は毎回の全取得になるため、通常の監視は既定の方式を使ってください。旧cursorの移行と確認範囲は help read へ。", "--sinceなしのchangeは現在を基準に次の変化を待ちます。idle/attentionは既に成立していればすぐ返します。", "--streamの接続状態はwatching/reconnecting/recovered/needs_review/failedです。観測成功後の一時切断だけ、最大10秒間隔・合計60秒まで同じタスクへ再接続します。通常のwatchと初回接続失敗は再試行しません。", "接続行のresume_cursorはCLIの出力完了位置または初回の基準です。AIの読了確認ではありません。再起動時は監督側が読了済みcursorを指定してください。復帰後もhas_moreなら差分を読み切ります。", "--streamは--until/--timeout-msと併用不可。平常時の定期通知はなく、SIGINT/SIGTERMで接続中・復帰待ちでも停止します。詳細はhelp monitorへ。", "読み取り専用のポーリングです。自動送信・タスク再開・承認回答・常駐登録は行いません。"],
  },
  send: {
    title: "実行中タスクに方針やレビューを伝える",
    when: "単発送信の宛先・内容を指定されたとき、または委任された監督範囲で軌道修正が必要と判断したとき。再開を依頼された停止中タスクには --new-turn を使います。",
    usage: ["send <THREAD> <MESSAGE...> [--new-turn] [--dry-run] [--no-sound] [--backend app-server|ui]", "send <THREAD> <MESSAGE...> [--source NAME] [--kind decision|review|hypothesis|suggestion] [--evidence FILE-OR-URL ...] [--based-on CURSOR] [--supersedes MESSAGE-ID] [--expires-at ISO-TIMESTAMP] [--checkpoint ID]", "<THREAD> <MESSAGE...> [sendと同じオプション]"],
    returns: "acceptedはサーバーの受付です。処理完了や画面への表示を保証するものではありません。",
    examples: ["codex-steer send <THREAD> '失敗したテストの原因を先に確認してください' --dry-run --json", "codex-steer send <THREAD> '競合が原因か確認してください' --source claude --kind hypothesis --evidence results.xml --based-on <CURSOR> --json", "codex-steer send <THREAD> '続けてください' --new-turn --no-sound --json", "printf '%s\\n' '理由' '変更方針' | codex-steer send <THREAD> -"],
    notes: ["MESSAGEに - を指定すると標準入力を読みます。本文中のオプション名は -- の後に置いてください。", "--kindはdecision=ユーザー決定の伝達、review=レビュー、hypothesis=未確定の仮説、suggestion=任意提案です。指定時は送信者・種類・根拠を本文の前に表示します。無指定なら従来の本文をそのまま送ります。", "decisionは送信者の分類で、新しいユーザー承認を作りません。元のユーザー指示を根拠として示してください。", "--based-onはread/statusのcursor。has_more:trueなら読み終えてから指定します。観測位置以降の新しいユーザー入力やターン変更があれば送信を止めます。通常の進捗報告だけでは止めません。根拠ファイルも送信直前にハッシュ照合します。URLは参照のみです。", "dry-runではファイル根拠を読めますが、接続・鮮度確認・保存・送信は行いません。鮮度確認と送信の間の変更を原子的には防げません。", "既定はapp-server。UI操作は --backend ui を明示した場合だけです。--keep-focusと--wait-msはUI専用です。", "送信音は既定でオンです。受付成功時に同梱の短い3音「プルッ」（約0.30秒）を再生します。--no-soundで今回だけ消音します。互換用の--soundはapp-server専用で、--no-soundと併用不可。dry-run・受付失敗・unknown・UI方式では鳴りません。通知設定は変更せず、音量・ミュートはMacの出力設定に従います。再生失敗でも送信成功を維持し、JSONのsound.played/reasonまたは警告で知らせます。", "unknownは受付未確認です。history checkで確認し、自動再送しないでください。"],
  },
  doctor: { title: "接続・実行環境・観測APIを診断する", when: "接続できないとき、監督の開始時、またはDesktop更新後。", usage: ["doctor [--backend app-server|ui]", "doctor --thread <THREAD> [--backend app-server]"], returns: "ready、製品バージョン、connection、runtime_compatibility、desktop_subscription、compatibility.api_checks、failureと復旧案内。", examples: ["codex-steer doctor --json", "codex-steer doctor --thread <THREAD> --json"], notes: ["codex_steer_compatibilityは製品名・版の比較で、違いだけでは停止しません。runtime_compatibilityで通信仕様・機能・操作ごとのsupported/unsupported/unverifiedを返します。新規ターンだけ未対応でも観測と通常送信は継続できます。", "宣言なしの旧環境は読み取りで検証し、未知の送信仕様は試験送信せず停止します。CAPABILITY_UNSUPPORTED/UNVERIFIEDは該当機能、RUNTIME_PROTOCOL_UNSUPPORTED/UNVERIFIEDは共通仕様を確認してください。対象未指定では接続を診断し、観測の互換性はunverifiedです。--threadで指定した対象の読み取り経路を検証します。readyは接続条件と指定された検証の結果です。", "compatibility.statusはverified/unverified/unsupported/failed。verifiedは対象の初回観測に成功したことを表し、履歴全体・送信・画面表示・承認往復の保証ではありません。呼び出していないAPIもunverifiedです。", "--threadはapp-server専用。本文を診断出力に含めず、タスクの再開・送信・承認回答・Desktop再起動・設定変更は行いません。failureにはコードと失敗したメソッドを返します。"] },
  desktop: { title: "共有接続を有効にしてDesktopを起動する", when: "現在の作業を終え、Desktopを終了した後の起動時。", usage: ["desktop start [--dry-run]"], returns: "起動結果とdeployment（保存先、内容ハッシュ、版、再利用の有無）。", examples: ["codex-steer desktop start --dry-run --json", "codex-steer desktop start"], notes: ["呼び出した配布物をCODEX_HOME/codex-steer/runtimes/<version>-<sha256>へ検証して配置し、そのwrapperで起動します。保存先の所有者・権限・リンク・内容を検証し、既存の配置は上書きしません。npxの取得元は@vinhphatfsg/codex-steerです。通常はバージョン指定なしで使えます。特定の版で開始したい場合は、任意でパッケージ名に@バージョンを付けてください。起動と操作の製品版が異なっても、必要な通信・機能仕様が対応していれば使用できます。", "dry-runは接続・配置・起動を行いません。配置ロックが残っている場合は自動で奪わずDEPLOYMENT_BUSYで停止します。", "起動中のDesktopは終了させません。通常起動への復旧は、終了後にDock等から開き直します。"] },
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
  return [`codex-steer ${data.version} — ${data.title}`, "", `使い所: ${data.when}`, ...(data.use_cases ? ["", "目的から選ぶ:", ...data.use_cases.map(x => `  ${x.need} → codex-steer ${x.command}`)] : []), "", "使い方:", ...data.usage.map(x => `  codex-steer ${x}${data.json_output === false || x.startsWith("supervise <") ? "" : " [--json]"}`), "", `確認できること: ${data.returns}`, "", "例:", ...data.examples.map(x => `  ${x}`), "", ...data.notes.map(x => `• ${x}`)].join("\n");
}
