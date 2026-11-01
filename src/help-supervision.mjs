const THREAD_OPTION = { name: "THREAD", text: "対象タスク。ローカルUUID、codex://threads/<UUID>[?hostId=...]、Cloudのtask_ IDか公式タスクURL、Desktop Cloudのdurable_ IDかhostId=durableのリンク。正規化して本文に埋め込む。" };
const MESSAGE_OPTION = { name: "MESSAGE", default: "標準方針", text: "監督方針。指定すると標準方針全体を置き換える。引用して一つの引数で渡す。空白だけはINVALID_SUPERVISION_POLICY、--で始まる文は引数エラー。" };
const AGENT_IDENTITY = "監督IDのowner（register --owner）と本文のsend --source（claudeはclaude-code）にもなる。claude/codex以外は生成前に拒否する（エラーコードなし）。";
const CONNECTION_OPTION = { name: "--connection shared|desktop|cloud|desktop-cloud", default: "shared", text: "本文の全コマンドに埋め込む接続。sharedは既存wrapper、desktopは既存の共有制御ソケットで観測専用。省略時、task_ IDはcloud、durable_ IDはdesktop-cloudを選び、同じ監督・送信・観測を使う。明示値がIDと合わなければ拒否し、切り替えない。詳細はhelp connection・help cloud。" };
const PATH_CLI_TEXT = "本文のコマンドをPATH上のcodexteerにする。CLIの保存・Nodeの固定・CODEX_HOMEの埋め込みをせず、各コマンドは実行環境のPATHとCODEX_HOMEを使う。CLIの更新は次の実行から反映される。";
const AGENT_ARGS_OPTION = { name: "-- <AGENT-ARGS...>", text: "最初の -- 以降はすべて起動するエージェントの引数。codexteerは--help/--version/--jsonも解釈しない。MESSAGE/GOALとcodexteer自身のオプションは -- より前に置く。" };
const REMOTE_OPTIONS = [
  { name: "--host HOST-ID", text: "リモートの対象を選ぶ。hostId付きリンクでも選べ、両方が違えばHOST_MISMATCH。リモートでは--connectionはsharedだけ。詳細はhelp remote。" },
  { name: "--remote-transport native|control|paired", default: "native", text: "nativeは観測専用の監督を生成する。controlはRemote Control v3で既存activeターンへexpectedTurnId付きで介入する（help remote-control）。pairedは専用鍵の経路（help remote-device）。" },
  { name: "--context-thread LOCAL-THREAD", default: "CODEX_THREAD_ID", text: "ローカルの呼出し元タスク。nativeでは必須で、どちらもなければREMOTE_CONTEXT_REQUIRED。値があれば全コマンドに埋め込む。" },
];
const PROJECT_OPTION = { name: "--project ID|NAME", text: "必須。対象プロジェクトのIDか完全一致名。生成時は照合せず、本文を受けたオーケストレーターがprojects listで照合する。" };
const GOAL_TEXT = "達成したい目標。引用した一つの引数か、標準入力を読む -。改行・引用符・プレースホルダーは評価せずそのまま本文に入れる。";

const LAUNCH_RETURNS = "起動したエージェントの標準入力・標準出力・標準エラーと終了コードをそのまま引き継ぎ、codexteerの出力は混ぜない。シグナル終了は128+シグナル番号。起動失敗と引数エラーは標準エラーに「codexteer: 理由」だけを出し（エラーコードは出ない）、終了コード1。";

const SESSION_ERRORS = [
  { code: "SUPERVISOR_CONFLICT", when: "registerした対象に別のactive/paused監督がいる（異常終了で残った登録を含む）。または同じ監督IDが別タスクに登録済み。", action: "置き換えずユーザーに知らせる。不要な旧監督はユーザーがsupervise stopしてから、新しい本文で始める。" },
  { code: "SUPERVISOR_STOPPED", when: "停止済みの監督IDでregister・観測・送信した。またはstoppedの監督をpause/resumeした。", action: "その監督を終了する。停止済みIDは復活しないため、必要なら新しい本文を生成する。" },
  { code: "SUPERVISOR_MISMATCH", when: "コマンドの監督ID・--connection・remote transportが登録と違う（古い本文や別セッション）。", action: "その監督を終了する。生成されたコマンドを変えずに使っていたか確認する。" },
  { code: "SUPERVISOR_NOT_REGISTERED", when: "register前に監督ID付きで観測・送信した。または未登録のタスクをpause/resume/stopした。", action: "本文の開始手順どおりsupervise registerしてから操作する。" },
  { code: "SUPERVISOR_PAUSED", when: "pause中に監督ID付きで送信した。", action: "観測だけ続け、ユーザーがresumeするまで送信しない。自分で解除しない。" },
  { code: "SUPERVISOR_CONTROL_FORBIDDEN", when: "監督ID付きでsupervise list/pause/resume/stopを実行した。", action: "制御はユーザーが端末から--supervisorなしで行う。監督は自分の状態を変えない。" },
  { code: "SUPERVISOR_INVALID", when: "監督IDがUUID形式でない、--ownerが「英数字で始まる英数字._-の1〜80文字」でない、または保存された監督記録が不正。", action: "生成された値をそのまま使う。記録が不正なら介入を止めてユーザーに報告する。" },
  { code: "RECORD_BUSY", when: "送信などで同じタスクの監督記録がロック中にpause/resume/stopした。", action: "配送結果を確認してから制御を再実行する。成功するまで停止済みと扱わない。" },
];
const LAUNCHER_ERRORS = [
  { code: "SUPERVISOR_ORPHANED", when: "直接起動したsuperviseのプロセスが終了したのに、登録がactive/pausedのまま残っている。", action: "その監督を終了する。ユーザーがsupervise statusで確認してstopし、新しく始める。" },
  { code: "PERMISSION_DENIED", when: "sandboxが起動元プロセスの生存確認を拒否した（status/list・監督ID付きコマンド）。", action: "生存を推測しない。ユーザーの端末か、通常のコマンド承認で同じコマンドを実行する。" },
];
const GENERATION_ERRORS = [
  { code: "INVALID_SUPERVISION_POLICY", when: "MESSAGEが空、または空白だけ。", action: "方針文を入れるか、MESSAGEを省略して標準方針を使う。" },
  { code: "CLOUD_TARGET_CONFLICT", when: "明示した--connectionがタスクIDの種類と合わない（例: task_ IDにshared/desktop）。Cloudタスクに--host等を付けた場合も。", action: "error.expected_connectionの接続で指定し直すか、--connectionを省略する。Cloudタスクには--host・--remote-transport・--context-threadを付けない。自動では切り替わらない。" },
  { code: "CLOUD_OPTIONS_INVALID", when: "ローカルUUIDかdurable_ IDに--connection cloudを付けた。Cloud経路での引数の不足・過剰も同じコード。", action: "error.expected_connectionがあればその接続で指定し直す。なければusageどおりに引数を直す。" },
  { code: "REMOTE_CONTEXT_REQUIRED", when: "nativeリモートの生成で--context-threadもCODEX_THREAD_IDもない。", action: "Codex内で実行するか、--context-thread <ローカルUUID>を付ける。" },
  { code: "REMOTE_CONTEXT_INVALID", when: "--context-threadが別ホストのリンク。読取り時は保存済みターンのあるローカルタスクでない場合も。", action: "保存済みターンを持つローカルタスクを指定し直す。" },
  { code: "HOST_CONNECTION_MISMATCH", when: "リモート対象にshared以外の--connectionを指定した。", action: "--connectionを省略する（shared）。" },
];
const SAVED_CLI_ERRORS = [
  { code: "DEPLOYMENT_BUSY", when: "同じ版の保存処理のロック（runtimes/.install-<id>）が約5秒たっても解放されない。", action: "同時実行の終了を待って再実行する。残り続けるならユーザーにロックの確認を求める。自動では奪わない。" },
  { code: "DEPLOYMENT_MODIFIED", when: "保存済みCLIの中身が実行中の配布物と一致しない、または不完全。", action: "本文は出力されない。自動で上書き・削除しないため、ユーザーに報告する。" },
  { code: "DEPLOYMENT_UNSAFE", when: "CODEX_HOME・保存先・配布物の所有者・権限・リンク・種類が安全条件を満たさない。", action: "権限等を直してから再実行する。自動修復はしない。" },
  { code: "SUPERVISION_PATH_UNSAFE", when: "埋め込むパス（CODEX_HOME・Node・保存先など）に制御文字がある。", action: "制御文字のないパスの環境から生成し直す。" },
  { code: "NODE_VERSION_MISMATCH", when: "保存済みCLI方式の本文のコマンドを、生成時と違う版のNodeで実行した。", action: "介入を止めて報告し、使うNodeから本文を生成し直す。" },
];
const ORCHESTRATION_ERRORS = [
  { code: "PROJECT_REQUIRED", when: "--projectがない、または空白だけ。", action: "プロジェクトIDか完全一致名を指定する（一覧はprojects list）。" },
  { code: "INVALID_ORCHESTRATION_PROJECT", when: "--projectに制御文字がある。", action: "制御文字のないIDか名前を指定する。" },
  { code: "INVALID_ORCHESTRATION_GOAL", when: "GOALが空、または空白だけ。", action: "目標を一つの引数か標準入力の - で渡す。" },
  { code: "INVALID_ORCHESTRATION_AGENT", when: "--agentがclaude/codex以外。", action: "claudeかcodexを指定する。orchestrate promptでは省略もできる。" },
  { code: "SUPERVISOR_CONTROL_FORBIDDEN", when: "--supervisor付きで実行した。監督IDは既存の1タスクに束縛されている。", action: "監督IDを外し、ユーザーの端末から実行する。" },
  { code: "DESKTOP_READ_ONLY", when: "--connection desktopを指定した。", action: "--connectionを省略する（shared）。" },
  { code: "CLOUD_CAPABILITY_UNSUPPORTED", when: "--connection cloudかdesktop-cloudを指定した。Cloud経路にorchestrateはない。", action: "--connectionを省略する。Cloudの作業はhelp cloud / help desktop-cloud。" },
  { code: "REMOTE_READ_ONLY", when: "既定のnative経路で--hostを指定した。", action: "リモートでは--remote-transport pairedを明示する（help remote）。" },
];

const LAUNCH_NOTES = [
  "PATH上のclaudeまたはcodexを、現在の作業ディレクトリ・環境変数・端末入出力のまま起動する。シェルのalias・functionは使わない。",
  "エージェント引数は順序・空文字・空白・改行を保ち、シェルで再展開しない。必要な引用は呼び出し元のシェルで行う。",
  "エージェント引数の後ろに、エージェント側の -- と生成本文を一つの引数として追加する。引数の意味と組み合わせの妥当性はエージェントが判断する。",
  "SIGINT/SIGTERM/SIGHUPは起動したエージェントへ転送する。",
  "起動側はDesktopへ接続しない。接続と対象の確認は、起動したエージェントが本文の開始手順で行う。",
];
const SESSION_NOTES = [
  "生成のたびに新しい監督ID（--supervisor）を作り、--connectionとともに本文の全コマンドへ埋め込む。",
  "superviseは起動前にregisterし、エージェント終了時にstopする。supervise promptは未登録で、受け取った側が本文のregisterを実行して開始する。",
  "同じ監督IDの再registerは状態を変えない（pausedは解除しない）。停止済みIDは復活しない。",
  "pauseは送信だけを止め、read/watchは続けられる。resumeで送信を再開する。stopはその監督IDの観測と送信を止める。",
  "pause/stopはCodexタスクもエージェントのプロセスも止めない。エージェントを終えるには、そのエージェントに終了を指示する。",
  "list/pause/resume/stopはユーザーの端末から--supervisorなしで実行する。監督IDを付けられる監督サブコマンドはregisterとstatusだけ。",
  "監督IDを付けたsupervise/supervise promptは拒否する。監督は代わりのセッションを作れない。",
  "activeは登録状態であり、AIが読んだことや監視を続けていることの証明ではない。",
  "--supervisorのないコマンド（以前の版の本文を含む）にはpause/stopが効かない。監督IDは秘密ではなく、同じOSユーザーの別操作は防がない。",
  "desktop接続とnativeリモートの本文は観測専用。送信手順を含まず、方針に送信の指示があっても送信しない。",
  "観測専用の本文では、MESSAGE省略時の方針も観測と報告だけになる（介入しない）。",
  "標準方針は、目的・制約の範囲での必要最小限の介入と結果確認、簡潔な報告。",
  "MESSAGEを指定しても、対象ID・実行コマンド・開始/観測/介入/停止の手順は本文に残る。手順はhelp monitorと共通。",
  "MESSAGEは改行等もそのまま本文に入れ、プレースホルダー展開やシェル実行はしない。今回の生成だけに使い、既定設定や保存済みCLIは変えない。",
  "controlの本文は既存activeターンへの介入だけで、new-turn・UI送信・自動再送はしない。端末鍵を使えなければ接続前に止まる（help remote-control）。",
  "リモートの本文は全コマンドで同じ--host・--remote-transport・--context-threadを保持する。",
];
const SAVED_CLI_NOTES = [
  "既定ではCLI一式と依存をCODEX_HOME/codex-steer/runtimes/<version>-<sha256>へ検証して保存し、そのコピーを本文のコマンドに使う。",
  "同じ内容の保存先があれば検証して再利用する。既存のコピーは上書き・自動削除しない。",
  "保存・検証に失敗すると本文を出力せず、エージェントも起動しない。",
  "本文の各コマンドは、生成時に検証したCODEX_HOMEの実体パス、Nodeの実体の絶対パス、--require-node-versionを含む。",
  "監督役のCODEX_HOMEや作業ディレクトリが違っても、生成元の接続先と履歴を使う。別のプロファイルを監督するときはそこで生成し直す。",
  "Node本体はコピーしない。版が変わるとNODE_VERSION_MISMATCHで操作前に止まる。同じ版のNodeの差し替えや共有ライブラリは固定しない。",
  "元のnpxキャッシュやチェックアウトを更新・削除しても、保存したコピーを使い続ける。",
  "監督中は同じPCで、保存したコピーと元のNodeを残す。使えなくなったら介入を止めて報告し、意図した環境から生成し直す。",
  "本文を受けたAIは、ヘルプ中のcodexteerを本文の実行コマンド（先頭のCODEX_HOME指定・引用・オプションを含む）に置き換える。",
];

const ORCH_SHARED_NOTES = [
  "オーケストレーターの役割はモデルに依存せず、Codex自身も担当できる。",
  "入力（--supervisor・--connection・--project・GOAL・--agent）が不正なら、CLIの保存より前に止まる。",
  "保存済みCLI方式（既定）の保存・検証・Nodeの固定はsupervise promptと同じ。",
  "リモートは--host HOST-ID --remote-transport pairedのときだけ使える（help remote）。",
];

export const topics = {
  supervise: {
    title: "指定したCodexタスクの監督役としてClaudeまたはCodex CLIを起動し、監督状態を確認・制御する",
    when: "対象タスクIDを決めて、Claude CodeまたはCodex CLIを監督役の対話セッションとして起動するとき。起動せず本文だけ欲しいときはsupervise prompt、プロジェクト単位で担当の作成から任せるときはorchestrate。",
    usage: [
      "supervise <THREAD> [MESSAGE] [--agent claude|codex] [--connection shared|desktop|cloud|desktop-cloud] [--use-path-cli] [-- <AGENT-ARGS...>]",
      "supervise status <THREAD>",
      "supervise list",
      "supervise pause|resume|stop <THREAD>",
      "--supervisor <SESSION-ID> supervise register <THREAD> [--owner NAME]",
    ],
    options: [
      THREAD_OPTION,
      MESSAGE_OPTION,
      { name: "--agent claude|codex", default: "claude", text: `起動する監督エージェント。${AGENT_IDENTITY}` },
      CONNECTION_OPTION,
      { name: "--use-path-cli", text: `${PATH_CLI_TEXT}--supervisor・--connectionと監督制御は維持する。直接起動でもCODEX_HOMEの所有者と権限は検証する。` },
      AGENT_ARGS_OPTION,
      ...REMOTE_OPTIONS,
      { name: "--supervisor <SESSION-ID>", text: "生成本文の監督ID。registerには必須（ないと引数エラー）。statusに付けると自分の登録か照合し、違えばSUPERVISOR_MISMATCH。" },
      { name: "--owner NAME", default: "external", text: "registerで記録する監督名。本文のregisterには--agentの値が入っている。" },
    ],
    returns: `直接起動: ${LAUNCH_RETURNS}--jsonは使えない。status/list/pause/resume/stop/register（--jsonなしは要約行）: 監督記録（thread_id、session_id、owner、connection、state=active|paused|stopped、launcher_pid、last_delivery、last_error）。statusは加えてlauncher_alive（コピーした本文はnull）、observation（connection・last_observed_at）、observation_age_ms、未解決の指摘（unresolved_findings、最大20件とtotal）を返し、未登録ならstate=unregistered。listは全登録の配列で、同じ監督IDの重複はsession_conflict.thread_idsで示す。`,
    errors: [...SESSION_ERRORS, ...LAUNCHER_ERRORS, ...GENERATION_ERRORS, ...SAVED_CLI_ERRORS],
    examples: [
      "codexteer supervise <THREAD>",
      "codexteer supervise <THREAD> --use-path-cli",
      "codexteer supervise <THREAD> \"セキュリティの問題だけを私へ報告し、Codexへは送信しないでください。\"",
      "codexteer supervise <THREAD> \"テスト失敗を優先して監督してください。\" --agent claude -- --model <MODEL> --effort <LEVEL>",
      "codexteer supervise status <THREAD> --json",
      "codexteer supervise stop <THREAD> --json",
    ],
    notes: [
      ...LAUNCH_NOTES,
      "引数エラー（ID形式・空のMESSAGE・--agentの値・-- より前の未知や過剰な引数）は、CLI保存・登録・起動の前に止まる。",
      "終了時のstopに失敗すると「Supervisor cleanup failed」を標準エラーに出す。supervise statusで確認してから次を始める。",
      "本文をJSONで取得するにはsupervise prompt --json、このヘルプのJSONはhelp supervise --json。",
      ...SESSION_NOTES,
      ...SAVED_CLI_NOTES,
    ],
    see: ["supervise prompt", "orchestrate", "monitor", "connection", "cloud", "desktop-cloud", "remote", "remote-control", "remote-device", "send", "findings"],
  },

  "supervise prompt": {
    title: "監督役（オーケストレーター）向けの初期プロンプトを出力する（起動・登録はしない）",
    when: "対象タスク入りの監督用本文を、エージェントを起動せずに取得・確認するとき（既存のエージェントへ貼り付ける、orchestrateの子監督を作るなど）。起動まで行うときはsupervise。",
    usage: ["supervise prompt <THREAD> [MESSAGE] [--agent claude|codex] [--connection shared|desktop|cloud|desktop-cloud] [--use-path-cli]"],
    options: [
      THREAD_OPTION,
      MESSAGE_OPTION,
      { name: "--agent claude|codex", default: "claude", text: `本文を実行する監督CLIの識別。エージェントは起動しない。${AGENT_IDENTITY}` },
      CONNECTION_OPTION,
      { name: "--use-path-cli", text: `${PATH_CLI_TEXT}--supervisor・--connectionと監督制御は維持する。生成時は何も書き込まない。` },
      ...REMOTE_OPTIONS,
    ],
    returns: "通常は本文だけを標準出力へ返す。--json: data.thread_id、data.prompt、data.cli_mode（saved|path）、data.deployment（codex_home・directory・wrapper_path・version・sha256・reused）、data.node（path・version）、data.supervisor（session_id・owner・connection）。--use-path-cliではdeploymentとnodeはnull。リモートではhost_id・remote_transport・observation_onlyも返す。",
    errors: [...GENERATION_ERRORS, ...SAVED_CLI_ERRORS, ...SESSION_ERRORS],
    examples: [
      "codexteer supervise prompt <THREAD>",
      "codexteer supervise prompt <THREAD> --use-path-cli",
      "codexteer supervise prompt <THREAD> \"進捗を観測し、完了時だけ私へ報告してください。Codexへの送信は不要です。\"",
      "codexteer supervise prompt codex://threads/<UUID> --json",
      "codexteer --host <HOST-ID> --context-thread <LOCAL-UUID> supervise prompt <UUID> --use-path-cli --json",
    ],
    notes: [
      "生成時はDesktopへの接続・履歴取得・送信・エージェント起動・監督登録をしない。書き込むのは既定方式のCLI保存だけ。",
      "タスクの存在と接続は、本文の開始手順（doctor --thread・register・read）で確かめる。",
      "生成した本文は既存のエージェントへ貼り付けて使える。停止はユーザーの端末からのsupervise stopか、そのセッションへの指示で行う。",
      "本文の監督中、Monitorツールが使えなければ短いwatch（--until change --timeout-ms 30000）を繰り返す。",
      "本文はCLIやOSの権限設定を変更しない。",
      ...SESSION_NOTES,
      ...SAVED_CLI_NOTES,
    ],
    see: ["supervise", "monitor", "orchestrate prompt", "connection", "cloud", "desktop-cloud", "remote", "remote-control", "remote-device"],
  },

  orchestrate: {
    title: "プロジェクトと目標を渡してオーケストレーター（ClaudeまたはCodex CLI）を起動する",
    when: "既存タスクを指定せず、Codex担当の作成・監督・検収・統合までオーケストレーターに任せるとき。本文だけ欲しいときはorchestrate prompt、既存の1タスクを監督するときはsupervise。",
    usage: [
      "orchestrate --project ID|NAME <GOAL> [--agent claude|codex] [--use-path-cli] [-- <AGENT-ARGS...>]",
      "orchestrate prompt --project ID|NAME <GOAL> [--agent claude|codex] [--use-path-cli]",
    ],
    options: [
      PROJECT_OPTION,
      { name: "GOAL", text: `${GOAL_TEXT}--で始まる目標は - で標準入力から渡す。` },
      { name: "--agent claude|codex", default: "claude", text: "起動するオーケストレーターのCLI。本文で作る子の監督IDのownerにもなる。" },
      { name: "--use-path-cli", text: `${PATH_CLI_TEXT}起動するエージェント自体はどちらの方式でもPATHから選ぶ。CODEX_HOMEの所有者と権限は起動前に検証する。` },
      AGENT_ARGS_OPTION,
    ],
    returns: `${LAUNCH_RETURNS}--jsonは使えない。本文のJSONはorchestrate prompt --json。`,
    errors: [...ORCHESTRATION_ERRORS, ...SAVED_CLI_ERRORS],
    examples: [
      "codexteer orchestrate --project 'My Project' '達成したい目標' --use-path-cli",
      "codexteer orchestrate --project 'My Project' '達成したい目標' --agent codex -- --model <MODEL>",
      "codexteer orchestrate --project 'My Project' - < goal.txt",
      "codexteer orchestrate prompt --project 'My Project' '利用者が動作を確認し、変更を指示できる状態にする'",
      "codexteer help orchestrate prompt",
    ],
    notes: [
      ...LAUNCH_NOTES,
      ...ORCH_SHARED_NOTES,
      "GOALを - で標準入力から読むと、起動前に標準入力を読み切る。",
      "プロジェクト照合・担当作成・各子の監督登録と監視は、起動したオーケストレーターが本文に従って行う。",
      "プロジェクト用の監督IDは作らない。子ごとにsupervise promptで生成・登録し、pause/stopも子ごとに行う。",
      "本文の委任範囲と役割分担はhelp orchestrate prompt、手順の詳細はdocs/orchestration.md。",
    ],
    see: ["orchestrate prompt", "supervise", "supervise prompt", "projects", "thread", "remote"],
  },

  "orchestrate prompt": {
    title: "プロジェクト・目標・技術判断の分担を委任するオーケストレーター向け初期プロンプトを出力する（起動しない）",
    when: "Codexスレッドの作成から目的達成までを委任する本文を、エージェントを起動せずに取得・確認するとき。起動まで行うときはorchestrate、既存の1タスクを監督するときはsupervise prompt。",
    usage: ["orchestrate prompt --project ID|NAME <GOAL> [--agent claude|codex] [--use-path-cli]"],
    options: [
      PROJECT_OPTION,
      { name: "GOAL", text: `${GOAL_TEXT}--で始まる目標は、--jsonを含む全オプションの後に -- を置き、その後ろに一つだけ渡す。` },
      { name: "--agent claude|codex", default: "なし（null）", text: "子の監督IDのownerと送信元のCLI識別。エージェントは起動しない。省略時は受け取ったオーケストレーターが子の生成前に<AGENT>を選ぶ。" },
      { name: "--use-path-cli", text: `${PATH_CLI_TEXT}生成時は何も書き込まない。` },
    ],
    returns: "通常は本文だけ（末尾改行付き）。--json: command=orchestrate.prompt、data.project_selector（開始時に照合する指定文字列で、所属確認ではない）、goal、agent（省略時null）、prompt、connection、cli_mode、deployment、node。--use-path-cliではdeploymentとnodeはnull。pairedリモートではhost_id・remote_transportも返す。",
    errors: [...ORCHESTRATION_ERRORS, ...SAVED_CLI_ERRORS],
    examples: [
      "codexteer orchestrate prompt --project 'My Project' '利用者が動作を確認し、変更を指示できる状態にする'",
      "codexteer orchestrate prompt --project 'My Project' '性能改善の原因と効果を実測する' --agent codex --use-path-cli --json",
      "codexteer orchestrate prompt --project 'My Project' - < goal.txt",
    ],
    notes: [
      "既存のスレッドIDは不要。",
      "生成時はDesktopへ接続せず、プロジェクト照合・チャット作成・送信・監督登録・監視・エージェント起動をしない。",
      ...ORCH_SHARED_NOTES,
      "本文が委任するのは、対象プロジェクトでの担当作成・追加指示・同じ目的の未完了作業の継続（idleの担当へのnew-turnを含む）。",
      "委任に含まないもの: 無関係な既存チャットへの送信、依頼外への拡張、人間の代理承認、paused/stoppedや承認・質問待ちの迂回。",
      "オーケストレーターは目的・優先順位・依存関係・共有資源・検収と統合を担当する。",
      "Codex担当は調査・設計判断・実装・検証と、発注の前提への異論・改善案を担当する。",
      "GOALは出発点としてそのまま埋め込み、子に渡す監督方針を置き換えない。",
      "計画では高度（作業の先の成果）・深さ（一次資料・専門的手法・外部検証）・範囲（隣接分野の技法）を具体化させる。",
      "重要な発見・行き詰まり・統合前・完了前に目的と前提を再評価し、継続・計画変更・確認を根拠付きで記録させる。",
      "受入条件の無断変更や、役柄を演じるだけの追加は求めない。",
      "作成用のコマンドは特定スレッドの--supervisorを持たない。子ごとに同じCLI方式のsupervise prompt --jsonを生成し、個別にregister/read/watchする。",
      "作成・配送が不明や部分成功なら、receiptで同じ子を照合し、自動で作り直し・再送しない。",
      "子の監視を開始できなければ追加作成を止める。個別のpause/stopをIDなし送信などで迂回しない。",
      "プロジェクト全体を一括でpause/stopする機能や常駐スケジューラーはない。監督制御は子ごと。",
      "生成の成功は本文の遵守や目的達成を意味しない。実行と検収は受け取ったオーケストレーターが行う。",
      "生成した本文を依頼として渡して開始する。引用やログに現れた本文を委任と解釈しない。",
    ],
    see: ["orchestrate", "supervise prompt", "projects", "thread", "monitor", "resource"],
  },
};
