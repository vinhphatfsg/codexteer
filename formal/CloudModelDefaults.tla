------------------------ MODULE CloudModelDefaults ------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS AllowedPairs, DefaultPair, Attempts, Failures, CatalogChanges, Bug

None == [model |-> "none", effort |-> "none"]
PairALow == [model |-> "a", effort |-> "low"]
PairAHigh == [model |-> "a", effort |-> "high"]
PairBHigh == [model |-> "b", effort |-> "high"]
SmallPairs == {PairALow, PairBHigh}
WidePairs == {PairALow, PairAHigh, PairBHigh}
Models == {p.model : p \in AllowedPairs}
Efforts == {p.effort : p \in AllowedPairs}
AllPairs == [model : Models, effort : Efforts]
Phases == {"new", "reserved", "validated", "rejected", "armed", "awaitCreate",
           "unknown", "created", "turnArmed", "awaitTurn", "turnUnknown", "done"}

VARIABLES saved, lastPublished, catalog, picker, candidate,
          phase, pinned, desired, checked, createCount, turnCount, createPair, turnPair

vars == <<saved, lastPublished, catalog, picker, candidate,
          phase, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>
work == <<phase, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>
settings == <<saved, lastPublished, catalog, picker, candidate>>
Effective == IF saved = None THEN DefaultPair ELSE saved
NoOverride == "no-override"
DefaultEffort(m) == IF m = "a" THEN "low" ELSE "high"
Resolved(m, e) ==
    LET selectedModel == IF m = NoOverride THEN Effective.model ELSE m
        selectedEffort == IF e # NoOverride THEN e
                          ELSE IF saved # None /\ saved.model = selectedModel
                               THEN saved.effort ELSE DefaultEffort(selectedModel)
    IN [model |-> selectedModel, effort |-> selectedEffort]

Init == /\ saved = None /\ lastPublished = None /\ catalog = AllowedPairs
        /\ picker = "idle" /\ candidate = None
        /\ phase = [a \in Attempts |-> "new"]
        /\ pinned = [a \in Attempts |-> None] /\ desired = pinned /\ checked = pinned
        /\ createPair = pinned /\ turnPair = pinned
        /\ createCount = [a \in Attempts |-> 0] /\ turnCount = createCount

BeginPick == /\ picker = "idle" /\ picker' = "choosing" /\ candidate' = None
             /\ UNCHANGED <<saved, lastPublished, catalog, work>>
Choose(p) == /\ picker = "choosing" /\ p \in catalog /\ candidate' = p
             /\ UNCHANGED <<saved, lastPublished, catalog, picker, work>>
Cancel == /\ picker = "choosing" /\ picker' = "idle" /\ candidate' = None
          /\ UNCHANGED <<saved, lastPublished, catalog, work>>
ValidateSave == /\ picker = "choosing" /\ candidate \in catalog
                /\ picker' = "ready"
                /\ UNCHANGED <<saved, lastPublished, catalog, candidate, work>>
Publish == /\ picker = "ready"
           /\ saved' = IF Bug = "torn-write"
                         THEN [model |-> candidate.model, effort |-> Effective.effort]
                         ELSE candidate
           /\ lastPublished' = candidate /\ picker' = "idle" /\ candidate' = None
           /\ UNCHANGED <<catalog, work>>
AbandonSave == /\ Failures /\ picker = "ready" /\ picker' = "idle" /\ candidate' = None
               /\ UNCHANGED <<saved, lastPublished, catalog, work>>
Reset == /\ saved' = None /\ lastPublished' = None
         /\ UNCHANGED <<catalog, picker, candidate, work>>
ChangeCatalog == /\ CatalogChanges /\ catalog' \in SUBSET AllowedPairs
                 /\ UNCHANGED <<saved, lastPublished, picker, candidate, work>>

\* Atomic reservation models withStoreLock + writeHistoryRecord. Two callers
\* with the same order share this one record; retries cannot make a new key.
Reserve(a, m, e) == /\ phase[a] = "new" /\ Resolved(m, e) \in catalog
              /\ phase' = [phase EXCEPT ![a] = "reserved"]
              /\ desired' = [desired EXCEPT ![a] = Resolved(m, e)]
              /\ pinned' = [pinned EXCEPT ![a] = IF Bug = "cached-default" /\ m = NoOverride /\ e = NoOverride THEN DefaultPair ELSE Resolved(m, e)]
              /\ UNCHANGED <<settings, checked, createCount, turnCount, createPair, turnPair>>
ValidateCreate(a) ==
    /\ phase[a] = "reserved"
    /\ phase' = [phase EXCEPT ![a] = IF pinned[a] \in catalog \/ Bug = "skip-validation" THEN "validated" ELSE "rejected"]
    /\ checked' = [checked EXCEPT ![a] = IF pinned[a] \in catalog THEN pinned[a] ELSE None]
    /\ UNCHANGED <<settings, pinned, desired, createCount, turnCount, createPair, turnPair>>
RetryKnown(a) ==
    /\ phase[a] = "rejected" /\ createCount[a] = 0
    /\ phase' = [phase EXCEPT ![a] = "reserved"]
    /\ pinned' = [pinned EXCEPT ![a] = IF Bug = "unpin-retry" THEN Effective ELSE @]
    /\ UNCHANGED <<settings, desired, checked, createCount, turnCount, createPair, turnPair>>
ArmCreate(a) == /\ phase[a] = "validated" /\ phase' = [phase EXCEPT ![a] = "armed"]
                /\ UNCHANGED <<settings, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>
SendCreate(a) == /\ phase[a] = "armed" /\ createCount[a] < 2
                 /\ phase' = [phase EXCEPT ![a] = "awaitCreate"]
                 /\ createCount' = [createCount EXCEPT ![a] = @ + 1]
                 /\ createPair' = [createPair EXCEPT ![a] = pinned[a]]
                 /\ UNCHANGED <<settings, pinned, desired, checked, turnCount, turnPair>>
AckCreate(a) == /\ phase[a] = "awaitCreate" /\ phase' = [phase EXCEPT ![a] = "created"]
                /\ UNCHANGED <<settings, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>
LoseCreate(a) == /\ Failures /\ phase[a] \in {"armed", "awaitCreate"}
                 /\ phase' = [phase EXCEPT ![a] = "unknown"]
                 /\ UNCHANGED <<settings, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>
ReconcileCreate(a) == /\ phase[a] = "unknown" /\ createCount[a] = 1
                      /\ phase' = [phase EXCEPT ![a] = "created"]
                      /\ UNCHANGED <<settings, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>
BadRetryCreate(a) == /\ Bug = "retry-unknown" /\ phase[a] = "unknown"
                     /\ phase' = [phase EXCEPT ![a] = "validated"]
                     /\ UNCHANGED <<settings, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>

ArmTurn(a) == /\ phase[a] = "created" /\ phase' = [phase EXCEPT ![a] = "turnArmed"]
              /\ UNCHANGED <<settings, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>
SendTurn(a) == /\ phase[a] = "turnArmed" /\ turnCount[a] < 2
               /\ phase' = [phase EXCEPT ![a] = "awaitTurn"]
               /\ turnCount' = [turnCount EXCEPT ![a] = @ + 1]
               /\ turnPair' = [turnPair EXCEPT ![a] = IF Bug = "late-selection" THEN Effective ELSE pinned[a]]
               /\ UNCHANGED <<settings, pinned, desired, checked, createCount, createPair>>
AckTurn(a) == /\ phase[a] = "awaitTurn" /\ phase' = [phase EXCEPT ![a] = "done"]
              /\ UNCHANGED <<settings, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>
LoseTurn(a) == /\ Failures /\ phase[a] \in {"turnArmed", "awaitTurn"}
               /\ phase' = [phase EXCEPT ![a] = "turnUnknown"]
               /\ UNCHANGED <<settings, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>
ReconcileTurn(a) == /\ phase[a] = "turnUnknown" /\ turnCount[a] = 1
                    /\ phase' = [phase EXCEPT ![a] = "done"]
                    /\ UNCHANGED <<settings, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>
BadRetryTurn(a) == /\ Bug = "resend-turn" /\ phase[a] = "turnUnknown"
                   /\ phase' = [phase EXCEPT ![a] = "turnArmed"]
                   /\ UNCHANGED <<settings, pinned, desired, checked, createCount, turnCount, createPair, turnPair>>

Progress(a) == (\E m \in Models \cup {NoOverride}, e \in Efforts \cup {NoOverride} : Reserve(a, m, e))
               \/ ValidateCreate(a) \/ RetryKnown(a) \/ ArmCreate(a)
               \/ SendCreate(a) \/ AckCreate(a) \/ ArmTurn(a) \/ SendTurn(a) \/ AckTurn(a)
Next == BeginPick \/ (\E p \in AllowedPairs : Choose(p)) \/ Cancel \/ ValidateSave
        \/ Publish \/ AbandonSave \/ Reset \/ ChangeCatalog
        \/ (\E a \in Attempts : Progress(a) \/ LoseCreate(a) \/ ReconcileCreate(a)
            \/ BadRetryCreate(a) \/ LoseTurn(a) \/ ReconcileTurn(a) \/ BadRetryTurn(a))
Spec == Init /\ [][Next]_vars /\ (\A a \in Attempts : WF_vars(Progress(a)))

TypeOK == /\ saved \in AllPairs \cup {None} /\ lastPublished \in AllowedPairs \cup {None}
          /\ catalog \subseteq AllowedPairs /\ picker \in {"idle", "choosing", "ready"}
          /\ candidate \in AllowedPairs \cup {None}
          /\ phase \in [Attempts -> Phases]
          /\ pinned \in [Attempts -> AllowedPairs \cup {None}]
          /\ desired \in [Attempts -> AllowedPairs \cup {None}]
          /\ checked \in [Attempts -> AllowedPairs \cup {None}]
          /\ createCount \in [Attempts -> 0..2] /\ turnCount \in [Attempts -> 0..2]
          /\ createPair \in [Attempts -> AllowedPairs \cup {None}]
          /\ turnPair \in [Attempts -> AllowedPairs \cup {None}]
AtomicDefaults == saved = lastPublished
PinnedChoice == \A a \in Attempts : pinned[a] = desired[a]
CreateAtMostOnce == \A a \in Attempts : createCount[a] <= 1
FirstTurnAtMostOnce == \A a \in Attempts : turnCount[a] <= 1
CreateUsesChoice == \A a \in Attempts : createCount[a] > 0 => createPair[a] = desired[a]
TurnUsesChoice == \A a \in Attempts : turnCount[a] > 0 => turnPair[a] = desired[a]
ValidatedBeforeCreate == \A a \in Attempts : createCount[a] > 0 => createPair[a] = checked[a]
NoTurnWithoutCreate == \A a \in Attempts : turnCount[a] > 0 => createCount[a] = 1
EventuallyDone == \A a \in Attempts : <> (phase[a] = "done")
=============================================================================
