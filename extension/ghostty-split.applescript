on run argv
	if (count of argv) < 2 then error "usage: split|resize|close|close-tty|exists ..." number 64
	if application id "com.mitchellh.ghostty" is not running then return "not-running"
	set verb to item 1 of argv
	if verb is "split" then return doSplit(item 2 of argv, item 3 of argv, item 4 of argv)
	if verb is "resize" then return doResize(item 2 of argv, item 3 of argv, item 4 of argv)
	if verb is "close" then return doClose(item 2 of argv)
	if verb is "close-tty" then return doCloseTty(item 2 of argv)
	if verb is "exists" then return doExists(item 2 of argv)
	error "unknown verb: " & verb number 64
end run

on doSplit(ttyPath, dir, cmd)
	tell application id "com.mitchellh.ghostty"
		set found to (every terminal whose tty is ttyPath)
		if (count of found) is 0 then return "not-found"
		set src to item 1 of found
		set cfg to new surface configuration
		set command of cfg to cmd
		set wait after command of cfg to false
		if dir is "right" then
			set pane to split src direction right with configuration cfg
		else if dir is "left" then
			set pane to split src direction left with configuration cfg
		else if dir is "up" then
			set pane to split src direction up with configuration cfg
		else if dir is "down" then
			set pane to split src direction down with configuration cfg
		else
			error "bad direction: " & dir number 64
		end if
		set focusResult to "failed"
		try
			if (perform action ("goto_split:" & my opposite(dir)) on pane) then set focusResult to "restored"
		end try
		return "ok " & (id of pane) & " focus=" & focusResult
	end tell
end doSplit

on opposite(dir)
	if dir is "right" then return "left"
	if dir is "left" then return "right"
	if dir is "up" then return "down"
	return "up"
end opposite

on doResize(termId, dir, px)
	tell application id "com.mitchellh.ghostty"
		set found to (every terminal whose id is termId)
		if (count of found) is 0 then return "gone"
		if (perform action ("resize_split:" & dir & "," & px) on (item 1 of found)) then return "ok"
		return "fail"
	end tell
end doResize

on doClose(termId)
	tell application id "com.mitchellh.ghostty"
		set found to (every terminal whose id is termId)
		if (count of found) is 0 then return "gone"
		close (item 1 of found)
		return "ok"
	end tell
end doClose

on doCloseTty(ttyPath)
	tell application id "com.mitchellh.ghostty"
		set found to (every terminal whose tty is ttyPath)
		if (count of found) is 0 then return "gone"
		close (item 1 of found)
		return "ok"
	end tell
end doCloseTty

on doExists(termId)
	tell application id "com.mitchellh.ghostty"
		if (count of (every terminal whose id is termId)) is 0 then return "gone"
		return "yes"
	end tell
end doExists
