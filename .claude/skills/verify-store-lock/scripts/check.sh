#!/usr/bin/env bash
# Model-check withRecordLock/withStoreLock. See ../SKILL.md.
# check.sh --trace also prints counterexamples. Expected failures must name
# a safety invariant or violate the SAME temporal NotWedged property.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
TLA_VERSION=v1.7.4
JAR="${TLA2TOOLS_JAR:-$HOME/.cache/tlaplus/$TLA_VERSION/tla2tools.jar}"
JAR_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
TRACE=0; [ "${1:-}" = "--trace" ] && TRACE=1
fail=0
if [ ! -f "$JAR" ]; then echo "MISSING TOOL: $JAR"; exit 2; fi
actual=$(shasum -a 256 "$JAR" | cut -d' ' -f1)
[ "$actual" = "$JAR_SHA256" ] || { echo "TOOL MISMATCH: $JAR sha256 $actual, expected $JAR_SHA256"; exit 2; }
command -v java >/dev/null || { echo "MISSING TOOL: java (JDK 11+)"; exit 2; }

drift=$(node -e '
  const cov = require(process.argv[1]); const now = JSON.parse(process.argv[2]);
  for (const [k, v] of Object.entries(now)) if (cov.fingerprints[k] !== v) console.log(k);
  for (const k of Object.keys(cov.fingerprints)) if (!(k in now)) console.log(k);
' "$HERE/coverage.json" "$(node "$HERE/scripts/fingerprint.mjs")")
if [ -n "$drift" ]; then
  echo "DRIFT: covered code changed since sync commit $(node -p "require('$HERE/coverage.json').sync_commit"):"
  echo "$drift" | sed 's/^/  /'
  echo "  -> mirror code changes into StoreLock.tla before updating coverage.json."
  fail=1
fi

run() { # cfg expected(pass|safety-fail|temporal-fail) label
  local meta out verdict status states
  meta=$(mktemp -d /private/tmp/tlc-store-lock-XXXX)
  out=$(cd "$HERE/model" && java -Xmx3g -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers 4 -metadir "$meta" -config "$1" StoreLock.tla 2>&1)
  status=$?
  rm -rf "$meta"
  # With pipefail, echo | grep -q can report SIGPIPE for a long valid trace.
  if [ $status = 0 ] && grep -q 'No error has been found' <<< "$out"; then verdict=pass
  elif [ $status != 0 ] && grep -Eq 'Invariant (MutualExclusion|HolderOwnsFile) is violated' <<< "$out"; then verdict=safety-fail
  elif [ $status != 0 ] && grep -q 'Temporal properties were violated' <<< "$out"; then verdict=temporal-fail
  else verdict=ERROR; fi
  if [ -n "${STORE_LOCK_LOG_DIR:-}" ]; then
    mkdir -p "$STORE_LOCK_LOG_DIR"
    echo "$out" > "$STORE_LOCK_LOG_DIR/$(basename "$1" .cfg).log"
  fi
  states=$(echo "$out" | grep -o '[0-9]* distinct states found' | tail -1)
  if [ "$verdict" = "$2" ]; then echo "ok   $3: $verdict, $states"
  else echo "BAD  $3: got $verdict (exit $status), expected $2"; fail=1; echo "$out"; fi
  if [ $TRACE = 1 ] && [ "$verdict" != pass ] && [ "$verdict" = "$2" ]; then echo "$out"; fi
}

echo '== safety of the real code (P1/P2; 4 processes, up to 3 crashes; 2 attempts/frame)'
run StoreLock.cfg pass 'real code'
echo '== removing safety guards must violate P1/P2'
run mutants/no-recovery-guard.cfg safety-fail 'without generation recovery lock'
run mutants/no-rechecks.cfg safety-fail 'without both recovery re-checks'
run mutants/steal-live-holder.cfg safety-fail 'without initial death check'
echo '== either recovery re-check alone suffices'
run mutants/token-recheck-only.cfg pass 'token re-check only'
run mutants/alive-recheck-only.cfg pass 'liveness re-check only'
echo '== P3: 3 prior callers + 1 fresh caller; up to 3 crashes; 1 fresh call; 2 attempts/frame; weak fairness'
run mutants/legacy-protocol.cfg temporal-fail '7239ce8 protocol, same NotWedged (F1)'
run mutants/no-recursive-recovery.cfg temporal-fail 'without recursive recovery of recovery owners'
run Recoverability.cfg pass 'NotWedged (fixed protocol)'
[ $fail = 0 ] && echo 'RESULT: as expected' || echo 'RESULT: UNEXPECTED (see BAD/DRIFT lines)'
exit $fail
