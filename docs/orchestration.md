# オーケストレーション

オーケストレーターは、担当への発注から検収・統合までを4操作で進め、離席中は`project wait`で監視します。役割ラベルの指定や、担当ごとの監督ID・cursor・findingの手渡しは不要です。別の常駐スケジューラーは必要ありません。

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

sharedの作成先はDesktopの実在project ID・完全一致名とrootsを照合します。managed projectの集合はwork startへ渡した指定文字列で保存するため、名前で起動した場合もsync・wait・guard・controlで同じ文字列を使い、照合で得たIDへ途中で置き換えません。sharedとDesktop Cloudを同じproject集合に入れる場合は同じ調整用IDを使い、各担当の接続はmembershipへ保存します。発注本文をシェルコードとして評価しません。

作成結果の担当IDとreceiptを記録します。`create_not_dispatched`は作成側が未作成・作成RPC未送信・指示未送信・担当IDなしを明示した段階です。原因を直して同じ発注・開始オプションを再実行すると同じattempt_idで作成をやり直せます。部分成功・unknown・観測不能では同じ担当を読み取り照合し、createを繰り返しません。membershipを先に登録してから監督を結び、stoppedを自動で置き換えません。初回観測で省略件数が0と確認できない場合は、sharedとDesktop Cloudの双方でhistory gapとして止まり、cursorを保存しません。完全な初回観測の公開イベント全文は未提示として保存し、次のsyncで返します。

syncは全担当を一巡してからbacklogを読み、動作中・対応が必要・検収待ち・未確認へ分類します。未解決attentionは解消証拠が得られるまで根拠とtokenを再掲します。バックエンドの待機フラグは完全な最新観測で消えたら解消します。質問は後続の人間入力または同じイベントの回答済み状態、失敗は該当turnの状態更新または後続turnの成功を根拠に解消します。空の待機フラグだけでは質問や失敗を消しません。根拠不足の古いattentionは、完全な成功観測後にhistory_notesへ分け、現在の分類を上書きしません。履歴の欠落、429、不完全な取得を変化なしと扱いません。idleで直近turnのcompletedと実行中turnなしを証明でき、未解決attentionがなければ検収待ちです。開始前idleや証明不足は未確認として区別します。旧Cloudの質問・承認状態は未確認なので、completedだけでは検収待ちとしません。再起動・要約後はsyncから再開します。

```sh
codexteer project sync --continue <TOKEN> --offset <NEXT_OFFSET> --event-offset <NEXT_EVENT_OFFSET> --json
codexteer project event <EVENT-TOKEN> --json
```

出力は既定16000 UTF-8 bytes、指定範囲4096〜1048576です。同じ担当内のイベントも分割します。続きは返されたtokenと両offsetを使い、`details_omitted:true`ならeventのtokenまたは担当行のdetail_tokenから詳細を取得します。

### 停止済みの担当を読むのを終える

`project control stop`した担当は、停止を確認した後のsyncでもう一度完全に読みます。実行が終了済みか、idleで実行中のターンがないと確かめられ、承認・質問のフラグが空と分かれば、その回の担当行に通常の観測結果と`settled`（`basis:"observed"`と`settled_at`）を付け、次のsyncからその担当を読みません。以後の行は`observation:"settled"`で、今回読んだ全ての担当の後に並び、最後に読んだときの題名・状態・cursorを示します。cursor・イベント・詳細recordは増えません。`complete`は今回読んだ担当だけで決まり、`membership_count`とmembership digestは全担当のままです。

最後のターンが未回答の質問や失敗で終わった担当も、同じ条件で`settled`になります。停止済みの担当には誰も回答しないため、その質問や失敗は解消しないからです。`settled`にする回の担当行は、その質問・失敗を`attention`と`events`で示します。以後の行も同じ`attention`と根拠のイベントを再掲し、「対応が必要」のまま残ります。未解決attentionは消えません。未解決attentionのない`settled`の行は`events:[]`です。

承認・質問のフラグが立っている担当、ターン実行中の担当、フラグが不明な担当は、停止済みでも読み続けます。フラグの解消とidleを完全な観測で確認した回に`settled`になります。

読めない担当が残り`complete:false`になる通常のsyncは、オーケストレーターが確認した観測ではありません。このsyncでは、waitの基準（最後にwaitが返した観測か完全なsyncで示した観測）から新しいターン終了・質問・バックエンド失敗がなく、未解決attentionも残っていない担当だけを`settled`にします。停止時に実行中だったターンがその後に終わった担当や、基準を作ったときに読めなかった担当は、次のwaitが変化として返し、そのwaitの回に`settled`になります。未解決attentionが残る担当は、次にwaitが返した回か完全なsyncの回に`settled`になります。waitの回と完全なsyncの回は、この確認なしに`settled`にします。waitも完全なsyncも一度も公開していないprojectでは、通常のsyncだけで`settled`になります。

`settled`の担当は読まないため、その後にDesktopから直接ターンを再開しても、syncもwaitも検知しません。stopは検収を終えた担当だけに使ってください。停止済みの担当は、新しい監督IDでも`supervise THREAD`・`supervise register`・同じ発注の`work start`で再び監督できず、`MANAGED_SUPERVISOR_STOPPED`で拒否します。続きの作業は新しい題名か発注の`work start`で別の担当として始めます。

`settled`の行には`detail_token`がありません。予算に収まらない行は次のページの先頭へ送ります。1行だけで予算を超える場合は`details_omitted:true`の短い行を返し、その`settled`は`basis`と`settled_at`だけになります。全体は同じoffsetを大きい`--byte-budget`で読み直します。

### 読めなくなった停止済みの担当を除外する

```sh
codexteer project sync --project sample --exclude-unreadable <THREAD> --reason '履歴が受信上限を超える' --json
```

停止済みなのに読めない担当（履歴が受信上限を超えたDesktop Cloudタスクなど）は、そのままではsyncを不完全にし続けます。理由を付けてこの指定を実行すると、syncはその担当をもう一度読み、結果を`exclude_unreadable.outcome`で返します。

| outcome | 意味 |
| --- | --- |
| `excluded` | 読み取りが失敗したので除外した。行の`settled`は`basis:"excluded"`で、理由とエラーcodeを持つ。以後は読まない。 |
| `unnecessary` | 読めた。通常の規則に従い、条件を満たせば`basis:"observed"`で`settled`になる。 |
| `already_settled` | 既に`settled`だった。読まず、保存済みの理由も変えない。 |
| `not_applied` | 除外しなかった。429など再試行を求める応答、ページ上限、読み取り中の更新、cursorやheadの競合が該当する。`error`のcodeを確認して再実行する。 |

除外した担当の未解決attentionは解消しません。以後のsyncでも「対応が必要」として、今回読んだ担当の後に残ります。除外を取り消す操作はありません。Desktopが起動していないなど接続全体の失敗も読み取り失敗として扱うため、同じエラーが続くことと、他の担当は読めることを確認してから実行してください。

停止していない担当は除外できません（`PROJECT_SYNC_EXCLUDE_NOT_STOPPED`）。読めない担当がまだ作業中なら不完全のまま扱い、原因を調べます。syncを完全にする目的で、検収前の担当をstopしないでください。stopは取り消せず、その担当へは二度と指示を送れません。

tellの可否は対象の担当だけで決まります。最新のsyncで対象が完全に読めていること（`complete:true`、履歴欠落なし）を基点に送信直前まで再照合し、対象の新しいイベント、質問・承認待ち、attention不明、履歴欠落、不完全な観測では拒否します。他の担当が未読・不完全でも、対象への指示は妨げません。receiptの`other_work`は、未読の担当を`incomplete`、質問・承認待ちの担当を`human_attention`、sync後のmembership変更を`membership_changed`で返します。空でなければ、送信後もその担当への対応を続けます。`--sync-token`で以前のsyncを基点にできるのは、その後に対象が完全に再読されていない間だけです。質問・承認待ちは常に最新のsyncで判定します。サーバーが観測版と送信を原子的に照合する保証はなく、最終観測の後に起きる競合は残ります。代理回答はせず、同じ意図やunknownを自動再送しません。検収待ちでもidleなら`--new-turn`が必要です。同じ委任の未完了作業がある場合だけ続け、受付後に新turnがactiveになれば動作中へ戻ります。検収待ちは成果の受入や全体の完了認定ではありません。

controlはproject全体の新しい監督IDを作らず、各担当の既存recordを制御します。`--all`と`--work`はどちらか一方を指定します。返り値のrequested・changed・already・failed、各code、membership_digestを確認してください。部分失敗でも全担当の結果を返し、CLIは終了値1（JSONはok:false）です。busyは未完了、binding不在は失敗、同じ状態への再実行はalreadyです。stop済みはresumeできません。対象集合は呼出し開始時のsnapshotで、新しく追加された担当は含まれません。

pause/stopは新しい外部効果を拒否する制御で、受付済みの担当プロセス自体を終了させません。ユーザーの停止指示では新規作成・追加送信も止め、controlの部分失敗を報告します。停止中でも既存の結果保存・後始末はできます。別IDや低水準操作で制御を迂回しません。

## 待機と停止のガード

```sh
codexteer project wait --project sample --json
codexteer project wait --project sample --timeout-ms 30000 --json
codexteer project guard --project sample
codexteer project guard --project sample --status --json
```

未停止の担当がいる間は、waitを終了通知の届くバックグラウンドタスクとして実行します。単にシェルの`&`で切り離すだけでは親セッションへ通知される保証がありません。返ったら結果を読み、必要な検収・対応の後に再びwaitを開始します。質問・承認・URLをユーザーへ伝えた後も続けます。timeout・接続失敗で終了したwaitは監視中ではありません。検収済みの担当は`project control stop`で終了し、ユーザーがオーケストレーションの終了を求めた場合も対象の制御を明示的にstopします。

waitは担当ごとに、最後にwaitが返した観測か完全なproject syncで示した観測を基準に、新しいターン終了（成功・失敗・取消・中断）、質問、承認待ち、バックエンド失敗、membership変更を待ちます。既にidleの担当や、既に確認した質問・承認待ちだけでは返りません。ユーザーがDesktopで直接次のターンを開始・完了した場合も検知します。通常の進捗だけではcursorや基準を更新しません。`settled`の担当は読まず、`settled`になったことや除外そのものは変化として返しません。sharedは既定1秒、Cloudを含む集合は15秒間隔で照会します。`--timeout-ms`は0以上の整数で、省略時は無期限です。開始済みの観測は完了まで待つため、指定時間を超えて返る場合があります。

返り値の`changed:true`と`sync`に、syncと同じsnapshot・詳細token・continuationを返します。waitが返した時点と完全なsyncの公開時点を基準更新点とし、同じ変化を繰り返し通知しません。更新するのは読めた担当の基準だけで、読めなかった担当は前の基準を保持します。基準が未作成（旧版のsnapshotを含む）なら`reason:initial_sync`として最初のsyncを返します。timeoutは`changed:false, timed_out:true, reason:timeout, sync:null`です。通常のsyncでも全体が不完全なら、waitの基準は進めません。projectごとにwaitは1つで、重複起動は`RECORD_BUSY`です。waitは各照会の前に、開始時に特定した自分のClaude/Codex CLIセッションが生きているかを確かめます。そのセッションが異常終了していれば、照会も公開もせずに`reason:owner_exited, changed:false, timed_out:false, sync:null`で終わり、終了値1になります。照会の途中で終了した場合は、その照会の結果を通常どおり返してから終わります。wait記録とlockも解放するため、再開したセッションはその後に新しいwaitを開始できます。それまでの`RECORD_BUSY`は少し待って再実行してください。セッションを特定できなかったwaitと、プロセスを一時的に調べられなかった照会は、従来どおり待ち続けます。送信や担当制御は行いません。

読めない担当がいても、waitは読めた担当の変化を待ち、`sync.complete:false`のままでも`changed:true`と`work_changed`などで返します。返り値はtimeoutを含めて常に`unreadable:[{thread_id, error, reported}]`を持ち、直近の観測で読めなかった担当とエラーcodeを示します。`reported:true`の担当は、次に読めるまで監視されていません。`reported:false`の担当は直近の照会で失敗しただけで、waitは読み続け、読めない状態が続けば報告します。1回の読み取り失敗では返りません。読み取りの失敗は担当の状態を示さず、次に読めたときにcursor以後の出来事を受け取れるためです。同じ担当が2回以上の照会で続けて読めず、最初の失敗から60秒以上経ったときに、waitはその担当を報告します。他に返す理由がなければ、一度だけ`reason:observation_failed, changed:false, timed_out:false`と不完全なsyncを返し、終了値1になります。同じ照会が他の理由で返る場合は、その結果の`unreadable`で`reported:true`にし、`observation_failed`では返しません。この経過はtimeoutや他の理由で返った後に再開したwaitにも引き継ぎ、途中で一度でも完全に読めれば数え直します。報告した担当は、エラーcodeが変わっても、waitの照会が途中で読めた後に再び失敗しても、再び返しません。その間はsyncの履歴も保存しません。他の理由で返った結果に`reported:false`で載った担当は報告した扱いにせず、最初の失敗から数え続けます。waitの結果か通常の`project sync`がその担当を完全に読めた状態で示した後に、読めない状態がまた続いた場合は、新しい失敗としてもう一度報告します。報告した失敗はwaitだけが記録し直すため、その担当を読めなかった通常の`project sync`を間に実行しても、同じ失敗を再び返しません。waitの公開より先に別のsyncがheadを更新した場合は、何も公開されていないため、読めた変化があっても`reason:observation_failed, changed:false`で返り、終了値1になります。このときの`sync`は`publication_conflict`にエラーcodeを持ち、`reported`は先に公開されたheadの記録を示します。`project sync`も同じ場合に`publication_conflict`を返し、その結果はheadになりません。このwaitは基準を進めていません。先に公開されたsyncが完全なら変化はそのsyncの結果に含まれて基準も更新されているため、waitは同じ変化を再通知しません。不完全なsyncだった場合は、waitを再開すると同じ変化を返します。最新の`project sync`を読んでからwaitを再開してください。completeにする目的でsyncやwaitを繰り返し実行しないでください。他の返り値と同じく結果を読んでwaitを再開します。

`unreadable`は直近の照会の結果です。`reported:false`の担当はその照会で失敗しただけで、一時的な失敗のことがあります。waitはその担当を読み続け、読めない状態が続けば報告します。`reported:true`の担当は、stopしていなくても、次に読めるまで監視されていません。その間のターン終了・質問・承認待ちは、読めるようになるまで返りません。その担当は`codexteer status <THREAD>`やその担当のbranchで別に確認し、読めないことと確認結果をユーザーへ報告します。waitを静かにする目的でその担当をstopしないでください。stopは検収後の終了操作で、stop後に`--exclude-unreadable`で除外した担当の作業は以後どこからも検知されません。読めない担当が検収してstop済みなら`--exclude-unreadable`で除外し、作業中なら原因を調べます。

承認・質問のフラグは、読了済みcursorとは別に、各担当の基準に対応する直近の観測を保存します。同じフラグが立ち続ける間は通知せず、消えたことを観測した後の再出現は同じ実行turnでも通知します。この観測はtimeout後のwait再起動にも引き継ぎ、その担当の基準が更新されたときに初期化します。`attention:null`など現在のフラグが不明な場合は空配列と区別し、`PROJECT_WAIT_ATTENTION_UNKNOWN`の読み取り失敗として扱います。その担当のcursorと基準は進めません。

wait終了後に出力を失った場合、次の`project sync`が返す`wait_sync_token`を`project sync --continue TOKEN`へ渡すと、最新のwait結果を復元できます。最新のwait snapshotとその全文参照は、pruneでも上限到達時の自動削除でも保持します。プロセス終了や出力配送は読了の証明にはならないため、オーケストレーター自身がsnapshotを読み切って検収します。

同じCODEX_HOMEで0.22.0など旧版のsyncを併用すると、旧版がheadの`wait_baseline`など未対応フィールドを保存せず、次のwaitが`initial_sync`を返す場合があります。`settled`、`--exclude-unreadable`の除外、報告済みの失敗も保存されないため、停止済みの担当を読み直し、読めない停止済みの担当は除外し直す必要があります。基準不明を変化なしと扱わず、そのwaitの結果で基準を作り直す動作です。結果を読んでwaitを再開してください。以後は新しい基準で待機しますが、旧syncを再び使うと再初期化が必要になります。基準と復元tokenを維持する運用では、生成した同じ保存済みCLIを一貫して使います。

guardはClaude CodeのStop hook用の生JSONを返します（通常の`ok/data` envelopeは使いません）。停止済み以外の担当がいて自分のセッションに属する生存waitがなければ、終了値0で`{"decision":"block","reason":"…"}`を返します。条件を満たす場合とmanaged workがない場合は`{}`です。pausedは介入を一時停止するだけで未完了であり、Desktopからの実行も止めないため監視対象に数えます。binding不在も未完了として扱います。waitは本人専用のlocal storeへpidと起動識別、最も近いClaude/Codex CLI親プロセスのpidと起動識別を保存し、guardは自分の親プロセスと一致する所有者のwaitだけを数えます。macOSでは起動日時に加えprocess titleのwait固有nonce、Linuxではboot IDと起動tickを照合し、死んだ・停止した・zombieのプロセスを認めません。対応OSはmacOSとLinuxです。

同じCODEX_HOME・host・projectは1オーケストレーターで扱います。結果の基準と排他はproject単位のため、別セッションのwaitが動作中でも自分のguardは停止を拒否し、2つ目のwaitは`RECORD_BUSY`になります。所有セッションでwaitを終了・取消してから、最後の結果とsyncを読み、引継ぎ先のセッションからwaitを再開してください。lockの手動削除、他セッションのwaitの流用、競合解消のための担当のcontrol stopは行いません。別セッションからのsyncや操作も自動的には排除されないため、この単一オーケストレーターの前提を守ってください。

通常のnative Claude/Codex CLIとNode版CLIを親プロセスから識別します。Claudeのnative installerが使う`~/.local/bin/claude`と、symlink先の`~/.local/share/claude/versions/<version>`も扱います（[公式の配置仕様](https://code.claude.com/docs/en/setup#auto-updates)）。共有App Serverは複数のスレッドを持つため、CLIセッションの所有者として認めません。親から切り離されたプロセスや未対応の起動ラッパーなど、自分のセッションを特定できない場合は`PROJECT_GUARD_OWNER_UNVERIFIED`の`systemMessage`で監視未確認を警告し、停止を許します。別セッションのwaitを自分の監視として認めたわけではありません。hookとwaitを同じ対応CLIセッションから実行し、親プロセスの経路を確認してください。自分を識別できた場合は、別セッションや所有者不明のwaitでは引き続き停止を拒否します。プロセス所属は調整用の識別で、ユーザーや同じOSユーザーのプログラムを隔離する仕組みではありません。

macOSの起動識別は、起動日時とcommandのSHA-256だけを保存・比較します。ユーザーの目標を含むpromptやcommand全文は保存しません。wait自身にも同じ形式を使い、process titleのnonceによる区別を維持します。OSから読んだcommandはその場でhashにし、Linuxは従来どおりboot IDと起動tickで識別します。旧形式の識別を持つwaitは新しいguardと一致しないため、所有セッションで旧waitを終了してから、同じ新しいCLIでwaitとhookを実行してください。既存recordや稼働中の保存済みCLIを自動で書き換えません。

開始時には受信したセッションで`project guard --project sample --status --json`を実行します。この形式は通常のenvelopeで`data.stop_hook`を返します。`project sync`と`project wait`のJSONも同じ判定を`data.stop_hook`に付けます。ページ本体の外に付くため、`output_bytes`とbyte予算には含まれません。`configured`は、直接Claude起動が`CODEXTEER_STOP_GUARD`へ付けたproject・launcherのpid・起動識別の印を、現在の親プロセスと照合できた状態です。入れ子のCLIや別のlauncherへ引き継がれた印は認めません。本文の生成だけでは受信側の起動経路を知ることができず、環境変数も設定しません。

印のない手動起動、Codex起動、異なるproject、プロセス検査不能は`unverified`です。最初の報告で「監視漏れを止める仕組みがない（有効なStop hookを確認できない）」ことと、`help project`の設定例を案内してください。手動設定済みならセッションの有効なhook一覧（Claude Codeでは`/hooks`）で同じproject・CLI・接続経路のguardとhook無効化の有無を確認します。ファイルの存在だけで有効と判断しません。`configured`も設定時の印であり、その後の無効化、信頼設定、CLIの継続上限やhook実行そのものまでは保証しません。未完了の間はhookの状態にかかわらず自分のwaitを動かし続けます。

`orchestrate`で起動したClaude Codeセッションは、`claude --resume`ではなく`codexteer orchestrate resume <SESSION-ID> --project sample`で再開します。`--settings`のhookと`CODEXTEER_STOP_GUARD`の印は起動したプロセスに付き、セッションには保存されません。素の`claude --resume`や`claude --continue`で再開したセッションはhookなしで動くため、未完了の担当があってもwaitなしで停止でき、`stop_hook`は`unverified`になります。`orchestrate resume`は`orchestrate`と同じguardを`--settings`へ追加し、同じ印を付けて`claude --resume <SESSION-ID>`を起動します。新しい本文は送りません。`<SESSION-ID>`は`claude --resume`に渡すセッションIDか名前です。`--project`には元の`orchestrate`と同じ指定文字列を使います。違う文字列では印のprojectが一致せず`unverified`のままです。PATH方式で始めた場合は`--use-path-cli`も付けます。`--`以降の引数は`--resume <SESSION-ID>`の後ろでClaudeへ渡します。Claude向けの本文は、`stop_hook`が`unverified`なら最初の報告でも途中でも、このコマンドで再開するよう案内します。

`orchestrate`はClaude Code起動時に、生成した同じCLIコマンド・project・接続経路のguardを`--settings`へ追加します。checkoutの設定ファイルは編集しません。自分で起動したClaude Codeでは`.claude/settings.json`の既存設定へ次を追加してください。`sample`はwork startと同じ調整用project IDへ、commandは同じCODEX_HOME・接続・hostを選ぶ保存済みコマンドまたはPATHコマンドへ置き換えます。

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "codexteer project guard --project sample",
        "timeout": 10
      }]
    }]
  }
}
```

[Claude CodeのStop hook仕様](https://code.claude.com/docs/en/hooks#stop)に従い、`stop_hook_active`でも条件を再確認します。無条件の再停止許可は監視の欠落を通すため行いません。拒否理由のwait開始またはcontrol stopで解消できます。guardは接続やsyncを実行せず、syncの失敗によって判定を待ち続けません。local storeの破損・権限不足やプロセス検査不能の場合は`systemMessage`で警告して停止を許します。状態を修復しwaitを再開するまで監視は保証されません。Claude Codeには連続したhook継続の上限があり、ユーザー中断、hookの無効化、親セッションの終了も阻止できません。生存確認から停止までの間にwaitが終了する競合も残るため、バックグラウンドタスクの終了通知が必要です。

[CodexにもStop hookがあります](https://learn.chatgpt.com/docs/hooks#stop)。同じ`decision:block`と`reason`を受け付けます。Codexで手動設定する場合は上記JSONを`.codex/hooks.json`へ置き、hookを有効・信頼済みにします。CLIのhook無効化や他hookの`continue:false`が優先される場合は継続を強制できず、バックグラウンドhookの終了自体も新しいユーザーターンを開始しません。`orchestrate --agent codex`への自動設定注入は行いません。Codexのconfig layerと信頼確認に従う明示設定を使います。guardが保証するのは停止時点のwait生存条件であり、受信通知・読了・検収の完了そのものではありません。

## 本文生成と互換操作

`orchestrate prompt --project sample '目標' --json`で起動せず本文を取得できます。保存方式は同じCLI・Node・CODEX_HOMEを固定し、PATH方式は`--use-path-cli`です。`cloud_command`はDesktop Cloud用で、paired hostではnullです。paired hostのwork startは未対応のため、本文はそこで新規作成を指示しません。

単一スレッドの`supervise`と既存の低水準操作は互換用に残します。managed threadへの低水準`send`は監督IDがあっても拒否し、`work tell`を使います。入口は`help details`です。詳細な配送照合・checkpoint・resourceの契約は各topicを参照してください。

## 検収

受付、担当の完了報告、検収、統合済みを区別します。目的、確定要件、最終差分、検証の全件結果、成果物の実在を確認し、統合後も検証します。外観や操作が目的なら実物も確認します。テスト成功や他モデルの賛同だけで完了とせず、残件と未確認を報告し、完了時は対象をproject control stopで制御します。

## 保存量と整理

`CODEX_HOME`のhost namespaceごとに、`project-sync-events`・`project-sync-results`・`work-starts`のJSONファイル総量を256 MiBまでに制限します。work-startのreceipt・方針本文も含みます。最新headなど他の管理メタデータ、ジャーナルやバックエンド履歴はこの上限の対象外です。表示byte予算とは別の制限です。1担当1回の全文観測は16 MiBまでで、超過は`PROJECT_HISTORY_BATCH_LIMIT`としてcursorを進めません。

保存の前に、今回書くrecord（イベント・sync結果・担当詳細）の保存後のサイズを合計し、置き換えるrecordの分を引いて、上限に収まるかを確認します。recordが空きに収まるpublicationは保存されます。sync結果と担当詳細はcursorの更新後に確定するため、完全に読めた担当の行は、cursorを進めた場合と更新が拒否された場合の大きい方で数えます。確認する量は実際に保存する量と同じか、その差の分だけ大きくなります。確認を通ったpublicationが途中で容量不足になることはありません。

収まらない場合は、そのprojectの古い履歴を`project prune`と同じ基準で自動的に削除し、もう一度だけ確認します。保持する対象も`project prune`と同じです。自動削除をしたsyncとwaitの結果は、ページ本体の外に`history_pruned`を持ちます。`deleted`（`events`・`results`・`initial_payloads`の件数）と`reclaimed_bytes`で、`output_bytes`とbyte予算には含まれません。公開競合（`publication_conflict`）で返った結果にも付きます。`work start`の保存も同じ確認と自動削除を行い、削除した場合は結果に`history_pruned`が付きます。自動削除の後、その時点の最新syncと最新のwait結果より古い結果のcontinuation tokenとevent tokenは使えません。

それでも収まらなければ`PROJECT_HISTORY_LIMIT`で拒否し、何も保存せずcursorも進めません。これが起きるのは次の場合です。

- 1回のpublicationが、自動削除の後に残る空きより大きい。
- 同じ`CODEX_HOME`のhost namespaceにある他projectの履歴や、保護対象が上限を占めている。他projectの履歴は、そのprojectの`project prune`で整理します。

エラーはstorage_bytes（自動削除後の使用量）・required_bytes（今回必要な量）・limit_bytes（上限）と、行った自動削除の`history_pruned`を返します。`--json`のerrorとtext出力の両方に表示します。上限を満たさない全文を黙って切ることはありません。初回観測や作成段階の保存が失敗しても、同じ担当を自動で作り直しません。

```sh
codexteer project prune --project sample --json
```

整理は明示したprojectの古いsync結果・担当詳細・イベントを削除し、最新syncと最新のwait結果、それらの参照先、未解決attentionの根拠、未提示の初回結果を保持します。途中で中断したpublicationの世代も保持します。`settled`の担当の行はheadが持つため、その担当の古いイベントと詳細を削除した後も結果に残ります。提示済み初回結果は最新syncとの対応を確認してwork-startの重複全文だけを削除し、作成receiptと再送防止情報は残します。他projectの履歴は削除しません。

期限による失効や常駐GCはありません。履歴は、整理を実行するか、保存が上限に達して自動削除が行われるまで残ります。削除したtokenはeventなら`PROJECT_EVENT_NOT_FOUND`、continuationなら`PROJECT_SYNC_CONTINUATION_NOT_FOUND`になります。古いtokenが必要なら、次のsync・waitより前に取得してください。保護対象だけで上限に達した場合は整理で解放できず、新しい保存は拒否されます。整理結果のdeleted・reclaimed_bytes・storage_bytesとprotected_sync_tokenで確認できます。保存・整理の競合は`RECORD_BUSY`として拒否します。
