on run argv
  if (count of argv) is less than 1 then error "Expected enable or restore." number 64
  set operation to item 1 of argv

  tell application "System Events"
    set appProcess to first application process whose bundle identifier is "com.openai.codex"
    tell appProcess
      if operation is "enable" then
        try
          set manualWasEnabled to (value of attribute "AXManualAccessibility") as boolean
          if manualWasEnabled is false then
            set value of attribute "AXManualAccessibility" to true
            return "manual"
          end if
          return "unchanged"
        on error
          set enhancedWasEnabled to false
          try
            set enhancedWasEnabled to (value of attribute "AXEnhancedUserInterface") as boolean
          end try
          if enhancedWasEnabled is false then
            set value of attribute "AXEnhancedUserInterface" to true
            return "enhanced"
          end if
          return "unchanged"
        end try
      end if

      if operation is "restore" then
        if (count of argv) is not 2 then error "Expected accessibility mode to restore." number 64
        set accessibilityMode to item 2 of argv
        if accessibilityMode is "manual" then
          set value of attribute "AXManualAccessibility" to false
        else if accessibilityMode is "enhanced" then
          set value of attribute "AXEnhancedUserInterface" to false
        end if
        return "restored"
      end if
    end tell
  end tell

  error "Expected enable or restore." number 64
end run
