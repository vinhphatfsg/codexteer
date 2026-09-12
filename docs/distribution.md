# 配布と永続実行

パッケージ名は `@vinhphatfsg/codex-steer`、CLI名は `codex-steer`、ライセンスはMITです。
無指定のnpm名 `codex-steer` は別リポジトリのパッケージが使用しているため、本プロジェクトの導入には使いません。
GitHub名とnpmスコープの所有権は別です。npm側の公開権限と実際の公開版を確認するまでは `private: true` を維持します。

公開後の実行形式は次のとおりです。`<version>` は確認済みの公開版に置き換え、起動から送信まで同じ版を指定してください。
この例は現在公開済みであることを示すものではありません。`-y` はnpmの取得確認を省略します。

```text
npx -y @vinhphatfsg/codex-steer@<version> desktop start
npx -y @vinhphatfsg/codex-steer@<version> doctor --thread <thread-id> --json
npx -y @vinhphatfsg/codex-steer@<version> read <thread-id> --json
npx -y @vinhphatfsg/codex-steer@<version> send <thread-id> "message" --json
```

macOS、Node.js 20以降、対応するCodex Desktopが必要です。すでに起動しているDesktopは、作業を終えて終了してから `desktop start` で起動します。
CLIはDesktopを自動終了しません。監督プロンプト内の実行方法とClaudeの環境を固定版に揃える対応は、次の実装単位です。

## 配布物

`package.json` の `files` で `bin`、`src`、必要なAppleScript、音源、配布ドキュメントを指定します。
README、MIT LICENSE、package.jsonに加え、依存する `ws` とそのライセンスを `bundleDependencies` で同梱します。
実行時に追加の依存をネットワークから取得しません。install/postinstall/prepare/prepackフックは使用しません。
テスト、開発用スクリプト、`.codex`、ログ、認証情報は配布対象に含めません。

## 永続配置

`desktop start` は呼び出したパッケージの実行用ファイルを、次の場所へコピーしてからDesktopを起動します。

```text
<canonical CODEX_HOME>/codex-steer/runtimes/<version>-<sha256>/
```

ハッシュにはパス、内容、サイズ、配置時の権限を含めます。同じバージョンでも内容が異なる場合は別の保存先になります。
wrapper、CLI本体、依存、スクリプト、音源を揃えるため、元のリポジトリやnpxキャッシュを削除しても、配置したファイルは残ります。
`CODEX_CLI_PATH` はこの保存先のwrapperを指し、wrapperは従来どおりDesktop同梱の署名済みNodeを直接使用します。

配置時は次を検証します。

- CODEX_HOMEの実体が本人所有で、他ユーザーから書き込めないこと。
- 親ディレクトリも他ユーザーが差し替えられないこと（root所有のstickyな一時ディレクトリを除く）。未作成のCODEX_HOMEは検証済みの親の下へ0700で作成します。
- その下の保存先が本人所有の0700ディレクトリで、シンボリックリンクでないこと。
- ファイルが通常ファイルで、ハードリンク・特殊権限・予期しないアクセス権を持たないこと。
- 再利用する全ファイルと保存済み目録が、呼び出した配布物から計算した内容と一致すること。

一時ディレクトリでコピーと検証を完了し、同じ保存先への配置を排他してから名前を確定します。
既存ディレクトリが空・不完全・改変済みでも上書きしません。古い版や稼働中の版も自動削除しません。
並行配置は最大5秒待ちます。中断された `.install-*` ロックは自動で奪取せず `DEPLOYMENT_BUSY` で止まります。
ロックや破損した配置の削除は、その版のDesktop・helper・CLIが停止していることを確認してから行ってください。

これは、信頼する配布物を安全に配置・再利用するための検証です。配布元の真正性を独立した署名で証明する機能ではありません。
同じOSユーザー権限で任意のコードを実行できる相手や、root権限からの改変を隔離する仕組みでもありません。

## バージョン契約

runtimeには `codex_steer_package`、`codex_steer_version`、`codex_steer_protocol`、`distribution_sha256` を記録します。
Codex同梱CLIの `cli_version` とは別の情報です。初期の互換性契約は、パッケージ名・バージョン・runtime protocolの完全一致です。
内容ハッシュは配置の識別と起動直後の照合に使います。異なるソース内容の組み合わせをバージョン一致だけで検証済みとはしません。

`read`、`watch`、`send`、接続を使う `history check` は、版不明なら `STEER_VERSION_UNVERIFIED`、不一致なら `STEER_VERSION_MISMATCH` で接続前に止まります。
送信ではDesktopへの再開要求と実際の送信直前にもruntimeの同一性を確認します。切り替わっていれば `RUNTIME_CHANGED` で送信を拒否します。
不明な受付結果の自動再送は行いません。`--dry-run` は引き続き接続・配置をしません。

診断用の `doctor` は不一致でも接続情報を調べ、`ready: false` と次のフィールドを返します。

```json
{
  "codex_steer_compatibility": {
    "status": "matched",
    "client": {"package": "@vinhphatfsg/codex-steer", "version": "0.13.0", "protocol": 1},
    "runtime": {"package": "@vinhphatfsg/codex-steer", "version": "0.13.0", "protocol": 1}
  }
}
```

`matched` は上記3項目の一致です。観測APIの検証結果は引き続き `compatibility.api_checks` に分けて返します。
旧wrapperは版情報がないため未検証になります。作業を終えてDesktopを終了し、同じ固定版のCLIで起動し直してください。

## 公開前の検証

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
npm run test:protocol
```

`test:package` は実際のtarballを作り、同梱内容・実行権限を確認して、隔離した空のnpmキャッシュからオフラインでインストールします。
リポジトリ外でCLIを実行し、模擬runtimeに対するread/sendと版不一致による拒否、キャッシュ削除後の永続配置を検証します。
`test:protocol` は実際の同梱CLIと模擬Desktopを使います。実ユーザーのタスクへの送信やDesktopの停止は行いません。
実際のnpm公開には、スコープの公開権限確認、公開版の確定とユーザーからの公開指示が必要です。

参考: [npmのfilesとbundleDependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)、[npm exec/npxのキャッシュ](https://docs.npmjs.com/cli/v11/commands/npm-exec/)。
