# codexteer専用端末鍵の登録とペアリング

`--remote-transport paired`はcodexteer専用の端末鍵と登録を使います。既存Desktop鍵を使う`control`と、Desktop接続で観測する`native`から明示的に区別します。登録・ペアリングは利用者が実行するセットアップ操作であり、read / doctor / 監督から自動では行いません。

## 手順

Mac上で専用鍵を準備します。次のkeychain方式はXcode command-line toolsが必要です。

```sh
codexteer remote prepare --key-provider keychain --json
codexteer remote enroll --json
codexteer remote verify --json
```

`remote enroll`は公式ブラウザにfreshな本人認証を要求します。ブラウザは`https://auth.openai.com/oauth/authorize`だけを開きます。パスワードやトークンをチャットやCLI引数へ渡さず、公式画面で認証します。登録用スコープは`codex.remote_control.enroll`です。PKCE S256、state、localhostの公式コールバックポート1455 / 1457を使い、得たトークンのアカウント・スコープ・発行時刻・password auth timeを照合します。既存の通常ログイントークンを登録用step-up tokenとして代用しません。

対象WindowsホストのDesktopで、Settings → Connections → Control this PC → Set up / Addからペアリング画面を開きます。Computer向けのPIN表示へ切り替えるなどして手動ペアリングコードを取得します。CLIの追加インストールは不要です。

公式CLIを利用できる環境では、Desktopと同じプロファイルで次の方法も使えます。別プロファイルを起動したり、ホストのdaemonを再起動する必要はありません。

```sh
codex remote-control pair
```

Mac上の端末で次を実行し、発行したコードを入力します。TTY入力は非表示で、Enterで確定します。コードはargv・履歴JSON・専用登録ファイルには保存しません。パイプ入力も利用できますが、コードをshell履歴や共有ログに残さないようにしてください。

```sh
codexteer --host 'remote-control:env_example' remote pair --code-stdin --json
codexteer remote verify --json
codexteer --remote-transport paired doctor --thread '<hostId付きリンク>' --json
codexteer --remote-transport paired read '<hostId付きリンク>' --json
```

ペアリングAPIはコードが指すホストを認可します。応答のenvironment IDが指定hostと異なれば`REMOTE_PAIR_HOST_MISMATCH`で報告し、指定チャットを開きません。これはペアリング前の原子的なhost照合ではありません。入力するコードが指定ホストで発行されたものかを確認してください。`remote verify`は専用clientに許可されたホスト一覧を公式APIで再照合します。

Windows環境が`remote-control:env_example`なら、Mac側の`--host`へその値をそのまま使います。

## 鍵方式

| 明示する方式 | 実装と保護 | 制約 |
| --- | --- | --- |
| `remote prepare --key-provider openai-native` | Desktop同梱の未変更native addonを署名済みNodeで実行し、新しい専用鍵を作る。公式のhardware / OS非抽出policyを使用 | ハードウェアとOS権限に依存する。利用できない場合は停止する |
| `remote prepare --key-provider keychain` | codexteer自身のSwift helperをローカルビルド・アドホック署名し、ログインキーチェーンに非抽出P-256鍵を作る。OSのSecKey属性で非抽出・256bitを確認し、公開鍵だけをSPKIへ変換 | Secure Enclaveとは表示しない。OSのキーチェーン確認要求には利用者が対応する |

方式を失敗時に自動切替しません。準備済みの鍵を別方式で置換する要求は`REMOTE_KEY_PROVIDER_MISMATCH`で停止します。Desktop本体・同梱Nodeの署名やentitlementは変更しません。keychain方式のhelperにも、Desktopのアクセスグループや特権entitlementは追加しません。

helperはsecret keyのexport APIを呼びません。OSに非抽出属性を設定し、返されたSecKey属性がfalseであることを確認できた鍵だけを登録へ進めます。属性を確認できない候補では登録を拒否します。単に生成引数を渡したことを非抽出性の証明にはしません。

## 保存・中断と再検証

専用登録は、選んだCODEX_HOMEの`codex-steer/remote-device/<accountのSHA256>.json`へowner-onlyで保存します。含まれるのはアカウント識別子、client ID、公開鍵メタデータ、OS key ID、登録phase、ペアリング先です。Desktopの`.codex-global-state.json`は更新しません。bearer / OAuth step-up / remote-control token / pairing code / 署名proofは保存しません。

Swift helperは`remote-device/key-helpers/<source hash>/`へ保存し、実行ごとに所有者・mode・binary hash・コード署名を検査します。登録にはそのruntimeを固定し、更新時に鍵を使うhelperを勝手に作り直しません。使用中のruntimeを削除しないでください。

```sh
codexteer remote status --json
codexteer remote recover-key --json
codexteer remote verify --json
```

- `prepared`は鍵だけの準備完了。まだサーバー登録はありません。ブラウザ認証の中断はこの鍵を保持します。
- keychainの`creating-key`は鍵作成の結果が未確定。保存済みcandidate key IDの`recover-key`で同じ鍵を照合します。新規作成はしません。
- `starting` / `creating-key` / `key-created`でサーバーclient IDを取得済みのものは、未完了の登録です。別clientや鍵を自動作成しません。
- `finish-unknown`は登録完了応答が未確定。`remote verify`は同じ鍵とclient IDで認証だけを確認し、成功すればenrolledへ進めます。finish要求は再送しません。
- ペアリング応答不明は`pairing_unknown`。同じコードを自動再送せず、`remote verify`で公式の許可ホスト一覧を読み直します。

`remote verify`のWebSocket操作は認証proofだけで、App Server initializeやチャットRPCは送りません。別途pairedのdoctor/readを実行して初めて、その対象の読み取りを検証します。

## 監督との接続

paired接続は既存のRemote Control v3 adapterを使い、送信には同じ`turn/steer.expectedTurnId`照合、freshness、pause/stop、finding重複防止、配送照合を適用します。native / control / pairedのカーソル・監督IDは交換できません。専用登録がない場合や指定ホストがペアリングされていない場合は、外部socketを開かずに停止します。失敗時にDesktop鍵へ切り替えません。

登録・ペアリングと、チャットの作成・送信は別々に利用者が許可する操作です。対象のホスト・プロジェクト・チャットを確認し、許可された範囲だけで使ってください。callerと購読条件は[リモートCLI操作](remote-operations.md)を参照してください。監督役から資格情報セットアップは実行できません。

## 端末名とサーバー表示の照合

従来のWebSocketは`User-Agent: codexteer`しか送らず、同じ専用clientのサーバー表示は`Unknown Computer`・platform nullでした。HTTPとWebSocketへcodexteerの製品名・実OSバージョン・CPUを送るよう変更しました。macOSでは固定の`/usr/bin/sw_vers -productVersion`から取得し、失敗・不正値はバージョンなしへ限定します。OSの識別のためにDesktop製品を名乗りません。

```sh
codexteer remote status --json
codexteer remote verify --json
codexteer remote identity --json
```

`controller_name`は`codexteer_mac_os_arm64`などのCLI側の識別名です。`remote identity`は公式アプリが使う`GET /wham/remote/control/clients`を読み、同じ専用clientだけを選別して`server_display_name`・OS・端末種別を返します。他端末・アカウントユーザー・位置情報は出力しません。identity自体は接続や名前変更を行いません。

任意のクライアント表示名の更新は未対応です。`name_matches`と`custom_name_update`でローカル識別名とサーバー表示の違いを明示します。表示名を合わせるための自動再登録・鍵置換・ホスト名変更は行いません。

## 互換性

登録とペアリングの経路はDesktopのバージョンに依存します。外部CLI向けの安定した登録SDKであるとは扱いません。schemaの変更や認証拒否では停止し、利用環境で確認してください。秘密値や実際の識別子を含む診断記録は公開しないでください。
