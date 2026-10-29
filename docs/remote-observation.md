# リモートプロジェクトとチャットの観測

`projects list --remote`でDesktopに登録済みのリモートプロジェクトを取得できます。`hostId`付きリンクは、そのホストのチャットとして読み取り・監視・観測専用の監督に使えます。この文書の既定native経路では、指示送信・再開・作成・履歴修復は未対応です。指定ターンへの送信は、別途明示する[control経路](remote-control.md)に実装しています。controlの認証チャレンジ受信まで確認済みですが、既存端末鍵へのアクセスで停止しています。

```bash
codexteer projects list --remote --json
codexteer projects list --all --json
codexteer projects list --host 'remote-control:env_example' --json

codexteer read 'codex://threads/<UUID>?hostId=remote-control%3Aenv_example' --json
codexteer doctor --thread 'codex://threads/<UUID>?hostId=remote-control%3Aenv_example' --json
codexteer watch 'codex://threads/<UUID>?hostId=remote-control%3Aenv_example' --stream --json
codexteer supervise 'codex://threads/<UUID>?hostId=remote-control%3Aenv_example' --agent codex
codexteer supervise prompt 'codex://threads/<UUID>?hostId=remote-control%3Aenv_example' --use-path-cli
```

UUIDと`--host HOST-ID`を別々に指定しても同じ対象になります。リンクの`hostId`と`--host`が矛盾した場合は`HOST_MISMATCH`で停止します。裸のUUIDは従来どおりローカルです。ホストの省略を補うために別ホストを検索しません。

## プロジェクト一覧

引数なしの`projects list`は従来どおりローカルApp Serverのcanonical ID・全rootsを返します。`--all`はその一覧とリモート登録一覧を併合します。`--remote`またはリモートの`--host`はローカルApp Serverへ接続せず、選択した`CODEX_HOME/.codex-global-state.json`の`remote-projects`だけを読みます。状態ファイルを更新しません。

リモート項目はDesktopの登録ID、登録名、remotePath、host_idを返します。Windows/UNCパスをMacのパスへ変換・realpathしません。`source: desktop-registration`と`availability: unverified`は登録情報であり、接続・リモート上の存在・Git判定を確認していないことを示します。今回確認したDesktopのnative `list_projects`はリモートGitメタデータの取得に失敗した項目を省略するため、それを完全な登録一覧として使いません。空配列もリモート上にプロジェクトがないという証明ではありません。

## 読み取りの前提

Desktopが接続済みの対象ホストを、既存shared wrapperの署名付きNode helperからnative `read_thread`で読みます。既存のnative認証・ソケット所有者検査・matching bundled command schema・live native catalogの検証を使います。別のリモート接続、認証情報のコピー、SSH、モデルの中継ターン、Desktopの再起動は行いません。`--connection desktop`との併用は`HOST_CONNECTION_MISMATCH`です。

native toolには実在するローカル呼出し元と保存済みターンが必要です。Codexチャット内では`CODEX_THREAD_ID`を使います。普通の端末から実行する場合は、同じプロファイルの既存ローカルチャットを明示します。

```bash
codexteer --context-thread '<LOCAL-CALLER-UUID>' read '<HOST-LINK>' --json
codexteer --context-thread '<LOCAL-CALLER-UUID>' supervise '<HOST-LINK>' --agent codex
```

このcontextはnative呼出しの関連付け用です。呼出し元へのメッセージ送信・新しいターン作成は行いません。未指定・リモートのcontext・保存済みターンのないcontextは拒否します。対象チャットの応答hostIdが選択先と異なった場合も、結果を採用せず停止します。

native履歴は10ターン単位で全ページを読み、既存のイベント差分・カーソルを生成します。最大100ページ（1000ターン）を超える場合や、ページの重複・不完全なturnでは部分履歴を完全な結果として返しません。コマンド出力とdiffはDesktopが項目ごとに最大20000文字へ制限するため、その場合は`[truncated by Desktop]`を付けます。思考内容は公開イベントに含めません。履歴が大きいチャットは読み取りに時間がかかります。`watch --stream`のキャンセルは次の境界で終了し、未完了のnative読取helperは最大30秒でタイムアウトします。

## 監督の範囲と記録

既定native経路で生成するプロンプトは`observation_only: true`です。既定の方針も観測・問題報告用になります。`--host`、`--context-thread`、`--supervisor`、`--connection`を全コマンドに保持します。明示した方針が送信を求めても、リモートへの送信は`REMOTE_READ_ONLY`で拒否します。Desktopのnative送信APIでは`expectedTurnId`照合と暗黙のターン開始禁止を指定できないため、既存の送信制約を省略して対応扱いにはしません。

監督記録・指摘・履歴・ロックは`CODEX_HOME/codex-steer/hosts/<host-idのSHA256>/`でホスト別に保存し、記録には`host_id`を付けます。既存ローカル記録の場所は変えません。カーソルもhost_idに結び付け、別ホストやローカルのものは`STALE_CURSOR`です。

```bash
codexteer --host 'remote-control:env_example' supervise list --json
codexteer supervise status '<HOST-LINK>' --json
codexteer supervise pause '<HOST-LINK>' --json
codexteer supervise stop '<HOST-LINK>' --json
```

`pause`後も観測できます。`stop`後はその監督の観測を拒否し、対象Codexの作業は継続します。`doctor`はリモート読み取りの検証結果と送信未対応を分けて返します。診断成功は指示配送・画面表示・承認往復を保証しません。

## 検証

自動テストは架空のホストと一時プロファイルを使い、複数ページの読取り、別ホストの応答拒否、カーソル・監督記録・停止制御のホスト分離を確認します。実際のホスト名・業務タイトル・チャットID・応答本文は公開記録に含めません。環境ごとの接続条件は利用者自身の`doctor`結果で確認してください。
