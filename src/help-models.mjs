export const topics = {
  models: {
    title: "Cloud の既定モデルとエフォートを選ぶ",
    when: "Desktop Cloud の新しい担当に使うモデルとエフォートを一覧・選択・保存するとき。",
    usage: ["--connection desktop-cloud models select", "--connection desktop-cloud models list", "--connection desktop-cloud models show",
      "--connection desktop-cloud models set --model MODEL --thinking EFFORT", "--connection desktop-cloud models reset"],
    options: [
      { name: "--model MODEL", text: "models list が現在返すモデル ID。set では必須。" },
      { name: "--thinking EFFORT", text: "そのモデルで選択可能なエフォート。set では必須。" },
    ],
    returns: "list は現在の models（model/name/efforts/default_thinking/is_default）と saved。show は保存値。set は保存した model/thinking と settings_path。select は端末で番号を選び、保存した組合せを表示する。",
    examples: ["codexteer --connection desktop-cloud models select", "codexteer --connection desktop-cloud models list --json",
      "codexteer --connection desktop-cloud models show --json", "codexteer --connection desktop-cloud models set --model <MODEL> --thinking <EFFORT> --json"],
    notes: [
      "select（models だけでも同じ）は対話端末専用。Enter は表示された現在値、q・Ctrl-C・EOF は中止。中止時は設定を変えず、短い案内を表示して正常終了する。select に --json は付けない。",
      "CODEX_HOME/codex-steer/settings/desktop-cloud-model.json に保存する。保存完了後の新しい work start/thread create が直ちに読み取る。再起動不要。",
      "作成引数 → 保存値 → Cloud の既定値の順。モデルだけ上書きした場合、保存モデルと異なればそのモデルの既定エフォートを使う。",
      "初回ターンには model/effort を明示する。既存スレッド、通常の送信・継続、作成開始済みの同じ発注の再実行には新しい保存値を適用しない。",
      "list/select/set と作成時は現在の Cloud カタログを読み、非表示モデルを除外する。未対応の組合せでは保存・作成しない。reset は保存値を解除する。",
      "この設定は Desktop Cloud 専用。同じ CODEX_HOME を使う対応版 codexteer の間で共有する。古い保存済み CLI はこの設定を読まない。",
    ],
    errors: [
      { code: "DESKTOP_CLOUD_MODEL_INVALID", when: "選択モデルまたはエフォートが不正・現在利用不可。", action: "models list/select で現在の組合せを選ぶ。set では --model と --thinking を両方指定する。" },
      { code: "DESKTOP_CLOUD_MODELS_UNVERIFIED", when: "Cloud のモデル一覧が不完全・矛盾・取得不可。", action: "一覧を確認し、カタログ取得が正常になるまで作成しない。" },
      { code: "DESKTOP_CLOUD_MODEL_SETTINGS_INVALID", when: "保存設定が破損・未対応形式。", action: "models set で両方を保存し直すか、models reset で解除する。" },
      { code: "DESKTOP_CLOUD_MODEL_TTY_REQUIRED", when: "select を対話端末以外から実行した。", action: "models list --json と models set --model MODEL --thinking EFFORT --json を使う。" },
      { code: "DESKTOP_CLOUD_MODEL_CANCELLED", when: "選択を中止した。", action: "保存値は変更されていない。必要なら models select をやり直す。" },
    ],
    see: ["desktop-cloud", "work", "thread"],
  },
};
