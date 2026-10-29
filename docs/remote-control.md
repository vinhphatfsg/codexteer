# リモートへの指定ターン送信と監督

`--remote-transport control`を明示すると、Remote Control WebSocket protocol v3のフレーム内にApp Server JSON-RPCを載せ、`remote-control:env_...`で選んだホストへ直接送ります。`turn/steer`の`expectedTurnId`をそのままリモートApp Serverに渡し、サーバーが現在のターンと照合します。Desktopのnative `send_message_to_thread`やfollower操作による、宛先ターンの推測は使いません。

**control経路は実験的な実装です。** 既存Desktop鍵をhelperから利用できない環境では、接続前の公開鍵診断で停止します。control経路の動作確認は利用環境ごとに必要です。鍵へのアクセス権を変更したり別の鍵へ自動切替したりしません。

Desktop鍵に限定しない場合は、[専用端末鍵を公式登録するpaired経路](remote-device-enrollment.md)を明示選択できます。native / control / paired間で資格情報やカーソルを自動的に切り替えません。

```bash
# 対象を読み取りだけで診断する。送信や再開はしない。
codexteer --remote-transport control doctor --thread '<hostId付きリンク>' --json

# 送信を伴う監督用の本文を生成する。本文生成だけでは接続しない。
codexteer --remote-transport control supervise prompt '<hostId付きリンク>' --use-path-cli

# 監督役を起動する。明示した方針と目的の範囲内で、既存のactiveターンへ介入する。
codexteer --remote-transport control supervise '<hostId付きリンク>' --agent codex

# 同じ経路で読み、カーソルと指摘を登録してから送信する。
codexteer --remote-transport control read '<hostId付きリンク>' --json
codexteer --remote-transport control findings create '<hostId付きリンク>' \
  --key '<安定したkey>' --title '<指摘>' --condition '<解決条件>' --based-on '<CURSOR>' --json
codexteer --remote-transport control send '<hostId付きリンク>' '<指示>' \
  --finding '<FINDING-ID>' --based-on '<CURSOR>' --source codex --kind review --json
```

control経路は通常の端末からの利用も想定した実装で、`--context-thread`は不要です。リモートリンクか`--host remote-control:env_...`は必須です。`--remote-transport`を省略した既存のnative経路は、引き続き観測専用です。接続失敗時にnative送信、UI、SSH、別ホストへ切り替えません。SSHホストやChatGPT cloudのIDをRemote ControlのIDへ読み替えません。

## 接続・認証と照合

1. 選択したCODEX_HOMEの既存shared wrapperと、同梱CLIのcommand schemaを検証する。
2. 正規App Serverの`getAuthStatus`を読み、現在の標準ChatGPTアカウントを特定する。トークンはメモリ内だけで扱う。
3. 同じトークンのaccount userまたはDesktopが受け付けるauth user aliasに一致する既存Desktop device-key enrollmentを読み取る。account headerはトークンのaccount IDに固定する。新規キー・登録・設定変更を行わない。
   固定helperのinspect操作で既存公開鍵を照合する。失敗すればREMOTE_DEVICE_KEY_UNAVAILABLEとremote_control_auth診断を返し、WebSocketを開かない。この操作は署名しない。
4. `wss://chatgpt.com/backend-api/codex/remote/control/client`だけにTLSで接続し、HTTP Authorizationと`ChatGPT-Account-Id`を使う。URL変更・リダイレクト・別の認証方式へのfallbackを行わない。
5. `x-codex-protocol-version: 3`と`x-codex-client-auth: socket-refresh-v1`を指定し、目的・宛先origin/path・アカウント・client・scope・nonce・有効期限が一致した認証チャレンジだけを受け付ける。purposeとaudienceは`remote_control_client_websocket`、scopeは`remote_control_controller_websocket`で別の値である。socket-refresh未対応なら停止する。
6. 固定のhelperをDesktopの署名付きNodeから読み取り専用sandboxで起動する。OSの非抽出キーを既存登録の公開鍵と照合し、許可した接続チャレンジだけへ、定義したフィールド順に正規化して署名する。秘密鍵はエクスポートしない。helperの入出力と一時ファイルへbearer tokenを渡さない。
7. 署名を登録済み公開鍵で検証し、`device_key_authenticated`が返った場合だけ専用のstream IDを開く。
8. すべての読み取り・送信前にローカルのアカウントとenrollment、選択中runtimeが変わっていないことを確認する。各フレームのclient・env・stream・連番と分割ペイロードを検査し、選んだホスト以外の履歴や受付結果を採用しない。

この経路の利用は、既存ログイントークンを上記の公式宛先へ送信し、登録済みOSキーで接続チャレンジへ署名する操作を伴います。OSやDesktopの認証拒否を解除・迂回せず、そのまま停止します。通常起動の`--connection desktop`は引き続き観測専用で、controlとの併用は拒否します。

## ターン照合と監督の制約

既存の`readSendState`・`sendOnClient`と同じ処理で最新のactiveターンを選び、`threadId`・`expectedTurnId`・`clientUserMessageId`を固定して一度だけ`turn/steer`します。ターンが入れ替わればサーバーの拒否を返します。別のターンを選び直して再送しません。transportのACKをメッセージ受付と解釈せず、App Serverの同じturn IDの応答でだけacceptedにします。

監督ID・finding・読了カーソル・ユーザー入力の更新確認・pause/stopのロック・重複介入防止・配送記録は既存の処理を使います。unknownはclient message IDを持つ実際の履歴と`history check`で照合し、not_observedを未配送と決めつけません。接続の再開時も送信フレームをreplayしません。手動の新しい送信も、委任されたメッセージや監督の範囲内で行います。

controlとnativeでは公開履歴の項目構造・出力制限が異なるため、カーソルと監督登録を`remote_transport`にも結び付けます。同じhostIdでも別経路のカーソルや監督IDを使うと停止します。既存nativeのカーソルにremote_transportがない場合はnativeとして扱います。送信履歴と指摘は同じホストの対象として共有し、経路を変えて重複送信を回避しません。

- `--new-turn`、`thread/resume`、`turn/start`は未対応。別接続から新規ターンを始めて承認の所有者を失わないよう拒否する。
- UI送信、代理の承認回答、作成、履歴修復は未対応。
- 送信JSONは64 KiBまで。大きすぎる要求は配送前に拒否する。
- 応答はフレームごとに150 KiB、再構成後64 MiBまで。欠落・順序異常・別ホストのフレームは停止する。
- 接続・認証・schemaの対応状況と、指示の実配送・UI表示・承認往復は別々に扱う。

## 鍵が利用できない場合

`doctor`が`REMOTE_DEVICE_KEY_UNAVAILABLE`を返す場合、`remote_control_auth`の失敗段階と分類を確認してください。これは鍵がDesktopからも消えている証拠ではありません。Desktopの署名・Keychain ACL・entitlementを変更せず、必要なら利用者が専用鍵のpaired方式を別途選択してください。診断や登録の許可は、チャットへの指示送信の許可を意味しません。

## 検証

`test/remote-control.test.mjs`では、テスト用EC鍵・架空のトークン・フレームを使い、チャレンジと署名の照合、別アカウント/宛先/期限/ホストの拒否、ターン交代拒否、unknown配送とreplay禁止、idle/new-turn拒否、freshness・pause/stop・findingの重複拒否、client IDでの保存履歴照合、保存済みCLIとPATH版の監督本文を検証します。実アカウントは使いません。

`npm run test:remote-control`は一時プロファイルの実同梱Rust App Serverとloopbackの偽モデルを使います。Remote Controlフレームのadapterを通した正しいターンの受付と、誤ったexpectedTurnIdのサーバー側拒否、送信前freshnessの照合を確認済みです。公式ゲートウェイ、実トークン、実device keyは使いません。
