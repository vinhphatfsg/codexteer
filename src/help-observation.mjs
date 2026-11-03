import { DUPLICATE_INTERVENTION, NODE_VERSION_MISMATCH, OPTIONS_INVALID, RUNTIME_NOT_READY, RUNTIME_UNAVAILABLE, SUPERVISOR_NOT_REGISTERED, SUPERVISOR_ORPHANED, SUPERVISOR_PAUSED, SUPERVISOR_STOPPED } from "./help-errors.mjs";
import { supervisionSteps, DIGEST_GUIDANCE } from "./prompt.mjs";

const THREAD_OPTION = { name: "<THREAD>", text: "DesktopのUUIDかcodex://threads/…、Web Cloudのtask_IDか公式タスクURL、Desktop Cloudのdurable_IDかhostId=durable付きリンク。hostId付きリンクはそのホストを観測する。" };
const SINCE_OPTION = { name: "--since CURSOR", text: "自分が最後に読了したcursor。その後の新規・更新項目だけを古い順に扱う。readで省略すると直近--limit件、watchで省略すると開始時点が基準。" };
const READ_PAGE_OPTIONS = [
  { name: "--limit N", default: "50", text: "1回に返すイベント数の上限。1〜1000。" },
  { name: "--max-chars N", default: "2000", text: "text・command・出力・差分を項目ごとにこの文字数で切り、[truncated]を付ける。100〜20000。" },
  { name: "--include-output", text: "コマンド出力と差分本文を含める。省略時は含めない。" },
  { name: "--full-history", text: "毎回全履歴を取得し、過去の書き換えも検出する。表示件数は同じで遅い。得られるcursorはv1で、続きも--full-historyで読む。v2 cursorとは併用不可。" },
];
const STREAM_OPTIONS = [
  { name: "--stream", text: "止めるまで動く継続監視。--jsonの有無にかかわらずJSON Linesを出す。--until・--timeout-msとは併用不可。" },
  { name: "--notify all|digest", default: "--stream時はdigest", text: "digestは保留したイベントをまとめて1行で出す。allは変化した読み取りごとに1行出す。digestは--stream専用。" },
  { name: "--settle-ms N", default: "20000", text: "--notify digest専用。最後の通常イベントからこの時間たつと保留分を出す。1000〜120000。" },
  { name: "--max-hold-ms N", default: "600000", text: "--notify digest専用。保留を始めてからこの時間たつと必ず出す。10000〜1800000。" },
  { name: "--poll-ms N", default: "1000。Cloud・Desktop Cloudは5000", text: "照会間隔。250〜10000。単発watchと--streamの両方に効く。" },
];
const WATCH_OPTIONS = [
  SINCE_OPTION,
  { name: "--until change|idle|attention", default: "change", text: "change=--since（省略時は開始時点）以降の変化。idle=statusがidleかnotLoaded。attention=attentionが空でないかsystemError。--streamでは使えない。" },
  { name: "--timeout-ms N", default: "30000", text: "単発watchの最大待ち時間。0〜60000。--streamでは使えない。" },
  ...STREAM_OPTIONS,
  ...READ_PAGE_OPTIONS,
];

const STREAM_RETURNS = "--streamはJSON Linesを出す。data.type=observationは差分（events・cursor・has_more。digest時はdigest.reason・held_ms・counts・from_cursor付き）。data.type=connectionは接続状態（watching・reconnecting・recovered）とresume_cursor。異常終了時は最終行がok:falseでdata.stateがneeds_reviewかfailed、終了コード1。SIGINT/SIGTERMでの停止は終了コード0。";

const CURSOR_TOO_LARGE_ERROR = { code: "CURSOR_TOO_LARGE", when: "高速方式のcursorに入れる実行中項目が多すぎて上限（1 MiB）を超えた", action: "--full-historyを付けて読む（v1 cursorになり、続きも--full-historyで読む）。" };
const OBSERVATION_CHANGED_ERROR = { code: "OBSERVATION_CHANGED", when: "読み取り中に新しいターンが始まり、自動の再試行1回でも揃わなかった", action: "同じコマンド（同じ--since）をもう一度実行する。--sinceを外して履歴を飛ばさない。" };
const CURSOR_ERRORS = [
  { code: "STALE_CURSOR", when: "cursorが壊れている、別のタスク・ホスト・transportのもの、または履歴の巻き戻しや追跡位置の不一致を検出した", action: "原因を確認し、--sinceを外して現状を読み直す。送信前に再評価する。" },
  { code: "CURSOR_UPGRADE_REQUIRED", when: "高速方式のタスクに旧v1 cursorを--full-historyなしで渡した", action: "未読差分を続けるなら--full-historyを付ける。高速方式へ移るなら--sinceなしで読み直して新しいcursorを保存する。" },
  OBSERVATION_CHANGED_ERROR,
  CURSOR_TOO_LARGE_ERROR,
  OPTIONS_INVALID,
];
const STREAM_ERRORS = [
  { code: "WATCH_RECONNECT_TIMEOUT", when: "--streamで観測成功後の一時切断が60秒以内に復帰しなかった（data.state=failed）", action: "doctorで接続を確認し、自分が読了したcursorを--sinceに指定して明示的に再開する。" },
];
const SUPERVISOR_ERRORS = [
  SUPERVISOR_NOT_REGISTERED,
  SUPERVISOR_STOPPED,
  { code: "SUPERVISOR_MISMATCH", when: "別の監督セッションがタスクを持つ、または登録時と接続・remote transportが違う", action: "監督を終了してユーザーに知らせる。--supervisorや接続を変えて続けない。" },
  SUPERVISOR_ORPHANED,
];
const RUNTIME_ERRORS = [
  RUNTIME_UNAVAILABLE,
  RUNTIME_NOT_READY,
  { code: "PERMISSION_DENIED", when: "sandbox等でApp Serverのプロセスや実行記録を確認できない", action: "利用者のコマンド承認に同じコマンドと理由を提示できる。拒否されたら停止し、sandbox無効化や別経路での回避はしない。" },
];
const TARGET_ERRORS = [
  { code: "CLOUD_TARGET_CONFLICT", when: "--connectionとタスクIDの種類が合わない", action: "error.expected_connectionの接続で実行し直す。" },
];

const SUPERVISOR_NOTE = "--supervisor付きでは登録済みの監督か確認してから観測し、観測時刻を監督記録に残す。pausedでも観測はできる。";
const HAS_MORE_NOTE = "has_more:trueならchanged:falseでも、返されたcursorで続きを読み切ってから判断・送信する。";
const NOTIFICATION_NOTES = [
  "単発watchで--notify digest・--settle-ms・--max-hold-msを指定するとOPTIONS_INVALIDになる。",
  "digestで即時に出すもの: ユーザー入力、ターンの追加と状態変化、plan、最終回答、質問、空でないか変化したattention、タスク状態の変化、読み取り専用以外のコマンド失敗、ファイル変更の失敗。",
  "途中の発言や成功したコマンド・ファイル変更などの通常イベントは、最後の通常イベントから--settle-ms後に出す。",
  "通常イベントが続いても、保留を始めてから--max-hold-msで出す。",
  "読み取り専用コマンド、状態の変わらない実行中コマンド、文脈圧縮・Web検索・画像表示はquietとして--max-hold-msまで保留し、他の理由で出すときに同じ行へ含める。",
  "quietのイベントはcommandとtextも200文字に切る。",
  "読み取り専用の判定はcat・ls・grep・rg・sed -n・find（-exec等なし）・git status/log/diff等の許可リストで行い、リダイレクト・変数展開・コマンド置換を含むと通常扱い。",
  "排出の判定はページを読み切った後のポーリングごとに行うため、処理時間とポーリング間隔ぶん遅れることがある。",
  "接続状態の行と失敗は選別しない。reconnectingの前には保留分を先に出す。",
  "digest.reasonはwake:<種類>・settle・max-hold・capacity・reconnecting・stopped・failedのいずれか。",
];
const STREAM_NOTES = [
  "最初の読み取りが成功するとwatchingを出す。--since以降の差分が既にあれば、その差分行がwatchingより先に出ることがある。",
  "観測成功後の接続失敗・タイムアウト・App Server未起動/未準備だけ、reconnectingを出して1→2→4→8→10秒間隔（retry_after_msが長ければそれ）で同じタスクへ再接続する。",
  "再接続は接続・初期化・読み取りを含めて合計60秒まで。復帰するとrecoveredを出し、超えるとWATCH_RECONNECT_TIMEOUTで終了する。",
  "初回の読み取り失敗と、権限・プロトコル・cursor・監督状態などの失敗は再試行せずに終了する。",
  "STALE_CURSOR・CURSOR_UPGRADE_REQUIRED・OBSERVATION_CHANGEDによる終了はdata.state=needs_review、それ以外はfailed。",
  "SIGINT/SIGTERM（Monitorのキャンセルを含む）で接続中・復帰待ちでも止まり、保留分はdigest.reason=stoppedで出してから終了する。",
  "観測の再接続は送信を再試行しない。",
];

export const topics = {
  monitor: {
    title: "Codexタスクを観測・介入・結果確認の順で監督する",
    when: "監督役が指定の監督方針に従って対象タスクを継続観測し、送信が許される場合だけ介入と結果確認をするときの共通手順。手順入りの本文が欲しいならsupervise prompt。",
    usage: [
      "supervise prompt <THREAD> [MESSAGE]",
      "watch <THREAD> --stream [--notify all|digest] [--settle-ms N] [--max-hold-ms N] [--since CURSOR] [--poll-ms N] [--limit N] [--max-chars N] [--include-output] [--full-history]",
      "watch <THREAD> --since CURSOR --until change --timeout-ms N [--include-output]",
      "read <THREAD> [--since CURSOR] [--limit N] [--include-output]",
    ],
    options: WATCH_OPTIONS,
    returns: STREAM_RETURNS,
    errors: [
      ...CURSOR_ERRORS, ...STREAM_ERRORS, ...SUPERVISOR_ERRORS,
      SUPERVISOR_PAUSED,
      DUPLICATE_INTERVENTION,
      NODE_VERSION_MISMATCH,
      ...RUNTIME_ERRORS,
    ],
    examples: [
      "codexteer watch <THREAD> --stream --notify digest --since <CURSOR> --include-output --json",
      "codexteer read <THREAD> --since <LAST-CURSOR> --include-output --json",
      "codexteer send <THREAD> '失敗箇所を先に確認してください' --source claude-code --kind review --finding <FINDING-ID> --based-on <CURSOR> --json",
      "codexteer history check <THREAD> <MESSAGE-ID> --json",
    ],
    procedure: supervisionSteps(),
    notes: [
      "Web Cloudの監督はhelp cloudも併読する。この共通手順だけではCloudの送信方式・429・差分とローカル検証の限界を含まない。",
      ...NOTIFICATION_NOTES,
      ...STREAM_NOTES,
      "既存のログ監視を続け、その通知後にread --sinceを呼ぶ運用もできる。",
    ],
    see: ["supervise", "supervise prompt", "watch", "read", "send", "findings", "checkpoint", "history", "instructions", "resource"],
  },
  watch: {
    title: "変化・完了・ユーザー対応待ちまで待つ（--streamは止めるまで差分を流す）",
    when: "同じログを繰り返し読まず、次のレビューが必要な時点まで待つとき。1回待つなら単発watch、Claude CodeのMonitor等で継続監視するならwatch --stream。今すぐ読むならread。",
    usage: [
      "watch <THREAD> [--since CURSOR] [--until change|idle|attention] [--timeout-ms N] [--poll-ms N] [--limit N] [--max-chars N] [--include-output] [--full-history]",
      "watch <THREAD> --stream [--notify all|digest] [--settle-ms N] [--max-hold-ms N] [--since CURSOR] [--poll-ms N] [--limit N] [--max-chars N] [--include-output] [--full-history]",
    ],
    options: [THREAD_OPTION, ...WATCH_OPTIONS],
    returns: `単発watchは条件成立か時間切れで1回返す。readのdataにreason（change・idle・attention・timeout）とtimed_outを加える。--sinceなしの時間切れはevents:[]・changed:false。${STREAM_RETURNS}`,
    errors: [...CURSOR_ERRORS, ...STREAM_ERRORS, ...SUPERVISOR_ERRORS, ...RUNTIME_ERRORS, ...TARGET_ERRORS],
    procedure: [DIGEST_GUIDANCE],
    examples: [
      "codexteer watch <THREAD> --stream --notify digest --since <CURSOR> --include-output --json",
      "codexteer watch <THREAD> --since <CURSOR> --json",
      "codexteer watch <THREAD> --until idle --timeout-ms 60000 --json",
    ],
    notes: [
      "--sinceなしのchangeは開始時点を基準に次の変化を待つ。idle・attentionは既に成立していればすぐ返す。",
      HAS_MORE_NOTE,
      "readと同じ差分取得を使う。--full-historyは毎回の全取得になるので、通常の監視では使わない。cursorの種類と移行はhelp read。",
      "単発watchは接続失敗を再試行せず、そのままエラーで終わる。",
      "--until・--timeout-ms・--poll-msの値は接続前に検査し、範囲外ならOPTIONS_INVALIDで止まる。",
      ...NOTIFICATION_NOTES,
      ...STREAM_NOTES,
      "平常時は差分行だけを出し、定期的な生存通知は出さない。",
      "接続行のresume_cursorはCLIが出力を終えた位置か開始時の基準で、AIが読了した証明ではない。",
      "watchが終了したら、自分が最後に読了したcursorを--sinceに指定して明示的に再開する。",
      "recovered後もhas_more:trueなら差分を読み切ってから判断する。",
      SUPERVISOR_NOTE,
      "読み取り専用のポーリングで、自動送信・タスク再開・承認回答・常駐登録はしない。",
    ],
    see: ["read", "monitor", "status", "connection"],
  },
  read: {
    title: "直近の発言・コマンド・変更ファイルを読む",
    when: "レビューや送信の前、または前回のcursorから何が変わったかを1回確認するとき。変化を待つならwatch、状態だけならstatus。",
    usage: ["read <THREAD> [--since CURSOR] [--limit N] [--max-chars N] [--include-output] [--full-history]"],
    options: [THREAD_OPTION, SINCE_OPTION, ...READ_PAGE_OPTIONS],
    returns: "data.events（各項目にchange: added|updated）、status・active_turn_id・attention、running_commands、次回用cursor、changed、has_more、omitted_older_events、history_scope、observed_at。高速方式ではrunning_commands_completeも返す。--jsonなしは状態行・イベント行・cursor行。",
    errors: [...CURSOR_ERRORS, ...SUPERVISOR_ERRORS, ...RUNTIME_ERRORS, ...TARGET_ERRORS],
    examples: [
      "codexteer read <THREAD> --json",
      "codexteer read <THREAD> --since <CURSOR> --include-output --json",
      "codexteer read <THREAD> --full-history --since <V1-CURSOR> --json",
    ],
    notes: [
      HAS_MORE_NOTE,
      "既定の高速方式は直近のページと追跡中の実行項目だけを取得し、長いタスクでも毎回の全取得を避ける。",
      "--sinceなしの初回だけ実行中ターンを調べ、表示範囲より前の実行中コマンドも追跡する。",
      "running_commands_complete:falseは読み残しがあり、running_commandsが不完全な状態（高速方式のみ）。",
      "history_scope=tail-and-tracked-itemsは高速方式で、ターン列・末尾・追跡項目だけを確認する。過去全文の書き換え検出には--full-historyを使う。",
      "history_scope=fullは全取得。ページ化されていない古い形式のタスクとCloud・Desktop Cloudのタスクは常に全取得になる。",
      "リモートのnative経路ではhistory_scope=desktop-native-public-historyになる。",
      "v1 cursor（全取得）とv2 cursor（高速方式）は混在できない。",
      "v2 cursorに--full-historyを付けるとOPTIONS_INVALID。--full-historyを外して続けるか、--sinceなしで全取得を始める。",
      "omitted_older_events:nullは省略した古い項目の件数が未集計という意味。件数のための全取得はしない。",
      "cursorは対象タスク・ホスト・remote transportに結び付く。別の対象に渡すとSTALE_CURSOR。",
      "観測対象は履歴APIに現れた項目だけ。",
      "Codexの版によっては、実行開始の通知後、コマンドが完了してから履歴に現れる場合がある。",
      "内部推論は出力しない。",
      "観測でタスクを再開・送信・前面化しない。",
      SUPERVISOR_NOTE,
    ],
    see: ["watch", "status", "monitor", "connection"],
  },
  status: {
    title: "実行中・停止中・承認待ちを確認する",
    when: "今ステアできるか、新規ターンが必要か、ユーザーの応答が必要かを判断するとき。発言やコマンドの中身が要るならread。",
    usage: ["status <THREAD> [--full-history]"],
    options: [
      THREAD_OPTION,
      { name: "--full-history", text: "readの--full-historyと同じ全取得方式で状態とcursorを得る。返るcursorはv1。" },
    ],
    returns: "data.status（active・idle・notLoaded・systemErrorなど。取得できなければunknown）、active_turn_id、attention、running_commands、cursor、history_scope。eventsは返さない。--jsonなしは状態行・実行中ターン・cursor行。",
    errors: [OBSERVATION_CHANGED_ERROR, CURSOR_TOO_LARGE_ERROR, ...SUPERVISOR_ERRORS, ...RUNTIME_ERRORS, ...TARGET_ERRORS, OPTIONS_INVALID],
    examples: ["codexteer status <THREAD> --json"],
    notes: [
      "--sinceなしのreadと同じ取得方式で状態だけを返す。返したcursorからread --sinceへ進める。",
      "statusで指定できるのは--full-historyだけ。差分や本文はreadで読む。",
      "notLoadedは保存済みタスクが未ロードという意味。statusはタスクをロードしない。",
      "attentionはApp Serverが報告した値で、本文から推測しない。nullはactiveでフラグ未報告、[]は該当なし。",
      "Web Cloudのタスクではattentionは常に[]で、承認待ちを表さない。",
      "承認や質問には回答しない。",
      SUPERVISOR_NOTE,
    ],
    see: ["read", "watch", "send"],
  },
};
