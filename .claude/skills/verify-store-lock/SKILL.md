---
name: verify-store-lock
description: Model-check the local withStoreLock/withRecordLock protocol, including recursively recovering crashed recovery owners. Run before and after changing the covered functions or their exclusivity contract.
---

# Verify the store lock

`withStoreLock(key, fn)` serializes supervision pause/stop vs send, finding interventions, checkpoint, thread repair, and other local record writers. Public signatures and caller behavior are unchanged.

## Protocol and upgrade boundary

The primary lock is still a hard link of a private, fully written `{pid, token}` file to `locks/<key>.json`. A dead holder is recovered while holding a second lock in `lock-recovery/`, keyed by `SHA256(old.token)`. That second lock uses **the same helper**, including PID checks and recovery. Every level atomically publishes its owner via `link`; there is no ownerless mkdir/write interval. A recovery owner that crashes is recovered through its own generation's lock. The primary token and PID are rechecked under the recovery lock before unlinking.

**Old `.recover` directories are unsupported and inert.** They have no PID; a live old recoverer and a dead one are indistinguishable. The new code neither reads nor removes them. **Before using the new version with a CODEX_HOME, end every old-version operation sharing it, including supervisors still running saved CLI copies.** Mixed old/new recovery protocols cannot guarantee exclusion: an old recoverer does not participate in the new recovery locks. This is an upgrade precondition, not a claim of backward protocol compatibility. Old dead-holder records and abandoned legacy directories do not block new callers.

## Properties

- **P1 MutualExclusion:** no two live calls own the same lock target concurrently. Includes recovery locks and the release interval, beyond just root `fn()`.
- **P2 HolderOwnsFile:** every live holder still owns its target throughout its critical section and release read/unlink interval. Includes recovery callbacks.
- **P3 NotWedged:** `AllWorkersGone ~> success[Probe]`. Once all earlier callers exit or crash, a fresh non-crashing caller must acquire the primary lock and complete a no-op `fn()`. This is a temporal property, not the old invariant prohibiting any dead recovery artifact.

## Run

```sh
.claude/skills/verify-store-lock/scripts/check.sh
.claude/skills/verify-store-lock/scripts/check.sh --trace
# Optionally retain complete TLC output per configuration:
STORE_LOCK_LOG_DIR=/tmp/store-lock-tlc .claude/skills/verify-store-lock/scripts/check.sh
```

Requires Java 11+ (verified with Java 17) and the **TLA+ v1.7.4 release asset** at `~/.cache/tlaplus/v1.7.4/tla2tools.jar`, SHA256 pinned in `check.sh`. Its actual CLI banner is `TLC2 Version 2.19 of 08 August 2024`; the release tag and banner are different version labels. `TLA2TOOLS_JAR` can override the path, not the checksum.

The expanded model takes several minutes on this machine (rather than the old approximately 10 seconds). `check.sh` limits each run to 4 workers and 3 GiB heap. TLC opens a local RMI listener; environments prohibiting local sockets must run it with appropriate local execution permissions. It does not contact Codex Desktop or the network.

Exit 0 / `RESULT: as expected` requires all of:

1. Covered source fingerprints match `coverage.json`.
2. `StoreLock.cfg`: P1/P2/TypeOK pass, **4 concurrent processes, up to 3 crashes, 2 attempts per helper invocation**.
3. Three safety mutations fail P1/P2: no generation recovery lock, no recovery rechecks, or no initial dead-holder check. Keeping either one of the two rechecks passes.
4. `mutants/legacy-protocol.cfg`: the **same temporal P3** fails for the `7239ce8` protocol. This is the control showing that changing P3 did not conceal F1.
5. `mutants/no-recursive-recovery.cfg`: disabling recovery of recovery owners fails P3. This is the mutation testing the new safeguard.
6. `Recoverability.cfg`: P3 (and P1/P2/TypeOK) pass for the fixed protocol.

**P3 bounds and fairness:** 3 ordinary callers plus 1 distinguished fresh caller, up to 3 crashes among the ordinary callers, arbitrary interleavings of their steps starting from an empty store. The fresh caller waits until all 3 ordinary callers are dead (including normal process exit), then makes **one call**, with the actual **2-attempt loop in every recursive frame**. It cannot crash. `WF_vars(Step(p))` for each process excludes starving an enabled process forever, including normal exit. Filesystem awaits and the probe's no-op callback eventually return. P3 is not an assertion that the system recovers during endless crashes or live contention. No symmetry reduction is used for temporal runs; safety runs use process permutations. `TypeOK` checks the recursion-depth bound; it is an invariant, never a state constraint that prunes deeper executions.

## Source-to-model correspondence

The source snapshot is `coverage.json.sync_commit` (the product-code commit; a following verification-only commit may contain this skill). Fingerprints cover the public wrapper, recursive helper, `readRecord`, `directory`, `owned`, and `isAlive`. `fingerprint.mjs` supports non-exported helpers so the wrapper alone cannot hide a drift.

| Source at sync commit | Model action / refinement |
| --- | --- |
| store:53-54 `return withRecordLock` | initial root frame; no shared I/O |
| store:58 `await directory(..., true)` | `Dir`; internal mkdir/lstat awaits stutter on the lock variables |
| store:60 `await writeFile(temp)` | `Temp`; private, fully written before any link |
| store:65 `await link(temp,file)` | `Link`; one atomic no-overwrite publication |
| store:66 `await readRecord` | `ReadDir`, `ReadStat`, `Read` for the old record |
| store:67 dead PID check | `CheckOld` |
| store:74 generation hash | represented by the observed record's unique token |
| store:75 `await withRecordLock` | `Call` pushes a complete helper frame; `Return` resumes the parent |
| store:76 `await readRecord` inside the callback | `ReadDir`, `ReadStat`, `Read`, using the suspended parent's target |
| store:77 token/PID check; `await rm(file)` | `CheckCur`, then **separate** `RmFile` |
| store:82 `await fn()` | root `CS`; a recovery frame executes its parent's callback actions instead |
| store:86 release `await readRecord`; `await rm(file)` | `ReadDir`, `ReadStat`, `Read`, then **separate** `RelRm` |
| store:87 `await rm(temp)` | `Clean`, then `Return` |
| runtime:40-47 `isAlive` | valid live PIDs never read dead; dead PIDs read dead; inspection denial is not modeled |
| original store:65 mkdir and :69 finally rm `.recover` (7239ce8) | `LegacyMkdir`, `LegacyRm` when `LegacyRecovery=TRUE` |

**Await granularity and stuttering:** each shared lock `link`, `lstat`, `readFile`, `rm` is its own transition. In particular `readRecord` is **not atomic**: a successful `lstat` may be followed by a different record or ENOENT on `readFile`. Its directory helper awaits are noninterfering stuttering steps: ancestors/buckets are created with safe permissions and never removed by the protocol. The helper's internal mkdir/lstat awaits, async return resumptions, and private temp I/O can each map to one stuttering transition allowed by `[Next]_vars`. `Dir`/`ReadDir`/`Temp`/`Clean` retain their program-order boundaries; no shared file mutation is merged across them. Omitting counts of such stutters adds scheduling freedom, not an atomic read-delete operation. Liveness assumes those awaits terminate. A crash is allowed at every modeled program counter, including immediately after publication or deletion and before cleanup.

Tokens are unique per invocation (`<<process, serial>>`), including nested calls and second-attempt recovery calls. They are not merely PID or recursion depth. The abstract recovery key is the dead record's token; the concrete key hashes only that token. With globally unique tokens and collision-free hashes, this is an injective renaming. Including a raw home/file path would let symlink aliases split the guard for the same physical lock; the code deliberately avoids that. Token hashes keep names bounded and recovery files separate from public primary keys. A call owns at most one actual lock while recursive acquisition is pending; a suspended parent frame has not acquired its target.

## Design reasoning and alternatives

| Approach | Assessment for F1 |
| --- | --- |
| Delete `.recover` by age / lease timeout | A paused but live owner can outlive any timeout. Does not meet the required exclusion without changing `fn()` and every resource to honor fencing tokens. |
| Write PID/token inside the mkdir directory | A crash between mkdir and the owner write recreates an ownerless guard; reclaiming it also needs safe serialization. |
| Atomically publish a PID/token guard, then read/check/unlink that guard | Fixes the publication gap, but concurrent stale reclaimers can unlink a replacement after a delayed check (ABA). Moves F1 one level deeper. |
| Rename/steal the checked path | Rename is atomic but is not a compare-and-swap on the token checked earlier. A delayed renamer can move a new live holder. An additional ownership protocol is still necessary. |
| Kernel advisory lock / native binding | A valid alternative for a broader replacement; adds platform/runtime/dependency and process-lifetime integration work beyond this bounded repair. |
| **Generation-scoped recursive recovery (chosen)** | Reuses the existing hard-link acquire/recheck/release protocol at every recovery level, with owner metadata published atomically. No timeout, new package, or caller changes. Recursion only occurs through observed dead generations. |

Primary references: Apple's [link(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/link.2.html) specifies atomic directory-entry creation and EEXIST; [rename(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/rename.2.html) describes replacement of an existing destination, not token comparison; [flock(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html) specifies cooperating advisory holders. The race assessments above are deductions from those operations and the actual code. [Lamport's bakery paper](https://lamport.azurewebsites.net/pubs/bakery.pdf) also separates mutual exclusion from progress and explicitly discusses continuing failures; a bakery rewrite is unnecessary here.

**Why recovery terminates after finitely many deaths:** a recovery edge points to a token already published by a process known to be dead. That process cannot create a newer edge. Along an unresolved chain, each crashed owner contributes a distinct dead generation; with finitely many leftover files the chain reaches an absent recovery target. A solo fresh caller takes that target, rechecks/removes its parent's stale file, releases, and works back outward. With no new competitor or crash, each level then succeeds on its second attempt. This is an argument beyond the finite TLC bounds, conditional on the assumptions below, not an unbounded machine-checked proof.

## F1: resolved within the new protocol

Original trace: A holds the primary lock and dies; B mkdirs `.recover` and dies before deleting A's file; each new caller gets EEXIST on mkdir and returns RECORD_BUSY. The legacy protocol control still produces this trace under temporal P3.

Fixed trace: A dies holding the primary lock; B takes `R(A.token)` and dies; C takes `R(B.token)`, rechecks/removes B's recovery lock, releases `R(B.token)`, acquires `R(A.token)`, removes A's primary lock, releases recovery, and acquires the primary lock. More dead recovery generations repeat the same helper. A live B makes C return RECORD_BUSY without entering the root callback.

Regression tests in `test/store-lock.test.mjs` use temporary homes and real child processes. They cover the supplied legacy F1 state, a live holder, a live recovery holder followed by SIGKILL, three successive recovery-owner deaths, concurrent callers after those deaths, and a symlink alias of CODEX_HOME. No test hooks are added to product code.

## Reading failures and maintaining coverage

Run `check.sh --trace` or retain raw logs. Map each counterexample's `stack[p]` top frame PC to the table above; `files` contains the actual lock targets, `alive` the PID observations, and `legacyOwner` only the old mkdir guard. See `VERIFICATION.md` for the reviewed traces and full summary output. The workflow is self-contained and does not require the unavailable external `/pstack:statechart` skill previously named here.

- On DRIFT, diff the source against `sync_commit`, mirror every shared await and relevant check, rerun, then update fingerprints and the source commit reference.
- A safety mutant must violate P1/P2; parser errors, TypeOK violations, tool failures, or killed runs do not count as successful negative controls.
- A P3 mutant/control must violate the same temporal NotWedged property. Never replace it with a test for stale artifacts.
- Never update fingerprints just to suppress drift. Keep code-line comments and this table current.

Corrections to the previous skill/code mismatch: the previous model treated `readRecord` as one atomic await although its implementation performs separate filesystem awaits; it now exposes lstat/readFile races. The old P3 invariant described a permanently blocking artifact of the old protocol, whereas a dead recovery record is transient under the new one; temporal P3 now tests actual recovery and still rejects the original protocol. The previous wording that `isAlive` returns false *only* for ESRCH omitted its explicit invalid/nonpositive-PID case; the model assumes valid published PIDs.

## Assumptions and limits

- Local filesystem hard-link and unlink operations are atomic, records are published whole, and no power-loss/fsync durability guarantee is claimed. Remote/NFS filesystems are outside scope.
- All callers for a key use this protocol, the same namespace and physical home. Old-version CLI copies must be stopped first. External writes, arbitrary manually forged records, directory replacement, symlinks in managed store directories/files, permission changes, and corruption are excluded.
- PIDs are not reused while stale records remain. Reuse can make a dead owner appear alive and postpone recovery indefinitely; this existing limitation is not fixed. `isAlive` throws on inspection denial; EPERM is not proof of death.
- UUIDs are unique and SHA256 recovery keys do not collide. They are generation identifiers, not fencing tokens for resources outside this local critical section.
- Non-ENOENT filesystem errors are excluded. A release read/unlink error can keep a live PID's lock until it exits; the existing `state_cleanup_required` behavior is preserved. Disk exhaustion and an unbounded number of stale files can exhaust resources.
- `fn()` business semantics are outside the model. P1/P2 protect its execution; P3 uses a terminating no-op callback and no new crashes after the probe starts.
- Finite checking is not an unbounded proof or a live-contention fairness guarantee. Bounds are stated above. Legacy directories and crash-left private `.tmp` files are not garbage-collected by this repair.
