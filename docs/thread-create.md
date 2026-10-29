# Desktopプロジェクトにチャットを直接作成する

`projects list`でローカルプロジェクトを確認し、`thread create`で初回指示付きのチャットを作成します。Desktopのnative RPCを使い、中継AIは実装から削除しました。「サンプル」のような複数フォルダ・共有フォルダを持つプロジェクトにも対応します。

```bash
codexteer projects list --json
codexteer thread create --project 'サンプル' \
  --title '関連リポジトリの調査' '関連リポジトリを読み、結果を報告してください' --json
codexteer thread create --project 'サンプル' \
  --dry-run '調査してください' --json
```

**プロジェクト名と初回指示だけで作成できます。`--context-thread`も`CODEX_THREAD_ID`も不要です。** 既存チャットがないプロジェクトでも使えます。既存チャットを探したり、別のAIを起動したりせず、作成したチャット自身の実在thread/turn IDでnative所属登録を呼びます。

`--context-thread`を明示した場合だけ、その既存チャットの保存済みターンを関連付けてnative `create_thread`を呼びます。idleでも使用できます。呼出し元への送信や追加のAIターンはありません。省略時は環境変数`CODEX_THREAD_ID`も参照せず、独立した作成になります。

プロジェクト名は完全一致で選び、同名なら`projects list`のIDを指定します。App Serverのcanonical IDとDesktop IDは読取り専用の対応表・native一覧で照合します。同名のChatGPTプロジェクトは選択しません。cwdだけで所属を推測しません。

## 作成と所属登録

標準経路は次のとおりです。

```text
terminal CLI → App Server thread/start（選択プロジェクトの全フォルダ）
  → Desktopの長期接続で購読 → turn/start（初回指示を1回だけ送信）
  → 共有App Serverのcommand/exec（追加のthread/turnを作らないAPI）
  → 固定の署名付きNode helper（read-only sandbox）
  → native tools/call move_thread_to_project（新規チャット自身）
  → Desktopの所属サービスで登録・表示更新
```

App Serverはnative操作用にcodexteer同梱の固定helperだけを起動します。native引数は所有者専用の一時JSONファイルで渡し、shellやargvへ埋め込みません。helperの許可操作はcatalog、list_projects、ローカルcreate_thread、新規チャット自身のmove_thread_to_projectだけです。新規チャットの初回処理以外のモデル推論は発生しません。

作成前に、実行中サーバーと同じ同梱CLIからcommand/execとread-only sandboxのschemaを確認します。helperはDesktopのpeer認証を通過する署名付きApp Serverの正規の子として実行されます。Unix socketへ接続するためsandboxのnetworkAccessはtrueですが、helperにHTTP/DNSや外部サービスへの接続処理はありません。認証チェックや署名は変更しません。

codexteerは選択プロジェクトからプライマリcwdと全workspace rootsを解決します。名前とcanonical所属をAPIで保存し、Desktopの購読を確立します。初回指示の前に範囲と空の履歴を確認します。初回受付後、Desktopのnative所属サービスを呼び、スケジュールと同じ所属ストアと表示へ反映します。作成応答だけを成功の証拠にせず、保存されたDesktop所属、canonical projectId、全フォルダ、userMessageとして保存された初回指示の完全一致とタイトルを照合します。関連付けを明示したnative作成の場合は、`codex_delegation`の呼出し元IDと本文を含むliteral全文を比較します。XMLとして解釈しません。

受付が履歴の永続化より早い場合は、最大5秒間、読取りだけで反映を待ちます。作成や初回ターンを再実行しません。standaloneではcanonical所属をthread/startで指定し、購読前にmetadata APIでも保存します。関連付けを明示したnative作成では必要に応じてmetadata APIでcanonical所属を登録します。Desktopの状態ファイル・DBを直接書き換えません。

CLI終了後の承認はDesktopが担当します。codexteerは承認を自動回答しません。

## 設定と接続の制約

- `--title`、`--model`、`--thinking`を明示指定できます。standaloneで指定しないモデル・権限・承認はプロジェクトのApp Server設定に従います。他チャットの設定を継承しません。関連付けを明示した場合はDesktopのnative作成規則に従います。
- standaloneで`--title`を省略すると、初回指示の空白をまとめた先頭80文字を名前にします。タイトル生成用のAIは起動しません。対象サーバーでは未使用の空チャットをDesktopが購読するために、先に名前を保存して履歴を永続化する必要があります。
- cwd・permissions・sandbox・approval policy・approvals reviewerの上書きはnative schemaにないため、指定すると作成前に拒否します。
- `--via-thread`のAI中継経路は削除しました。自動fallbackもありません。
- 本書のstandalone方式は登録済みローカルプロジェクト向けです。worktreeやクラウド実行はこの方式では扱いません。Codex Cloudには`--connection cloud thread create --project <ENV_ID>`で同じ作成操作を使えます。環境一覧・監督を含む[Cloud操作](cloud.md)を参照してください。
- `--timeout-ms`は各RPCの待機期限で、既定120000、1000〜600000です。
- `--dry-run`は接続・プロジェクト・native schemaを読み、チャット・指示・receiptを作りません。

native RPCはDesktop内部のversion依存APIです。この実装の実測はDesktop `26.1007.30912`と`26.1007.71326` / 同梱CLI `0.162.0-alpha.17.2`です。未対応schema、unsafe socket、変更されたendpoint、認証拒否では止めます。

wrapperはnative endpointを所有者専用runtimeに公開します。公開されていない旧wrapperでは、選択済み・所有者検証済みPIDと同梱Node実行ファイルを確認し、継承環境のnative endpointだけを取得します。環境全体を出力・保存しません。

作成処理は既存の共有App Serverのcommand/execを使うため、専用control serviceの追加・native_tools_rpcフラグ・追加のDesktop再起動を必要としません。wrapper自身からnative接続する旧経路と、外部Nodeがnative workerを直接起動する経路は削除しました。通常の`codexteer`コマンドがそのまま使えます。

`--dry-run`でもschemaと要求JSONの一時ファイルを作成・削除します。チャット、追加AIターン、永続receiptは作りません。

## 配送不明と部分成功

作成前に`CODEX_HOME/codex-steer/creations/<attempt_id>.json`を所有者専用で保存します。standaloneのschemaは3、`creation_mode`は`standalone`、外部`context_thread_id`と`context_turn_id`はnullです。`native_context_*`は新規チャット自身の実在IDです。`native_call_id`は所属登録のcall IDでattempt IDと一致します。初回指示のSHA-256、所属ID、rootと名前を記録します。standaloneでは省略時の名前が初回指示の先頭80文字になるため、JSON出力・receiptの`title`にもこの文字列が含まれます。指示全文の専用フィールドやAI中継用のmessages journalは作りません。

- `creation_status: created`は既に子チャットが存在することを示します。照合失敗でも同じIDを調べ、作成を再実行しません。
- `sent: true` / `delivery_status: accepted`は初回ターンの受付です。後続の所属登録・照合やreceipt保存が失敗しても、この受付を取り消しません。standaloneでは所属登録前に指示が開始するため、所属登録失敗もcreated/acceptedとして保持します。
- `creation_status: unknown` / `dispatching`は未作成の証拠ではありません。接続断・時間切れ・不明応答で自動再送しません。
- `verification_status: verified`と所属・初回指示の個別verifiedが、照合完了の証拠です。
- 最終receipt保存だけ失敗した場合は`receipt_update_required`を返します。受付済み操作を再送可能な失敗に変換しません。

## 検証

作成、所属、初回指示、CLI終了後の承認・質問を、利用者が許可した専用チャットで確認してください。環境固有の識別子や操作ログは公開しません。

DesktopのCloud環境構成で作成する場合は[Desktop Cloud](desktop-cloud.md)を参照してください。環境選択とローカルDesktopプロジェクト所属は別で、現在の所属登録は利用できません。
