---------------------------- MODULE StoreLock ----------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

(***************************************************************************
 withRecordLock, src/store.mjs:57-90. Shared awaits are separate actions;
 no read/check/unlink or recursive invocation is made atomic. readRecord is
 expanded into directory checks, owned(file)'s lstat, then readFile.
 Directory checks and private temp I/O commute with all lock operations:
 Dir/ReadDir represent their stuttering steps (see refinement in SKILL.md).
 Each stack frame has a distinct token <<process, invocation number>>.
 Recovery target H(old.token) is represented by old.tok: UUID tokens and
 SHA256 keys are assumed collision-free; home path aliases share a guard.
 Legacy .recover directories are inert under the new protocol.
 ***************************************************************************)
CONSTANTS Procs, MaxCrashes, Attempts, Probe,
          GuardRecovery, RecheckToken, RecheckAlive, CheckOldDead,
          RecursiveRecovery, LegacyRecovery
None == [pid |-> "none", tok |-> <<"none",0>>]
Root == <<"root",0>>
Frame(p,n,t) == [target |-> t, token |-> <<p,n>>, pc |-> "dir", attempt |-> 0,
                 old |-> None, cur |-> None, acquired |-> FALSE, result |-> "ok"]
VARIABLES files, stack, serial, alive, crashes, success, legacyOwner
vars == <<files,stack,serial,alive,crashes,success,legacyOwner>>
D(p) == Len(stack[p])
Top(p) == stack[p][D(p)]
At(t) == IF \E f \in files : f.at=t
         THEN (CHOOSE f \in files : f.at=t).value ELSE None
Without(t) == {f \in files : f.at # t}
AllWorkersGone == \A p \in Procs \ {Probe} : ~alive[p]
Terminal(p) == Top(p).pc="done"
SetTop(p,f) == stack'=[stack EXCEPT ![p][D(p)]=f]
Goto(p,l) == SetTop(p,[Top(p) EXCEPT !.pc=l])
Finish(p,r) == SetTop(p,[Top(p) EXCEPT !.pc="clean", !.result=r])
NextAttempt(p) == IF Top(p).attempt+1 < Attempts
  THEN SetTop(p,[Top(p) EXCEPT !.attempt=@+1, !.pc="link"])
  ELSE Finish(p,"busy")
CallbackTarget(p) == IF Top(p).acquired THEN stack[p][D(p)-1].target ELSE Top(p).target
CallbackOld(p) == IF Top(p).acquired THEN stack[p][D(p)-1].old ELSE Top(p).old
CallbackDone(p) == IF LegacyRecovery THEN Goto(p,"legacyRm")
                   ELSE IF Top(p).acquired THEN Goto(p,"relDir") ELSE NextAttempt(p)

Init ==
  /\ files={} /\ legacyOwner="none"
  /\ stack=[p \in Procs |-> <<[Frame(p,0,Root) EXCEPT !.pc=IF p=Probe THEN "wait" ELSE "dir"]>>]
  /\ serial=[p \in Procs |-> 0] /\ alive=[p \in Procs |-> TRUE]
  /\ success=[p \in Procs |-> FALSE] /\ crashes=0
Wait(p) == Top(p).pc="wait" /\ AllWorkersGone /\ Goto(p,"dir")
  /\ UNCHANGED <<files,serial,alive,crashes,success,legacyOwner>>
\* L58 await directory; L60 await writeFile(temp): immutable/private paths.
Dir(p) == Top(p).pc="dir" /\ Goto(p,"temp")
  /\ UNCHANGED <<files,serial,alive,crashes,success,legacyOwner>>
Temp(p) == Top(p).pc="temp" /\ Goto(p,"link")
  /\ UNCHANGED <<files,serial,alive,crashes,success,legacyOwner>>
\* L65 await link(temp,file), EEXIST -> readRecord.
Link(p) == Top(p).pc="link"
  /\ (IF At(Top(p).target)=None
     THEN /\ files'=files \cup {[at |-> Top(p).target,value |-> [pid |-> p,tok |-> Top(p).token]]}
          /\ SetTop(p,[Top(p) EXCEPT !.acquired=TRUE, !.pc=IF D(p)=1 THEN "cs" ELSE "curDir"])
     ELSE /\ UNCHANGED files /\ Goto(p,"oldDir"))
  /\ UNCHANGED <<serial,alive,crashes,success,legacyOwner>>
\* L66/L76/L86 -> readRecord L32: immutable directory checks.
ReadDir(p) == Top(p).pc \in {"oldDir","curDir","relDir"}
  /\ Goto(p,CASE Top(p).pc="oldDir" -> "oldStat" [] Top(p).pc="curDir" -> "curStat" [] OTHER -> "relStat")
  /\ UNCHANGED <<files,serial,alive,crashes,success,legacyOwner>>
\* readRecord L33 -> owned L16: lstat. ENOENT returns null immediately.
ReadStat(p) == Top(p).pc \in {"oldStat","curStat","relStat"}
  /\ (LET kind==Top(p).pc
         target==IF kind="curStat" THEN CallbackTarget(p) ELSE Top(p).target
     IN IF At(target) # None
        THEN Goto(p,CASE kind="oldStat" -> "oldRead" [] kind="curStat" -> "curRead" [] OTHER -> "relRead")
        ELSE CASE kind="oldStat" -> SetTop(p,[Top(p) EXCEPT !.old=None, !.pc="checkOld"])
               [] kind="curStat" -> SetTop(p,[Top(p) EXCEPT !.cur=None, !.pc="checkCur"])
               [] OTHER -> Goto(p,"clean"))
  /\ UNCHANGED <<files,serial,alive,crashes,success,legacyOwner>>
\* readRecord L34 await readFile: only HERE are contents snapshotted.
Read(p) == Top(p).pc \in {"oldRead","curRead","relRead"}
  /\ (CASE Top(p).pc="oldRead" -> SetTop(p,[Top(p) EXCEPT !.old=At(Top(p).target), !.pc="checkOld"])
       [] Top(p).pc="curRead" -> SetTop(p,[Top(p) EXCEPT !.cur=At(CallbackTarget(p)), !.pc="checkCur"])
       [] OTHER -> Goto(p,IF At(Top(p).target).tok=Top(p).token THEN "relRm" ELSE "clean"))
  /\ UNCHANGED <<files,serial,alive,crashes,success,legacyOwner>>
\* L67 synchronous death check, also for nested recovery locks.
CheckOld(p) == Top(p).pc="checkOld"
  /\ (IF Top(p).old # None /\ (~CheckOldDead \/ ~alive[Top(p).old.pid]) /\ (RecursiveRecovery \/ D(p)=1)
     THEN Goto(p,IF ~GuardRecovery THEN "curDir" ELSE IF LegacyRecovery THEN "legacyMkdir" ELSE "call") ELSE Finish(p,"busy"))
  /\ UNCHANGED <<files,serial,alive,crashes,success,legacyOwner>>
\* L75 await withRecordLock: push the helper; NOT an atomic acquisition.
Call(p) == Top(p).pc="call"
  /\ serial'=[serial EXCEPT ![p]=@+1]
  /\ stack'=[stack EXCEPT ![p]=Append(@,Frame(p,serial[p]+1,Top(p).old.tok))]
  /\ UNCHANGED <<files,alive,crashes,success,legacyOwner>>
\* L77 synchronous rechecks, separate from rm(file).
CheckCur(p) == Top(p).pc="checkCur"
  /\ (IF Top(p).cur # None /\ (~RecheckToken \/ Top(p).cur.tok=CallbackOld(p).tok)
        /\ (~RecheckAlive \/ ~alive[Top(p).cur.pid])
     THEN Goto(p,"rmFile") ELSE CallbackDone(p))
  /\ UNCHANGED <<files,serial,alive,crashes,success,legacyOwner>>
\* L77 await rm(file): removes the path's CURRENT occupant. ENOENT throws;
\* the acquired recovery frame still runs finally before propagation.
RmFile(p) == Top(p).pc="rmFile"
  /\ files'=Without(CallbackTarget(p))
  /\ (IF At(CallbackTarget(p))=None
     THEN IF Top(p).acquired THEN SetTop(p,[Top(p) EXCEPT !.result="error", !.pc="relDir"])
          ELSE IF LegacyRecovery THEN SetTop(p,[Top(p) EXCEPT !.result="error", !.pc="legacyRm"])
          ELSE Finish(p,"error")
     ELSE CallbackDone(p))
  /\ UNCHANGED <<serial,alive,crashes,success,legacyOwner>>
\* L82 await fn() at root; crashes possible before this or any other step.
CS(p) == Top(p).pc="cs" /\ Goto(p,"relDir") /\ success'=[success EXCEPT ![p]=TRUE]
  /\ UNCHANGED <<files,serial,alive,crashes,legacyOwner>>
\* L86 await rm(file), after independent release read; errors caught.
RelRm(p) == Top(p).pc="relRm" /\ files'=Without(Top(p).target)
  /\ SetTop(p,[Top(p) EXCEPT !.acquired=FALSE, !.pc="clean"])
  /\ UNCHANGED <<serial,alive,crashes,success,legacyOwner>>
\* L87 await rm(temp): private I/O, represented by one stuttering step.
Clean(p) == Top(p).pc="clean" /\ Goto(p,"return")
  /\ UNCHANGED <<files,serial,alive,crashes,success,legacyOwner>>
\* L83/L88 return: resume the parent's suspended await L75.
Return(p) == Top(p).pc="return"
  /\ (IF D(p)=1 THEN Goto(p,"done")
     ELSE LET parent==stack[p][D(p)-1]
              resumed==IF Top(p).result # "ok" THEN [parent EXCEPT !.result=Top(p).result, !.pc="clean"]
                       ELSE IF parent.attempt+1 < Attempts THEN [parent EXCEPT !.attempt=@+1, !.pc="link"]
                       ELSE [parent EXCEPT !.result="busy", !.pc="clean"]
          IN stack'=[stack EXCEPT ![p]=Append(SubSeq(@,1,D(p)-2),resumed)])
  /\ UNCHANGED <<files,serial,alive,crashes,success,legacyOwner>>
Crash(p) == alive[p] /\ p # Probe /\ ~Terminal(p) /\ crashes<MaxCrashes
  /\ alive'=[alive EXCEPT ![p]=FALSE] /\ crashes'=crashes+1
  /\ UNCHANGED <<files,stack,serial,success,legacyOwner>>
Exit(p) == alive[p] /\ Terminal(p) /\ alive'=[alive EXCEPT ![p]=FALSE]
  /\ UNCHANGED <<files,stack,serial,crashes,success,legacyOwner>>
\* 7239ce8 only: await mkdir(`${file}.recover`), then finally rm(dir).
\* The fresh-probe temporal property is identical for old and new protocols.
LegacyMkdir(p) == Top(p).pc="legacyMkdir"
  /\ (IF legacyOwner="none" THEN legacyOwner'=p /\ Goto(p,"curDir")
      ELSE UNCHANGED legacyOwner /\ Finish(p,"busy"))
  /\ UNCHANGED <<files,serial,alive,crashes,success>>
LegacyRm(p) == Top(p).pc="legacyRm" /\ legacyOwner'="none"
  /\ (IF Top(p).result="error" THEN Finish(p,"error") ELSE NextAttempt(p))
  /\ UNCHANGED <<files,serial,alive,crashes,success>>
Step(p) == alive[p] /\ (Wait(p) \/ Dir(p) \/ Temp(p) \/ Link(p) \/ ReadDir(p) \/ ReadStat(p)
  \/ Read(p) \/ CheckOld(p) \/ Call(p) \/ CheckCur(p) \/ RmFile(p) \/ CS(p) \/ RelRm(p)
  \/ Clean(p) \/ Return(p) \/ Exit(p) \/ LegacyMkdir(p) \/ LegacyRm(p))
Next == \E p \in Procs : Step(p) \/ Crash(p)
Spec == Init /\ [][Next]_vars /\ (\A p \in Procs : WF_vars(Step(p)))

MutualExclusion == \A p,q \in Procs :
  (p # q /\ alive[p] /\ alive[q] /\ Top(p).acquired /\ Top(q).acquired
    /\ Top(p).pc \notin {"clean","return","done"} /\ Top(q).pc \notin {"clean","return","done"})
  => Top(p).target # Top(q).target
HolderOwnsFile == \A p \in Procs :
  (alive[p] /\ Top(p).acquired /\ Top(p).pc \notin {"clean","return","done"})
  => At(Top(p).target).tok=Top(p).token
\* A non-crashing fresh caller starts after all prior callers exit. Under
\* weak scheduling fairness it must execute fn(), with 2 attempts/frame.
NotWedged == AllWorkersGone ~> success[Probe]
TypeOK ==
  /\ crashes \in 0..MaxCrashes
  /\ \A p \in Procs :
      /\ D(p)>=1 /\ D(p)<=MaxCrashes+2 /\ Top(p).attempt \in 0..(Attempts-1)
      /\ Top(p).pc \in {"wait","dir","temp","link","oldDir","oldStat","oldRead","checkOld","call",
                         "curDir","curStat","curRead","checkCur","rmFile","cs","relDir","relStat","relRead","relRm","clean","return","done","legacyMkdir","legacyRm"}
Symmetry == { [p \in Procs |-> IF p=Probe THEN p ELSE perm[p]] : perm \in Permutations(Procs \ {Probe}) }
=============================================================================
