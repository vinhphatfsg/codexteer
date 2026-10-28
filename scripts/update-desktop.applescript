-- Match known update labels inside the fixed Codex application process.
-- This does not authenticate a Sparkle window. Nonmatching controls and OS
-- permission prompts are left to the user.
on run argv
  set operation to item 1 of argv
  tell application "System Events"
    if not (exists (first application process whose bundle identifier is "com.openai.codex")) then return "absent"
    set appProcess to first application process whose bundle identifier is "com.openai.codex"
    tell appProcess
      if operation is "preflight" or operation is "check" then
        repeat with entry in menu items of menu 1 of menu bar item 2 of menu bar 1
          if name of entry is in {"Check for Updates…", "Check for Updates...", "更新を確認…", "更新を確認..."} then
            if not enabled of entry then error "The update menu is disabled."
            if operation is "check" then click entry
            return "checking"
          end if
        end repeat
        error "Supported Codex update menu not found (English/Japanese supported)."
      end if
      if operation is not "advance" and operation is not "inspect" then error "Unknown updater operation."
      -- Do not retain System Events' name-based window references: multiple
      -- Codex windows may have the same title. Resolve positional references
      -- afresh, and tolerate only stale AX elements during this polling pass.
      repeat with windowIndex from 1 to count of windows
        try
          repeat with buttonIndex from 1 to count of buttons of window windowIndex
            try
              set buttonName to name of button buttonIndex of window windowIndex
              if buttonName is in {"Install and Relaunch", "インストールして再起動", "Install Update", "アップデートをインストール"} then
                if enabled of button buttonIndex of window windowIndex then
                  if operation is "advance" then click button buttonIndex of window windowIndex
                  if buttonName is in {"Install and Relaunch", "インストールして再起動"} then return "installing"
                  return "downloading"
                end if
              end if
            on error errorMessage number errorNumber
              if errorNumber is not -1719 and errorNumber is not -1728 then error errorMessage number errorNumber
            end try
          end repeat
          repeat with textIndex from 1 to count of static texts of window windowIndex
            set messageText to value of static text textIndex of window windowIndex as text
            if messageText contains "You’re up to date!" or messageText contains "currently the newest version available" or messageText contains "最新版を使用しています!" or messageText contains "は現在入手できる最新バージョンです" then return "up_to_date"
          end repeat
        on error errorMessage number errorNumber
          if errorNumber is not -1719 and errorNumber is not -1728 then error errorMessage number errorNumber
        end try
      end repeat
    end tell
  end tell
  return "waiting"
end run
