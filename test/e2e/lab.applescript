on run argv
	set verb to item 1 of argv
	if verb is "tree" then return tree()
	if verb is "new-window" then return newWindow(item 2 of argv)
	if verb is "new-tab" then return newTab(item 2 of argv, item 3 of argv)
	if verb is "type" then return typeText(item 2 of argv, item 3 of argv)
	if verb is "key" then return sendKey(item 2 of argv, item 3 of argv)
	if verb is "key-mod" then return sendKeyMod(item 2 of argv, item 3 of argv, item 4 of argv)
	if verb is "screen" then return screenFile(item 2 of argv)
	if verb is "action" then return doAction(item 2 of argv, item 3 of argv)
	if verb is "mouse-move" then return mouseMove(item 2 of argv, item 3 of argv, item 4 of argv)
	if verb is "mouse-scroll" then return mouseScroll(item 2 of argv, item 3 of argv)
	if verb is "mouse-click" then return mouseClick(item 2 of argv)
	if verb is "select-tab" then return selectTab(item 2 of argv)
	if verb is "focus" then return focusTerm(item 2 of argv)
	if verb is "close-term" then return closeTerm(item 2 of argv)
	if verb is "close-window" then return closeWindow(item 2 of argv)
	error "unknown verb: " & verb number 64
end run

on tree()
	set out to {}
	tell application id "com.mitchellh.ghostty"
		set end of out to "frontmost=" & frontmost
		try
			set end of out to "front=" & (id of front window)
		end try
		repeat with w in windows
			repeat with t in tabs of w
				set row to "win=" & (id of w) & " tab=" & (id of t) & " idx=" & (index of t) & " selected=" & (selected of t)
				try
					set row to row & " focused=" & (id of focused terminal of t)
				end try
				set end of out to row
				repeat with x in terminals of t
					set end of out to "  term=" & (id of x) & " tty=" & (tty of x) & " pid=" & (pid of x)
				end repeat
			end repeat
		end repeat
	end tell
	set AppleScript's text item delimiters to linefeed
	return out as text
end tree

on newWindow(cwd)
	tell application id "com.mitchellh.ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to cwd
		set w to new window with configuration cfg
		set t to selected tab of w
		return "win=" & (id of w) & " tab=" & (id of t) & " term=" & (id of focused terminal of t)
	end tell
end newWindow

on newTab(winId, cwd)
	tell application id "com.mitchellh.ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to cwd
		set t to new tab in (first window whose id is winId) with configuration cfg
		return "win=" & winId & " tab=" & (id of t) & " term=" & (id of focused terminal of t)
	end tell
end newTab

on typeText(termId, txt)
	tell application id "com.mitchellh.ghostty" to input text txt to (first terminal whose id is termId)
	return "ok"
end typeText

on sendKey(termId, keyName)
	tell application id "com.mitchellh.ghostty" to send key keyName to (first terminal whose id is termId)
	return "ok"
end sendKey

on sendKeyMod(termId, keyName, mods)
	tell application id "com.mitchellh.ghostty" to send key keyName modifiers mods to (first terminal whose id is termId)
	return "ok"
end sendKeyMod

on screenFile(termId)
	tell application id "com.mitchellh.ghostty"
		if (perform action "write_screen_file:copy" on (first terminal whose id is termId)) then return "ok"
	end tell
	error "write_screen_file failed" number 1
end screenFile

on doAction(termId, act)
	tell application id "com.mitchellh.ghostty"
		if (perform action act on (first terminal whose id is termId)) then return "true"
	end tell
	return "false"
end doAction

on mouseMove(termId, px, py)
	tell application id "com.mitchellh.ghostty" to send mouse position x (px as real) y (py as real) to (first terminal whose id is termId)
	return "ok"
end mouseMove

on mouseScroll(termId, dy)
	tell application id "com.mitchellh.ghostty" to send mouse scroll x 0 y (dy as real) to (first terminal whose id is termId)
	return "ok"
end mouseScroll

on mouseClick(termId)
	tell application id "com.mitchellh.ghostty"
		set t to (first terminal whose id is termId)
		send mouse button left button action press to t
		send mouse button left button action release to t
	end tell
	return "ok"
end mouseClick

on selectTab(tabId)
	tell application id "com.mitchellh.ghostty"
		repeat with w in windows
			repeat with t in tabs of w
				if (id of t) is tabId then
					select tab t
					return "ok"
				end if
			end repeat
		end repeat
	end tell
	return "gone"
end selectTab

-- Brings the terminal's window to the front (and Ghostty with it). Only for taking screenshots.
on focusTerm(termId)
	tell application id "com.mitchellh.ghostty" to focus (first terminal whose id is termId)
	return "ok"
end focusTerm

on closeTerm(termId)
	tell application id "com.mitchellh.ghostty" to close (first terminal whose id is termId)
	return "ok"
end closeTerm

on closeWindow(winId)
	tell application id "com.mitchellh.ghostty" to close window (first window whose id is winId)
	return "ok"
end closeWindow
