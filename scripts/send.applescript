on run argv
  if (count of argv) is not 4 then error "Expected wait time, submit shortcut, focus policy, and previous process ID." number 64
  set waitSeconds to ((item 1 of argv) as integer) / 1000
  set submitShortcut to item 2 of argv
  set focusPolicy to item 3 of argv
  set previousProcessId to (item 4 of argv) as integer
  if submitShortcut is not "plain" and submitShortcut is not "command" and submitShortcut is not "command-shift" then error "Invalid submit shortcut." number 64
  if focusPolicy is not "restore" and focusPolicy is not "keep" then error "Invalid focus policy." number 64

  if focusPolicy is "restore" then my restoreFocus(previousProcessId)
  delay waitSeconds

  try
    tell application "System Events"
      set appProcess to first application process whose bundle identifier is "com.openai.codex"
      tell appProcess
        set frontmost to true
        if not (exists front window) then error "Codex Desktop has no front window." number 69
      end tell

      if submitShortcut is "command" then
        key code 36 using {command down}
      else if submitShortcut is "command-shift" then
        key code 36 using {command down, shift down}
      else
        key code 36
      end if
    end tell

    if focusPolicy is "restore" then my restoreFocus(previousProcessId)
  on error errorMessage number errorNumber
    if focusPolicy is "restore" then my restoreFocus(previousProcessId)
    error errorMessage number errorNumber
  end try

  return "sent"
end run

on restoreFocus(processId)
  if processId is 0 then return
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is processId
    if (count of matchingProcesses) > 0 then set frontmost of item 1 of matchingProcesses to true
  end tell
end restoreFocus
