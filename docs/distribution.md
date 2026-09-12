# 配布と永続実行

パッケージ名は `@vinhphatfsg/codex-steer`、CLI名は `codex-steer`、ライセンスはMITです。
無指定のnpm名 `codex-steer` は別リポジトリのパッケージが使用しているため、本プロジェクトの導入には使いません。
GitHub名とnpmスコープの所有権は別です。公開時は `npm whoami` でnpm側のユーザーと、このスコープへの公開権限を確認してください。
`package.json` は `private` を持たず、`publishConfig` でnpm公式レジストリへのpublic公開を指定しています。公開可能な設定であることと、実際に公開済みであることは別です。

公開後の基本的な実行形式は次のとおりです。通常はバージョン指定なしで使えます。監督開始後は保存したCLIを使い続けるため、監督中の一貫性を保つために版を明示する必要はありません。起動側と操作側の製品バージョンも、必要な通信仕様が対応していれば異なっていても使えます。
この例は現在公開済みであることを示すものではありません。`-y` はnpmの取得確認を省略します。

```text
npx -y @vinhphatfsg/codex-steer desktop start
npx -y @vinhphatfsg/codex-steer doctor --thread <thread-id> --json
npx -y @vinhphatfsg/codex-steer supervise <thread-id> --agent claude
npx -y @vinhphatfsg/codex-steer supervise prompt <thread-id>
npx -y @vinhphatfsg/codex-steer read <thread-id> --json
npx -y @vinhphatfsg/codex-steer send <thread-id> "message" --json
```

特定の版で開始したい場合は、任意で`@vinhphatfsg/codex-steer@<version>`と指定できます。`<version>`は利用する公開版に置き換えてください。

macOS、Node.js 20以降、対応するCodex Desktopが必要です。すでに起動しているDesktopは、作業を終えて終了してから `desktop start` で起動します。
CLIはDesktopを自動終了しません。

## 監督役が使うCLI

`0.14.1`以降の`supervise`と`supervise prompt`は、開始時のCLI本体と依存を内容ハッシュ別の永続配置へコピーし、その保存先を使う実行コマンドを本文に埋め込みます。npxで取得したパッケージもソースのチェックアウトも、同じ保存・検証・生成処理を使います。起動経路を推測する環境変数や切り替えオプションは不要です。本文の生成処理自体も保存したCLI一式から読み込みます。

監督役の`doctor`・`read`・`watch`・`send`等はこのコピーを使います。パスはシェル引数として引用し、空白・引用符・コマンド置換に見える文字も文字列として扱います。本文に埋め込むパスに改行や制御文字があれば、`SUPERVISION_PATH_UNSAFE`で拒否します。ヘルプの`codex-steer`表記も、監督役には指定された実行コマンドに置き換えるよう指示します。

`supervise prompt`も読み取り専用ではなく、IDと引数の検証後にCLI一式の保存・再利用の検証を行ってから本文を出力します。保存・検証に失敗した場合は部分的な本文を出力せず、直接起動の場合もClaudeを起動しません。Desktopへの接続・設定変更・履歴取得・送信は行いません。`--json`には対象IDと本文に加えて`data.deployment`（保存先・版・ハッシュ・再利用の有無）と`data.node`（Nodeの実体パス・版）を返します。ヘルプの表示は保存処理を行いません。

本文は同じPC・同じ`CODEX_HOME`の環境向けです。監督中は保存したコピーを保持してください。元のチェックアウトやnpxキャッシュを更新・移動・削除しても、そのコピーは変わりません。同じ製品バージョンでも内容が変われば別の保存先を作り、既存のコピーは検証して再利用します。参照先が使えない場合は介入を止めて理由を報告するよう指示し、別の版の自動取得やPATHへのフォールバックは行いません。

Node本体はコピーせず、開始時のNodeの実体への絶対パスと`--require-node-version <version>`を各コマンドに埋め込みます。このオプションは全コマンドで使え、実行中のNodeバージョンが異なる場合は、操作や保存処理を始める前に`NODE_VERSION_MISMATCH`で拒否します。Nodeを削除した場合も実行できません。同じバージョンのNodeの改変や共有ライブラリまで固定・検証するものではないため、元のNodeは保持し、更新時は新しい環境から監督を開始し直してください。通常のCLI操作にNodeバージョンの一致は要求せず、生成した監督用コマンドでのみ自動指定します。

元のパスだけを固定しない理由は、npmキャッシュやチェックアウトの内容が更新されるためです。npm 11.6.2は要求したパッケージ指定からキャッシュ先を計算し、同じ指定の再実行で取得対象が変われば、その保存先でインストールを更新します。新版の公開だけで自動更新されるわけではありません。保存したCLIはこの更新の影響を受けません。[npm 11.6.2のキャッシュ解決・更新実装](https://github.com/npm/cli/blob/v11.6.2/workspaces/libnpmexec/lib/index.js)

バージョン指定は、開始する版を選びたい場合の任意指定です。指定なしではローカル導入済みのパッケージが選ばれる場合もあり、常に最新版を取得する契約ではありません。どちらの場合も、監督開始時に選ばれたCLIを保存して使い続けます。[npmのパッケージ選択仕様](https://docs.npmjs.com/cli/v11/commands/npm-exec/#description)

Desktopとの通信は既存の操作別互換性チェックに従い、監督用CLIとDesktop起動用CLIの製品バージョンの一致は要求しません。両者は同じ永続配置の仕組みを使い、同じ版・同じ内容なら同じコピーを再利用します。

## 配布物

`package.json` の `files` で `bin`、`src`、必要なAppleScript、音源、配布ドキュメントを指定します。
README、MIT LICENSE、package.jsonに加え、依存する `ws` とそのライセンスを `bundleDependencies` で同梱します。
実行時に追加の依存をネットワークから取得しません。install/postinstall/prepare/prepackフックは使用しません。
テスト、開発用スクリプト、`.codex`、ログ、認証情報は配布対象に含めません。

## 永続配置

`desktop start` は呼び出したパッケージの実行用ファイルを、次の場所へコピーしてからDesktopを起動します。`supervise`と`supervise prompt`も同じ配置処理を使い、監督役が使うコピーを準備します。

```text
<canonical CODEX_HOME>/codex-steer/runtimes/<version>-<sha256>/
```

ハッシュにはパス、内容、サイズ、配置時の権限を含めます。同じバージョンでも内容が異なる場合は別の保存先になります。
wrapper、CLI本体、依存、スクリプト、音源を揃えるため、元のリポジトリやnpxキャッシュを削除しても、配置したファイルは残ります。
Desktop起動時の`CODEX_CLI_PATH`はこの保存先のwrapperを指し、wrapperは従来どおりDesktop同梱の署名済みNodeを直接使用します。監督用コマンドは、前述の開始時のNodeを使用します。

配置時は次を検証します。

- CODEX_HOMEの実体が本人所有で、他ユーザーから書き込めないこと。
- 親ディレクトリも他ユーザーが差し替えられないこと（root所有のstickyな一時ディレクトリを除く）。未作成のCODEX_HOMEは検証済みの親の下へ0700で作成します。
- その下の保存先が本人所有の0700ディレクトリで、シンボリックリンクでないこと。
- ファイルが通常ファイルで、ハードリンク・特殊権限・予期しないアクセス権を持たないこと。
- 再利用する全ファイルと保存済み目録が、呼び出した配布物から計算した内容と一致すること。

一時ディレクトリでコピーと検証を完了し、同じ保存先への配置を排他してから名前を確定します。
既存ディレクトリが空・不完全・改変済みでも上書きしません。古い版や稼働中の版も自動削除しません。
並行配置は最大5秒待ちます。中断された `.install-*` ロックは自動で奪取せず `DEPLOYMENT_BUSY` で止まります。
ロックや破損した配置の削除は、その版のDesktop・helper・CLI・監督が停止していることを確認してから行ってください。

これは、信頼する配布物を安全に配置・再利用するための検証です。各操作の実行時に全ファイルを再検証する仕組みや、配布元の真正性を独立した署名で証明する機能ではありません。
同じOSユーザー権限で任意のコードを実行できる相手や、root権限からの改変を隔離する仕組みでもありません。

## 互換性契約

runtimeには製品名・版、共通の通信仕様 `codex_steer_protocol`、機能ごとの対応版 `codex_steer_capabilities`、配置を識別する `distribution_sha256` を記録します。
製品バージョンや同梱CLIの版が違うだけではエラーにしません。内容ハッシュは配置の検証と起動直後の照合に使い、起動時に選んだ配布物の確認は引き続き必須です。

共通仕様v1は、所有者専用のUnixソケット上のWebSocketと、initializeを伴うJSON RPC通信です。機能の対応版は次のように記録します。

```json
{
  "codex_steer_protocol": 1,
  "codex_steer_capabilities": {
    "thread_read": [1],
    "history_pagination": [1],
    "turn_steer": [1],
    "turn_start": [1],
    "desktop_subscribe": [1]
  }
}
```

| 機能 | v1の要求と使用箇所 |
| --- | --- |
| `thread_read` | `thread/read`の`includeTurns`、正確なtask ID・状態・turns。read/status/watch/Monitor/history check/sendで使用 |
| `history_pagination` | `thread/turns/list`・`thread/items/list`のcursorと履歴項目。対象がページ履歴形式の場合や、その形式の`--based-on`を検証する場合だけ使用 |
| `turn_steer` | `turn/steer`の`expectedTurnId`・`clientUserMessageId`と、受付時の`turnId`。通常送信で使用 |
| `turn_start` | `turn/start`のtask ID・text入力・`clientUserMessageId`と、受付時のturn ID。`--new-turn`で使用 |
| `desktop_subscribe` | ui.sockのJSON行`{method:"subscribe",thread_id}`と応答。Desktopの長期接続でresumeし、承認の受信先を維持。`--new-turn`だけで使用 |

追加機能は既存の版を変えず、新しいキーで宣言します。同じ機能に互換性のない変更をする場合はその機能の版を追加します。例えば`[1,2]`なら両方に対応し、`[2]`ならv1のみのCLIはその機能を使えません。未知の追加キーは無視します。明示された機能一覧にない機能は未対応、壊れた宣言は未検証として、その機能を必要とする操作だけを止めます。共通の通信形式を壊す変更だけ`codex_steer_protocol`を変更します。

| 状態 | 動作 |
| --- | --- |
| 製品バージョンだけ異なる | 必要な仕様が対応していれば続行 |
| 新規ターン機能・ソケットだけ未対応 | `--new-turn`を拒否。観測・通常送信は継続可能 |
| ページ履歴APIだけ未対応 | ページ取得が必要な操作を拒否。従来の履歴形式の観測・通常送信は継続可能 |
| 共通仕様が非互換 | 接続する操作を`RUNTIME_PROTOCOL_UNSUPPORTED`で拒否 |
| 機能が非互換・明示的に未提供 | `CAPABILITY_UNSUPPORTED`。JSONエラーの`operation`・`capability`で対象を特定 |
| 送信仕様を確認できない | `CAPABILITY_UNVERIFIED`または`RUNTIME_PROTOCOL_UNVERIFIED`。試験送信しない |

### 旧wrapper

- `codex_steer_protocol: 1`だけを宣言するv0.13形式は、既存5機能のv1仕様として扱います（`source: legacy-v1`）。製品の版文字列は判定に使いません。
- 版・protocol・capabilities宣言がすべてない旧形式は、runtime schema 1、同梱CLI `0.153.4`、旧wrapperが記録した署名済みNodeのパスが一致する組み合わせだけを既知のv1仕様とします（`source: legacy-0.153.4`）。対応表の根拠はコミット`83af51d`のwrapperと隔離プロトコルテストです。
- それ以外の宣言なし環境は、初期化と読み取りによって観測を検証します（`source: probe`、doctorで成功すれば`probe-verified`）。読み取り成功から送信・再開対応を推測しません。
- 壊れた宣言や明示的な非互換を、旧形式へのフォールバックで回避しません。既存の所有者・権限・プロセス・ソケット検査は旧形式にも適用します。

旧v0.13の操作CLI自体には完全一致チェックが残っています。ここで説明する互換性判定を使うには操作側をv0.14以降へ更新してください。対応する旧wrapperはDesktopの再起動なしで使用できます。

### 診断と安全確認

`doctor`の`codex_steer_compatibility`は製品名・版の比較だけです。`matched/mismatch/unverified`は情報であり、readyを決めません。通信仕様は`runtime_compatibility.protocol`、各機能は`features`、操作別の対応は`operations`に分けます。`supported/unsupported/unverified`は仕様上の対応で、実際に送信が成功したという意味ではありません。

`ready`は従来どおり接続条件と指定された観測の結果です。送信だけ未対応でも観測可能ならreadyになります。観測APIの検証結果は`compatibility.api_checks`、送信・画面表示・承認往復の未検証範囲は`unverified_features`を参照してください。新規ターン用ソケットは`desktop_subscription`で別に検査し、欠落・権限異常は`operations.send_new_turn`だけに反映します（異常なら`failed`）。

送信ではDesktopへの再開要求と実際の送信直前にも必要な仕様とruntimeの同一性を確認します。`--based-on`等の安全確認も再開前と送信直前に検証し、必要なAPIが使えないままタスクを再開しません。切り替わっていれば`RUNTIME_CHANGED`で拒否します。新規ターン用ソケットも使用前に所有者・権限・種類を再検査します。不明な受付結果の自動再送はしません。`help`・`supervise prompt`・ローカル履歴一覧・`--dry-run`はruntimeの版に依存しません。

## 公開前の検証

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
npm run test:protocol
```

`test:package` は実際のtarballを作り、同梱内容・実行権限を確認して、隔離した空のnpmキャッシュからオフラインでインストールします。
公開を禁止する`private`フィールドがないこと、CLIの`bin`が正規化済みのパスであることも確認します。さらに資格情報を渡さず、外部公開できない接続先・offline・dry-runでnpmの公開準備を検証し、自動補正の警告がなく、テストするtarballと内容ハッシュが一致することを確認します。npmのdry-runは`EPRIVATE`の判定を省略するため、dry-runの成功だけで公開可能とは判断しません。
リポジトリ外でCLIを実行し、模擬runtimeに対する異なる版でのread/send、機能単位の拒否、キャッシュ削除後の永続配置を検証します。
npxから模擬Claudeを起動して保存したCLIへの参照を確認し、同じ本文を別プロセスへ貼り付けた場合も検証します。元のキャッシュの更新・削除後も保存した版を使い、模擬runtimeへのread/sendを継続できることを確認します。単体テストでは同じ版のソース変更、別の版への更新、保存済みコピーの改変、Nodeバージョンの不一致も検証します。監督側のPATHに別のCLIがある場合やCLIがない場合を含み、実際のClaudeやモデルは起動しません。
`test:protocol` は実際の同梱CLIと模擬Desktopを使います。実ユーザーのタスクへの送信やDesktopの停止は行いません。
実際のnpm公開には、スコープの公開権限確認、公開版の確定とユーザーからの公開指示が必要です。

## npmへの公開

レビュー・検証を終えた版を、npm側の公開権限を持つアカウントで公開します。手動公開には2FAを有効にしたアカウントを使ってください。

公開済みのパッケージ名とバージョンの組み合わせは再公開できません。`0.14.0`公開後の変更には新しいバージョンを付け、今回の変更は`0.14.1`として公開します。削除しても同じ版番号を再利用できません。[npm publishの仕様](https://docs.npmjs.com/cli/v11/commands/npm-publish/)

```bash
npm login
npm whoami
npm run test:package
npm publish --access public
```

公開後は、公開した版と起動コマンドの登録を確認します。次は0.14.1を公開した場合の例です。

```bash
npm view @vinhphatfsg/codex-steer@0.14.1 version bin --json
npx -y @vinhphatfsg/codex-steer@0.14.1 --version
```

`EPRIVATE`はリポジトリの`package.json`に公開禁止設定が残っていることを示します。`--access public`はその禁止を解除しません。
`bin`のパスは`bin/codex-steer.mjs`とし、先頭に`./`を付けません。npm 11.6.2では先頭の`./`を正規化する際に「invalid and removed」という警告が出ますが、この場合の実装は`bin`を保持しています。警告を避けるため、正規化済みの表記を配布元から使います。

参考: [npmのfilesとbundleDependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)、[npm exec/npxのキャッシュ](https://docs.npmjs.com/cli/v11/commands/npm-exec/)、[スコープ付きパッケージの公開](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)。
