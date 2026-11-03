# オーケストレーション

オーケストレーターは、担当への発注から検収・統合までを4操作で進めます。役割ラベルの指定や、担当ごとの監督ID・cursor・findingの手渡しは不要です。常駐プロセスは必要ありません。

| やりたいこと | 操作 |
| --- | --- |
| 頼む | `work start` |
| 見る・再起動や要約後に再開する | `project sync` |
| 言う | `work tell` |
| 一時停止・停止・明示した再開 | `project control pause|stop|resume` |

## 方針と担当範囲

方針はrepository rootの`CODEXTEER.md`へ置きます。今回の発注と合わせて担当範囲を決め、記載がなければ成果と必要な専門性から選び、その理由と境界を発注書へ書きます。モデル名・製品名から能力・権限・役割を推測しません。

発注書には目的、利用者にとっての完成状態、確定要件と仮説、一次資料、変更範囲、依存関係、共有資源、完了条件、提出物を含めます。前提・設計上の責務・重複・より小さな解決方法を根拠で検討し、通常の技術判断は進め、目的や制約の変更だけを相談します。

高度は作業の先の成果、深さは一次資料・専門的手法と外部の判定、範囲は隣接分野の有用な技法として具体化します。役柄を増やすだけにせず、期待する改善と確かめ方を結びます。重要な方針選択、新しい証拠、失敗や待機の反復、統合前、完了前に再評価し、受入条件を無断で緩めません。

## 実行先を選ぶ

必要なUnity、Blender、GUI、実機、localの未コミット差分などが、その実行先で使えると確認済みかで選びます。Desktop Cloudの構成ごとに必要なら環境調査タスクを先に出し、確認済みの道具がなければlocal Desktopを選びます。実行先の名前だけで能力を推測しません。

新規Cloud担当はDesktop Cloudを使います。`--project`はcodexteerの調整用namespaceで、Desktop DBへの所属ではありません。`--environment`は公開済み構成のIDまたは完全一致名、`--root`は方針を読むローカルcheckoutです。方針の原文バイト・SHA-256とGit出典をreceiptに保存しますが、Cloud checkoutとの一致は未検証として扱います。

基点ブランチは作成引数で指定できません。pushが委任されていれば作業ブランチだけへpushし、担当にそのブランチとSHAをfetch・照合させます。main・既定ブランチへの直接pushや無関係な差分の混入は行いません。進行しない担当はsyncで確認し、unknownの再送や追加steerを起動の回避策にしません。

環境の再公開が実行中の担当へ影響した運用観測があります。条件や保証は未確認と区別し、再公開もビルド・画面・DB等と同じ共有資源として順番を管理します。resourceは協調用リースで、OSの強制ロックではありません。

## 4操作

```sh
codexteer work start --project sample --root /path/to/checkout --title tests - --json < order.txt
codexteer --connection desktop-cloud work start --project sample --environment example-config --root /path/to/checkout --title verify - --json < order.txt
codexteer project sync --project sample --json
codexteer work tell <THREAD> - --json < instruction.txt
codexteer --connection desktop-cloud work tell <DURABLE-THREAD> - --json < instruction.txt
codexteer project control pause --project sample --work <THREAD> --json
codexteer project control resume --project sample --work <THREAD> --json
codexteer project control stop --project sample --all --json
```

sharedの作成先はDesktopの実在project ID・完全一致名とrootsを照合します。sharedとDesktop Cloudを同じproject集合に入れる場合は同じ調整用IDを使い、各担当の接続はmembershipへ保存します。発注本文をシェルコードとして評価しません。

作成結果の担当IDとreceiptを記録します。同じ発注はcreateを繰り返さず、部分成功・unknown・観測不能では同じ担当を読み取り照合します。membershipを先に登録してから監督を結び、stoppedを自動で置き換えません。初回観測が不完全ならcursorを保存しません。完全な初回観測の公開イベント全文は未提示として保存し、次のsyncで返します。

syncは全担当を一巡してからbacklogを読み、動作中・対応が必要・検収待ち・未確認へ分類します。未解決attentionは解消証拠が得られるまで根拠とtokenを再掲します。バックエンドの待機フラグは完全な最新観測で消えたら解消します。質問は後続の人間入力または同じイベントの回答済み状態、失敗は該当turnの状態更新または後続turnの成功を根拠に解消します。空の待機フラグだけでは質問や失敗を消しません。履歴の欠落、429、不完全な取得を変化なしと扱いません。idleで直近turnのcompletedと実行中turnなしを証明でき、未解決attentionがなければ検収待ちです。開始前idleや証明不足は未確認として区別します。旧Cloudの質問・承認状態は未確認なので、completedだけでは検収待ちとしません。再起動・要約後はsyncから再開します。

```sh
codexteer project sync --continue <TOKEN> --offset <NEXT_OFFSET> --event-offset <NEXT_EVENT_OFFSET> --json
codexteer project event <EVENT-TOKEN> --json
```

出力は既定16000 UTF-8 bytes、指定範囲4096〜1048576です。同じ担当内のイベントも分割します。続きは返されたtokenと両offsetを使い、`details_omitted:true`ならeventのtokenまたは担当行のdetail_tokenから詳細を取得します。

tellは最新のcomplete syncから送信直前まで再照合し、新しいイベント、質問・承認待ち、attention不明、履歴欠落、不完全な観測では拒否します。サーバーが観測版と送信を原子的に照合する保証はなく、最終観測の後に起きる競合は残ります。代理回答はせず、同じ意図やunknownを自動再送しません。検収待ちでもidleなら`--new-turn`が必要です。同じ委任の未完了作業がある場合だけ続け、受付後に新turnがactiveになれば動作中へ戻ります。検収待ちは成果の受入や全体の完了認定ではありません。

controlはproject全体の新しい監督IDを作らず、各担当の既存recordを制御します。`--all`と`--work`はどちらか一方を指定します。返り値のrequested・changed・already・failed、各code、membership_digestを確認してください。部分失敗でも全担当の結果を返し、CLIは終了値1（JSONはok:false）です。busyは未完了、binding不在は失敗、同じ状態への再実行はalreadyです。stop済みはresumeできません。対象集合は呼出し開始時のsnapshotで、新しく追加された担当は含まれません。

pause/stopは新しい外部効果を拒否する制御で、受付済みの担当プロセス自体を終了させません。ユーザーの停止指示では新規作成・追加送信も止め、controlの部分失敗を報告します。停止中でも既存の結果保存・後始末はできます。別IDや低水準操作で制御を迂回しません。

## 本文生成と互換操作

`orchestrate prompt --project sample '目標' --json`で起動せず本文を取得できます。保存方式は同じCLI・Node・CODEX_HOMEを固定し、PATH方式は`--use-path-cli`です。`cloud_command`はDesktop Cloud用で、paired hostではnullです。paired hostのwork startは未対応のため、本文はそこで新規作成を指示しません。

単一スレッドの`supervise`と既存の低水準操作は互換用に残します。managed threadへの低水準`send`は監督IDがあっても拒否し、`work tell`を使います。入口は`help details`です。詳細な配送照合・checkpoint・resourceの契約は各topicを参照してください。

## 検収

受付、担当の完了報告、検収、統合済みを区別します。目的、確定要件、最終差分、検証の全件結果、成果物の実在を確認し、統合後も検証します。外観や操作が目的なら実物も確認します。テスト成功や他モデルの賛同だけで完了とせず、残件と未確認を報告し、完了時は対象をproject control stopで制御します。
