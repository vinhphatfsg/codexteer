# Cloud モデル選択の設計と検証

検証日: 2026-11-07 JST。対象は Desktop Cloud の新規作成に対するモデル・エフォートの選択と保存です。

## 設計判断

現在のアカウントの `model/list` を全ページ取得し、非表示モデルを除いて、そのモデルが提示するエフォートだけを選択肢にします。取得結果はキャッシュしません。対話選択後と作成時にも検証するため、選択中に利用可能なモデルが変われば保存・作成を拒否できます。検証後にサーバー側の条件が変わった場合は、実際の RPC の成否と受付不明の規則に従います。

保存は既存の `store.mjs` の所有者確認、0600、ロック、一時ファイルからの原子的 rename を使います。モデルとエフォートを一つのレコードとして保存・読み込みし、二つの世代を混ぜません。保存済み値が不正なら自動的に Cloud 既定へ戻さず、再選択を要求します。

引数のモデルが保存モデルと同じなら保存エフォートを継承できます。異なるモデルを明示した場合はそのモデルの既定エフォートを選びます。例えば保存値 `A/high` に `--model B` だけを指定すると、B の既定が medium なら `B/medium` になります。`--thinking high` を併用すれば B が high をサポートする場合だけ作成します。

新しい `work start` はモデル選択を発注レコードへ固定します。別の新規発注は変更後の保存設定を読み、同じ発注の再実行は既存の予約を使います。選択した組合せは `thread/start` と初回 `turn/start` の両方に渡し、後者の model/effort が以後のターンに引き継がれる API 契約を利用します。通常の継続送信は保存設定を読み直しません。

採用しなかった案は、モデル ID のハードコード、プロセス開始時だけの設定読込み、モデルとエフォートの別保存、再実行時の既定値の再解決、受付不明時の再作成です。これらはカタログの陳腐化、切替の遅延、設定の混在、予約の変更、二重実行を招きます。

旧 `docs/desktop-cloud.md` の「作成はサーバー既定モデルを使う」という記述は新しい実装と一致しなくなるため、「引数 → 保存値 → Cloud カタログ」に更新しました。ローカル Desktop と Web Cloud の設定経路は変更していません。

## TLA+ モデル

ソースは `formal/CloudModelDefaults.tla`、実行器は `scripts/check-cloud-models-tla.mjs`、実行結果は `formal/CloudModelDefaults.results.json` です。モデルは設定選択・中止・検証・原子的保存、カタログの変化、引数の部分上書き、発注の予約、作成と初回ターンの送信前記録・送信・応答消失・読み取り照合を含みます。

| モデルの操作・性質 | 実装への対応 |
| --- | --- |
| `ValidateSave` / `Publish` / `AtomicDefaults` | `setCloudModelDefaults` と `writeRecord` による検証済みペアの原子的保存 |
| `Cancel` / `AbandonSave` | `pickCloudModel` の q・Ctrl-C・EOF、保存前の abort 検査 |
| `Resolved` / `Reserve` / `PinnedChoice` | `selectCloudModel` の優先順位、`startWork` の `model_selection` 保存 |
| `ValidateCreate` / `ValidatedBeforeCreate` | 作成直前のカタログ再取得と固定済み組合せの再検証 |
| `RetryKnown` | `creation_status:not_created`・`creation_dispatched:false`・`sent:false`・thread ID なしの保存証拠と同一要求の照合 |
| `ArmCreate` / `SendCreate` / `CreateAtMostOnce` | 作成受付記録を保存してから `thread/start` を一度だけ送る |
| `LoseCreate` / `ReconcileCreate` | 受付不明では再送せず、環境・指示 digest・モデル・エフォートを照合する |
| `ArmTurn` / `SendTurn` / `FirstTurnAtMostOnce` | 配送 journal と `sendDesktopCloudInput` の受付不明予約 |
| `CreateUsesChoice` / `TurnUsesChoice` | 同じ固定済みペアをスレッドと初回ターンに明示する |
| `NoTurnWithoutCreate` | 作成済み ID と空の新規スレッドを確認して初回送信する |

同一発注を使う複数呼出しは、一つの発注状態として抽象化しています。これは既存 `withStoreLock` が発注ごとの処理を直列化するという仮定です。別発注二つと設定変更の交差実行も探索します。

## TLC の結果

TLC 2.19、OpenJDK 17、2 workers で、探索の深さを切らず、以下の有限インスタンスで到達可能な全状態を探索しました。

| ケース | 異なる到達状態数 | 結果 |
| --- | ---: | --- |
| 1発注・3組合せ・カタログ変更・失敗あり | 10,240 | 9不変条件すべて PASS |
| 2発注・2組合せ・カタログ変更・失敗あり | 52,488 | 9不変条件すべて PASS |
| 2発注・2組合せ・成功経路 | 5,202 | 不変条件と `EventuallyDone` PASS |

進行性はカタログが安定し、送信・応答が成功し、各発注が弱公平に実行されるという条件付きです。送信されたか分からない状態で自動再送をしない設計なので、すべての障害下での完了は主張しません。

検出能力の確認として、次の7種類の不具合を一つずつ有効化したモデルを実行しました。すべて指定した不変条件の反例を検出し、TLC の invariant violation 終了コード12を確認しました。

| 不具合モデル | 検出した違反 |
| --- | --- |
| 保存時に新モデルと旧エフォートを混ぜる | `AtomicDefaults` |
| 保存変更後も古い既定値を使う | `PinnedChoice` |
| 未送信の再実行時に予約を新設定へ差し替える | `PinnedChoice` |
| 初回送信時だけ最新の設定を読み直す | `TurnUsesChoice` |
| 作成受付不明を再送する | `CreateAtMostOnce` |
| 初回送信受付不明を再送する | `FirstTurnAtMostOnce` |
| 利用不可になった組合せの検証を省く | `ValidatedBeforeCreate` |

モデル SHA-256: `697f04a5cea12b2f6580c605835583056f06413d4b863c3d58bdcd6de275a467`

TLC jar SHA-256: `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`

再実行:

```sh
TLA2TOOLS_JAR=/absolute/path/to/tla2tools.jar npm run test:models-formal
```

必要に応じて `JAVA_BIN=/absolute/path/to/java` を指定できます。実行ごとに一時ディレクトリへモデル、各ケースの `.cfg`、TLC ログ、反例、`result.json` を保存し、最後に結果のパスを表示します。TLC は内部 RMI ソケットを使用するため、listen を拒否する sandbox 内では実行できません。

## 実装の検証と限界

- 最終コードで `npm run check` 成功、`npm test` は815件中813成功・失敗0・既存の opt-in 2件スキップ。配布 tarball と npx 経由の新しいヘルプ・保存設定の読取りも含みます。
- JavaScript テストはページング、不正カタログ、保存値の再読込み、未対応ペアの拒否、上書きの優先順位、原子的保存、中止、作成要求、再実行、受付不明、照合時のペア不一致を確認します。
- 実 CLI を隔離 CODEX_HOME とテスト専用 Cloud サービスで起動し、保存を切り替えた直後の `thread create` と `work start` が、異なる選択を `thread/start` と初回 `turn/start` へ渡すことを検証しました。同じ発注を繰り返しても追加の作成・送信はありません。
- 対話端末でモデルとエフォートの選択・保存、中止後の既存値保持を確認しました。`q`・Ctrl-C・EOF の3経路はいずれも「選択を中止しました。設定は変更していません。」と表示し、エラーや不要な使い方案内を出さず正常終了します。モデル選択中とエフォート選択中を含む PTY 試験で、保存ファイルのバイト列が変わらないことも確認しました。テスト専用ローダーは本番の接続先設定として提供しません。
- 新しい `models list` を実 Cloud に対して読み取り実行し、9モデルと各モデルの選択肢を取得できました。公式 CLI の生成スキーマでも `TurnStartParams.model` と `effort` がそのターン以後に適用される契約を確認しました。
- 2026-11-07 JST、変更をローカルの通常の `codexteer` コマンドへ反映し、実 Cloud の新規スレッドでも以下の受入試験を完了しました。作成コマンドに `--model` / `--thinking` は指定せず、両方とも `model_source` / `thinking_source` が `saved` であることを確認しました。

| 作成経路 | 保存した組合せ | Cloud から読み直した値 | 初回ターン |
| --- | --- | --- | --- |
| `thread create` | モデルA / エフォートA | `thread.model` / `thread.reasoningEffort` が保存した組合せと一致 | `completed`, `error = null` |
| `models set` 直後の `work start` | モデルB / エフォートB | `thread.model` / `thread.reasoningEffort` が保存した組合せと一致 | `completed`, `error = null` |

モデルAとB、エフォートAとBはそれぞれ異なります。アカウントの実カタログから選んだ具体名は公開記録では匿名化し、照合に使った実値はローカルの非公開証跡に保持しています。

実 Cloud の `thread/read` と `thread/turns/list` で独立に照合しました。各スレッドの履歴は初回ターン1件だけで、指定した確認文字列の返答があり、ツール実行はありませんでした。モデル自身の自己申告やローカルの作成レシートだけを判定根拠にはしていません。Desktop の再起動なしで、保存後の次の CLI 呼出しに設定切替が反映され、設定復元後も既存の各スレッドは元の組合せを保持しました。

検証には既存の `codexteer` Cloud 環境を使い、新規スレッドは2件だけです。検証前の保存設定を最後に復元しました。復元はロック内で検証用設定の記録が一致する場合だけ行い、並行する利用者の変更を上書きしません。公開ドキュメントには実スレッド・環境・アカウントの ID、認証情報、非公開ジャーナルを含めません。実行コードは `4a9c671`、ローカル配布 SHA-256 は `bb761e4dab7ff737190064a2ae1334204b1fb463f7bd58d5910e56b80881dd48` です。

サーバー内部の実モデルへのルーティング、認証、ネットワーク、実ファイルシステムや JavaScript 全体を TLA+ から機械的に証明したものではありません。実 Cloud の受入試験は、公開されたサーバー状態とターン完了の確認です。

結論は、記載した有限モデル・仮定・不変条件の範囲で反例がないことと、対応する実装のテストが通ることです。無制限の発注数やあらゆる外部障害を含む「実装に一切のバグがない」という主張には拡張しません。
