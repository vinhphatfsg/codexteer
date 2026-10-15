# 中継AIなしのDesktopチャット作成経路の調査

実装・直接作成・承認往復の後続結果は[現在の運用と実機検証](thread-create.md)を参照。以下は実装前の調査時点の記録です。

調査日: 2026-10-14 JST。対象はインストール済みDesktop `26.1007.30912` (build `20156`, bundle ID `com.openai.codex`) と同梱CLI `0.162.0-alpha.17.2`。この調査ではチャット作成、指示送信、所属変更、Desktop再起動、実装の置換を行っていない。

## 結論と検証の境界

モデル推論を伴わずにDesktopのnative toolを実行できる接続経路がある。認証されたnative RPCの `tools/list` に `create_thread`、`move_thread_to_project`、`list_projects` が存在し、`tools/call` で `list_projects` を実行できた。追加のAIターンや中継指示は不要だった。

native `create_thread` はDesktop内でプロジェクトの全フォルダを解決し、スケジュールと同じ `threadProjectAssignments.setAssignment` を使って所属を保存する。実装候補は既存Desktop wrapperからこのnative toolを直接呼ぶ方法である。ただし、今回の直接RPC検証は読み取りまで。直接RPCによる作成、所属の実機反映、初回指示、CLI終了後の承認往復は未検証であり、現行のAI中継実装はまだ置換していない。

以前の「複数フォルダ・重複フォルダにはAI中継が必要」という判断は、native RPCの直接呼出しを調べきる前だった。native RPCの存在と読み取り実測により、その判断は修正する必要がある。

## スケジュールが正しい所属になる理由

スケジュールの `Ll` は新しいthreadを作成した後、初回ターン開始前にDesktopの所属サービスを呼ぶ。

```js
await threadProjectAssignments.setAssignment({
  threadId,
  assignment: { projectKind: "local", projectId: project.projectId },
});
```

Desktopの所属ストアは `thread-project-assignments` / `projectless-thread-ids` であり、更新時に `thread-project-memberships-updated` を通知する。App Serverのcanonical `projectId` だけを設定する経路と一致しないため、同じcwdを持つ「競馬」と `prediction_model` で分類の差が生じていた。直接global stateを書き換える方法は採用しない。Desktop自身も汎用 `set-global-state` によるこの所属ストアの変更を拒否している。

native toolの作成処理は次の経路を通る。

1. `create_thread` handler (`execution-fde3a4937b6a.js` の `sp`) が引数を検証し、Desktopのチャット作成処理へ渡す。
2. `sso` → `MZr` が指定したDesktopプロジェクトIDからcwd、全workspace roots、`projectAssignment` を取得する。
3. `HGi` → manager `startConversation` → `zln` がthreadを作成し、初回ターン前のcallbackで `saveThreadProjectAssignment` を呼ぶ。
4. このcallbackはDesktop hostの `threadProjectAssignments.setAssignment` を呼び、所属ストアと表示へ反映する。callbackがない構成でも `threadWorkspaceStorage.setProjectAssignment` が同サービスを呼ぶ。
5. Desktopが初回指示とターン開始を担当する。明示的なsourceThreadIdがあるnative toolでは指示が `codex_delegation` として保存される。

`CAr` はプロジェクト内の手動表示順を保存する処理であり、所属登録の本体ではない。所属登録は上記の `setAssignment`。

native `move_thread_to_project` もDesktopのsidebar移動処理から所属サービスの `setMembership` を呼ぶ。これは既存のApp Server作成経路に所属登録だけ追加する候補だが、作成と移動の部分成功や初回ターンの順序を別に管理する必要がある。

## native RPCと認証

Desktopは子プロセスに `CODEX_APP_TOOLS_PIPE_PATH` を渡す。既存shared wrapperがこの値を継承していることを、選択中wrapperの環境の該当キーだけを読み取って確認した。環境全体や秘密値は出力していない。

native pipeはUnix domain socket。macOSでは長さ4バイトのnative endian (今回LE) + UTF-8 JSONのframeを使い、frame上限は8 MiB。newline JSONのApp Server protocolとは別物である。socketは所有者専用で、接続時にnativeのsocket peer認証が行われる。既存wrapperはDesktop同梱の署名付きNodeを直接使う。認証を無効化・迂回する方法は使っていない。

native serverの `Vae` は `tools/call` を `callDynamicAppTool` に渡す。mainのdispatcherは準備済みDesktop windowを選び、rendererの `canCallTool` / `dispatchToolCall` がnative handlerを実行する。ここに中継AIの推論はない。

```json
{
  "id": "request-uuid",
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "arguments": {},
    "callerSource": "codex",
    "callId": "unique-call-uuid",
    "hostId": "local",
    "namespace": "codex_app",
    "threadId": "existing-caller-thread-id",
    "turnId": "actual-stored-caller-turn-id",
    "tool": "list_projects"
  }
}
```

`threadId` / `turnId` は呼出し元の監査・関連付け用contextであり、モデルを起動するための指示ではない。今回のprobeは実在するチャットとその保存済みターンだけを使用した。架空IDは使用していない。rendererは呼出し元threadを読み込めることを確認し、callIdの実行claimを取る。idleの保存済みターンを使った読み取りも成功したが、作成toolで同じcontextが使えるかは未検証。

`taskProject/assign` という別RPCもあるが、これはWorkのlocal executorの実在environmentIdとthreadのenvironment一致が必要な経路である。通常のCodexチャットに `environmentId: "local"` を付ければ使えるAPIではない。この候補では使用しない。

## 読み取りの実測

一時probe `/private/tmp/codexteer-native-read-probe.mjs` を同梱Node `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` で実行した。選択中shared runtimeのプロセス確認とローカルIPC読み取りのみ、sandbox外で実施した。

| 確認 | 結果 |
| --- | --- |
| `tools/list` (`threadStartKind: all`) | 57 native tools。作成・所属移動・プロジェクト一覧のschemaを取得 |
| `tools/call list_projects`、現在の実在activeターン | `success: true`、23プロジェクト |
| 同呼出し、既存idleチャットの保存済みcompletedターン | `success: true`、23プロジェクト |
| idleチャットの後続読取り | idle、latest turnは同じcompletedターン、turn数4。新しいターンは発生していない |

idle contextは既存検証チャット `01a135bf-1087-7902-8b78-0fb683b025d6`、保存済みターン `01a135cb-47ba-73a0-befe-6eb41452655e`。現在のcontextはthread `01a135a4-c1ea-7081-be4c-3c5ab7b11193`、turn `01a135d2-9375-78f0-8f39-ced3c29a5d98`。

native一覧は次のDesktop IDを返した。作成先にはnative一覧のIDを使う。App Serverのcanonical IDと混ぜない。

| label | projectKind | Desktop projectId |
| --- | --- | --- |
| codex-steer | local | `8b8c19b2-5a36-4683-8b2f-28a489e03724` |
| 競馬 | local | `ad16728e-81d9-499f-81c8-fdf13f0f9d89` |
| prediction_model | local | `cad845a7-dfb1-45b8-8503-b9aca1ee89d6` |
| 競馬 | chatgpt | `g-p-69379d229d7081918b1efb6f5c107d17` |

localの「競馬」と `prediction_model` は両方ともpathが `/Users/phat/Desktop/app_race-calc_h/prediction_model` だが、IDは異なる。同名ChatGPTプロジェクトも存在するので、プロジェクト解決ではkindとIDを確認する。

## codexteerへの組込み候補

```text
terminal CLI → 共有App Serverのcommand/exec
  → 固定の署名付きNode helper（thread/turnやモデル推論なし）
  → Desktop native RPC tools/call create_thread
  → Desktopでproject roots解決・setAssignment・初回ターン開始
```

実装時には、wrapper自身のnative接続では署名情報検証に失敗することを確認したため、既存App Serverの正規の子としてhelperを起動する経路を採用した。command/execは独立したコマンド実行APIで、チャットやAIターンを作らない。matching CLI schemaで対応を確認し、固定の署名付きNodeとhelperに限定する。詳細と実測は現在の運用文書を参照。

端末からの呼出しには実在するcaller contextの明示または確実な解決が必要である。context用チャットのモデル起動や追加ターンは不要な見込みだが、作成toolで検証してから契約にする。現在の `--via-thread` のようなAIへのメッセージ配送は廃止候補となる。

nativeの作成引数は以下で、promptと指定プロジェクトをそのまま渡せる。

```json
{
  "prompt": "initial instruction",
  "title": "optional title",
  "target": {
    "type": "project",
    "projectId": "Desktop projectId",
    "environment": { "type": "local" }
  }
}
```

モデル・thinkingはnative schemaの対応範囲内で指定可能。cwd・sandbox・approval policy等を任意に上書きする引数はこのnative toolにないため、既存CLIのオプションをそのまま対応済みとは扱わない。native経路でDesktopの設定を使うか、所属移動だけを使う別経路が必要。

組込み後の必須検証は、単一フォルダと「競馬」の全7フォルダ、共有cwdでの正しいDesktop所属、初回指示の完全一致、短命CLI終了後のDesktop承認継続・承認往復、途中失敗の同一attemptでの照合である。tool callIdがあることを作成のidempotency保証と解釈せず、不明結果を自動再送しない。

native RPCはこのDesktop内部のversion依存interfaceであり、公開App Server互換契約ではない。wrapperのcapabilityとnative schema/接続を確認し、未対応なら作成前に止める。AI中継へ自動fallbackしない。稼働中wrapperへコードを追加するには対応版で起動し直す必要があるが、この調査では再起動していない。

## 調査に使用したインストール済みコード

ASARは読み取り専用で展開し、bundleや署名は変更していない。minified名はこのbuildに限る。

| ASAR resource | SHA-256 |
| --- | --- |
| `.vite/build/main-CqEoQDOU.js` | `09d19386e1f23cf4ccbc950fc40d85a1e8a064a08be588b2a4be6a89f6ada9e6` |
| `webview/assets/app-initial-6350d04672d0.js` | `604b5d2de4fbb41f3d0dc5b3662129c558e1c7b8aac8cc87225286f58dcfaf8f` |
| `webview/assets/app-shared-8bd9d0399038.js` | `607ad0866dd25ed3764711b4467a9b60708353a599485b5249ff4cbe0e870245` |
| `webview/assets/execution-fde3a4937b6a.js` | `5c300497b7331bfa317231251e1097385405b70f2746b1fe8959c74e56735811` |
