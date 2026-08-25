Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\PC\Desktop\DALVE Agent"
WshShell.Run "cmd /c npm run dev > ""%TEMP%\dalve-dev.log"" 2>&1", 0, False
