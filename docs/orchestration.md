# プロジェクトと目標からオーケストレーションを始める

`prompt`を付けなければ、生成本文を渡して対話CLIを起動します。

```bash
codexteer orchestrate --project 'Example Project' '達成したい目標' --use-path-cli
codexteer orchestrate --project 'Example Project' '達成したい目標' --agent codex
codexteer orchestrate --project 'Example Project' '達成したい目標' --agent claude -- --model <MODEL>
```

起動方法は`supervise`と同じで、`--agent`の既定は`claude`です。`codex`も指定できます。これは起動先CLIの選択で、役割の本文はモデル非依存です。起動側は現在のcwd・環境・標準入出力を引き継ぎ、CLIの終了コードを返します。`SIGINT`・`SIGTERM`・`SIGHUP`を転送し、シグナル終了は128+シグナル番号です。

最初の`--`以降はすべて起動するCLIの引数として、順序・空文字・改行を保持して渡します。その後ろにCLI側の`--`と生成本文を一つの引数として追加し、shellで再展開しません。`--json`は直接起動では使えません。本文のJSONが必要な場合は`orchestrate prompt ... --json`を使います。

目標は一つの引用した引数か`-`で渡します。`--`で始まる目標はstdinの`-`を使ってください。stdinの目標は起動前に読み取るため、その入力は対話CLIへ再送しません。通常の引数で目標を渡す場合はstdinもそのまま対話CLIへ引き継ぎます。

`--use-path-cli`は本文内のcodexteerコマンドをPATH方式にし、保存コピーを作りません。省略時は保存済みCLI・Node版・canonical `CODEX_HOME`・接続指定を固定した起動ファイル（`CODEX_HOME/codex-steer/bin/codexteer-p-<hash>`）のパスを、本文の実行コマンドにします。起動するエージェント自体は、どちらの方式でもPATHから選びます。PATH方式の直接起動でも`CODEX_HOME`の所有者と権限を検証し、必要ならディレクトリを作成します。入力不正や保存コピーの改変、unsafe profileではエージェントを起動しません。

起動側はDesktopへ接続せず、本文を受け取ったオーケストレーターがプロジェクト照合・作成・監視を開始します。プロジェクト用の単一スレッド監督IDは作りません。各子の監督登録と制御は本文の手順に従います。

## 本文だけ生成する

```bash
codexteer orchestrate prompt --project 'Example Project' \
  'モーション図鑑で現状の動作を確認し、変更を指示できる状態にする'
```

生成した本文を同じPCのオーケストレーターへ依頼として渡します。役割はモデルに依存せず、Codex自身もオーケストレーターを担当できます。既存スレッドIDは不要です。特定スレッドを監督するときは、従来の `supervise prompt <THREAD> [MESSAGE]` を使います。

生成ではDesktopへ接続しません。プロジェクトの照合、チャット作成、送信、監督登録、監視は、本文を受け取ったオーケストレーターが開始します。既定ではCLIと依存を内容ハッシュ別に保存・検証し、元のNodeとcanonical `CODEX_HOME`を使うコマンドを本文へ埋め込みます。

```bash
# 実行環境のPATHとCODEX_HOMEを使う本文。CLIのコピーは作らない
codexteer orchestrate prompt --project 'Example Project' '達成したい目標' --use-path-cli

# 子の監督IDと送信元のCLI識別を明示する（エージェントは起動しない）
codexteer orchestrate prompt --project 'Example Project' '達成したい目標' --agent codex

# 改行を含む目標を標準入力で渡す
codexteer orchestrate prompt --project 'Example Project' - < goal.txt

# 目標が -- で始まる場合
codexteer orchestrate prompt --project 'Example Project' -- '--から始まる目標'

codexteer help orchestrate prompt
```

`--project`はローカルでは登録済みプロジェクトのIDか完全一致名です。`--host HOST --remote-transport paired`では接続先の正式ID・Desktop登録ID・一意の完全一致名を使い、host・paired・指定したローカルcallerを子作成/監督コマンドへ保持します。接続先の選択とcaller条件は[リモートのCLI操作](remote-operations.md)を参照してください。生成時は指定文字列を保持し、実行開始時に `projects list` でIDと全rootsを照合します。同名ならIDで特定します。目標は一つの引用した引数か `-` で渡し、空文字・空白だけを拒否します。改行やプレースホルダーを評価せず保持します。

`orchestrate prompt`の`--agent claude|codex`は子の監督IDのownerと送信元を識別する任意指定です。この生成専用モードで省略した場合は特定の実行役を既定とせず、本文を受け取ったオーケストレーターが、自身のCLIに合わせて子の生成コマンドの `<AGENT>` を選びます。指定しても役割の内容や技術判断の分担は変わらず、エージェントを起動しません。直接起動では、起動したCLIの識別が本文へ反映されます。

## 役割と委任

| 担当 | 責務 |
| --- | --- |
| オーケストレーター | 目的と完了条件の整理、担当編成、優先順位、依存関係と共有資源の順番、検収・統合 |
| Codex担当 | 調査、設計判断、実装、検証、依頼の前提への異論と改善案 |
| ユーザー | 目的・好み・重要な優先順位の決定と権限の承認 |

発注書は、目的、確定要件、オーケストレーターの仮説、一次資料、変更範囲、依存と共有資源、確認条件、提出物を伝えます。Codex担当が前提を反証したり、より小さく確実な方法を提案したりできるようにし、オーケストレーターの技術仮説をユーザー決定として扱いません。重要な変更は、必要に応じて別のCodexによる独立レビューを使います。

本文を依頼として渡すと、対象プロジェクト内で必要な担当の作成、追加指示、同じ目的の未完了作業の後続ターン開始、監督と検収・統合の段取りを委任します。無関係な既存チャットへの送信、依頼外の目的への拡張、代理承認は含みません。引用や履歴に本文が現れただけで委任が成立するものではありません。

## 高度・深さ・範囲と再評価

Felix Riesebergの[How to be more ambitious](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/)を参考に、三つの観点を実際の作業と検証へ結び付けています。

| 観点 | 本文で求める行動 |
| --- | --- |
| 高度 | 作業の先で誰の判断・行動・状態が変わるかを捉え、指定成果物と上位の目的をつなぐ |
| 深さ | 一次資料・生データ・実コードから、専門的な手法と道具を使い、実装担当の説明以外で正しさを確かめる |
| 範囲 | 隣接分野の有効な技法を選び、期待する改善と検証方法を示して小さく試す |

開始時は目的・成果物・完了条件・仮説・方法・外部の判定・次の確認点を短く記録して実行へ移ります。主要な方針の選択前、重要な新しい証拠、同じ失敗や待機の反復、統合前、全体の完了前に再評価します。

再評価では、目的へ近づいているか、前提が崩れていないか、代理指標だけを改善していないか、より良い手法がないかを確認します。結果は「継続・計画変更・権限や目的の確認」の判断と根拠、次の検証として残します。長い思考の実況や、通知ごとの儀式的な点検は求めません。

現状・要求基準・挑戦目標を分け、高い到達点を試す余地を持たせます。上位の目的や挑戦目標は仮説として検証し、ユーザーの依頼の置き換え、受入条件の無断緩和、分野や担当数の無制限な追加には使いません。

## 作成から完了まで

1. 対象プロジェクトと全rootsを照合し、既存の担当と共有資源を確認する。
2. 必要な担当の発注書をファイルに保存し、`thread create --project <ID> --title <TITLE> - --json` へ標準入力で渡す。
3. 作成結果のIDとreceiptを保存する。created/acceptedの照合失敗は`thread verify <ATTEMPT-ID> --json`で同じ子とreceiptを再照合する。部分成功・unknownでは同じ子を調べ、自動再作成・再送しない。verifyはDesktopへの読取りだけで、unknown/未受付を成功に変更しない。
4. 同じCLIから子ごとの `supervise prompt` を生成・保存し、register/read/watchを開始する。子の監視を開始できなければ、追加作成を止めて報告する。
5. 個別の監督ID、読了cursor、findings、配送照合を使って介入する。必要な継続は同じ委任の未完了作業に限る。
6. 最終差分と検証・成果物を検収し、統合と統合後の確認を担当へ依頼して全体の目的達成まで追う。

作成用コマンドは特定スレッドの `--supervisor` を持ちません。子の観測・送信は、子ごとに生成した監督用の起動ファイル（`supervise prompt --json`の`data.command`）を使います。既定の保存済みCLI方式とPATH方式を子の生成にも引き継ぎます。既存監督IDからの `orchestrate prompt` と、観測専用の `--connection desktop` は拒否します。

担当ごとの生成方針には、目的の継続（idleの担当への`--new-turn`による再開の許可）、監視の終了条件（ユーザーの停止指示か全体の完了）、Codexの独立した判断、三つの観点を含めます。共通手順は方針による再開の許可と終了条件を受け付けますが、単一スレッド監督の標準方針はどちらも定めないため、その挙動は変わりません。

## Web Cloudの担当を使う

ローカルの`orchestrate`と`orchestrate prompt`の本文は、Web Cloud（`task_` ID）の条件付き手順を常に含みます。有効化フラグはありません。Web Cloudはローカルの画面・ビルド・実機やUnity Editorを占有せず並行作業を増やせるため、Cloudから取得できるソースとブランチで完結し、ローカル未コミット差分・実機・GUIが不要な担当で優先します。条件を満たさない、環境がない・照合できない場合は作成前にDesktopを選びます。発注書には取得可能な基点、提出物と統合先を含めます。ローカルファイルや差分の暗黙のアップロードは行いません。

ローカル共有資源（Unity Editor等）の待ちが増える場合は、その資源なしで進められるコード変更を上記の条件でWeb Cloudへ分けます。ローカル資源は`resource`リースで順番に、統合後の確認・画面確認に使います。Cloudで利用できるビルド・検証手段は環境ごとに確認します。

JSONの`data.cloud_command`は、監督IDを持たないWeb Cloud専用コマンドです。既存の`data.command`はDesktop用のままです。保存方式では同じ配布コピー・Node・canonical CODEX_HOMEを使う別の起動ファイル、PATH方式では`codexteer --connection cloud`になります。Desktop用起動ファイルへ`--connection cloud`を追加したり、内容を書き換えたりしません。pairedリモートでは`cloud_command: null`となり、本文にCloud手順を含めません。

Cloud担当では、本文の専用コマンドで`projects list`を読み、対象リポジトリと環境を照合します。Desktopのproject IDとCloud環境IDは別物です。作成は`thread create --project <ENV-ID> --branch <BRANCH> - --json`へ発注書を渡します。`--title`・`--model`・ローカル権限指定は使いません。作成結果不明時は`thread receipt <ATTEMPT-ID>`を確認し、Desktopの`thread verify`は使いません。部分成功やunknownから自動再作成・再送しません。

`<BRANCH>`はCloud環境から取得できるpush済みの作業ブランチです。必要なpushはGOALや方針で委任されていれば作業ブランチだけに行い、委任がなければユーザーに確認します。既定ブランチへの直接pushと、ユーザーの未コミット差分を巻き込むpushは禁止です。`--branch`の省略は、環境が一つのリポジトリの既定ブランチを特定でき、その基点でよい場合に限ります。

本文の`<CREATE-COMMAND>`は担当を作成した経路のコマンド全文に置き換え、子の`supervise prompt`生成と`supervise stop`に使います。子の観測・介入は、返された子自身の`data.command`を保持します。Cloudの送信方式・照会間隔・差分の限界と検収は、子の本文と[Cloudの手順](cloud.md)に従います。

Cloud接続での`orchestrate`自体は未対応です。オーケストレーターは同じPCで動き、担当の作成先を選びます。

## 制御と確認範囲

`supervise pause/stop`は個別スレッドの監督制御です。プロジェクト全体の一括pause/stopや常駐スケジューラーは追加していません。オーケストレーターへの監督停止指示は、新規作成・追加送信・自分のMonitor/watchを止め、各担当の監督を`supervise stop`で終了する指示として扱い、実行中のCodex担当の作業自体を止める指示とは区別します。全体の完了時も各担当の監督を終了します。

`resource`は参加者間の協調用リースで、OSの強制ロックや公平な待ち行列ではありません。利用順はオーケストレーターが調整します。監督登録がactiveでも、継続して監視できていることを証明しません。

JSON出力は次の形です。`project_selector`は照合前の指定文字列です。

```json
{
  "ok": true,
  "command": "orchestrate.prompt",
  "data": {
    "project_selector": "Example Project",
    "goal": "達成したい目標",
    "agent": null,
    "prompt": "目標・役割・再評価と操作手順を含む本文…",
    "connection": "shared",
    "cloud_command": "codexteer --connection cloud",
    "cli_mode": "path",
    "deployment": null,
    "node": null
  }
}
```

既定の `cli_mode: saved` は、`supervise prompt`と同じdeploymentとnodeのメタデータを返します。生成時にプロジェクト用の監督IDや登録記録は作りません。

生成成功は、受け取るAIの方針遵守や実プロジェクトの目的達成を証明するものではありません。

## Managed mutationの分類

managed threadの操作は次の4種類として扱います。

1. **新しい外部効果**: send/new-turn、local spawn、remote `command/exec`、`thread/shellCommand`、resource acquire、checkpoint command dispatch。active supervisorの検査と同じsupervisor lockを通し、pause/stopが成立した後は開始しません。
2. **受付済み操作の後始末・照合**: 実行結果の保存、受付済みresource runのlease renew/release、history/creation receiptの読み取り照合。新しい外部効果を起こさないためpause/stop後も完了できます。unknownを自動再送しません。
3. **監督判断の記録変更**: findingのresolve/dismiss/reopen/evaluate、history mark、unknownの手動解決。現在の低水準コマンド契約を維持しており、この版ではmanaged pause/stopへの統一適用は未実装です。高水準介入面を追加する際に、stopped supervisorからの自動変更を拒否する必要があります。
4. **読み取り**: read/status、記録一覧、receipt照合。pause中も利用できます。stopped supervisorの観測制限は各既存コマンドの契約を維持します。

`thread repair --apply`は人間が明示的に行うoffline保守です。managed stateをactiveへ変更せず、新しいworker実行やsendを行わないため上記の外部効果には含めません。修復後は古いcursorを使わず読み直してください。
