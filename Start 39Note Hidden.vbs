Option Explicit

Dim fileSystem, shell, projectDirectory, hiddenCommandPath, readinessHelperPath
Dim commandProcessor, commandLine, logPath, logFile, probeCommand, probeResult

On Error Resume Next
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

projectDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
hiddenCommandPath = fileSystem.BuildPath(projectDirectory, "Start 39Note Hidden.cmd")
readinessHelperPath = fileSystem.BuildPath(projectDirectory, "Open 39Note When Ready.ps1")
logPath = fileSystem.BuildPath(projectDirectory, "39note-launch.log")
commandProcessor = shell.ExpandEnvironmentStrings("%ComSpec%")

If Not fileSystem.FileExists(hiddenCommandPath) Then
  Set logFile = fileSystem.OpenTextFile(logPath, 8, True)
  logFile.WriteLine Now & " ERROR: Start 39Note Hidden.cmd is missing."
  logFile.Close
  WScript.Quit 1
End If

If Not fileSystem.FileExists(readinessHelperPath) Then
  Set logFile = fileSystem.OpenTextFile(logPath, 8, True)
  logFile.WriteLine Now & " ERROR: Open 39Note When Ready.ps1 is missing."
  logFile.Close
  WScript.Quit 1
End If

probeCommand = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ & readinessHelperPath & """ -Url ""http://127.0.0.1:5173/"" -LogPath """ & logPath & """ -ProbeOnly"
Err.Clear
probeResult = shell.Run(probeCommand, 0, True)

If Err.Number <> 0 Then
  Set logFile = fileSystem.OpenTextFile(logPath, 8, True)
  logFile.WriteLine Now & " ERROR: Hidden launcher could not run the 39Note identity check. Code " & Err.Number
  logFile.Close
  WScript.Quit 1
End If

If probeResult = 0 Then
  shell.Run """http://127.0.0.1:5173/""", 0, False
  WScript.Quit 0
End If

If probeResult = 2 Then
  MsgBox "Port 5173 is currently being used by another application. Close that application and start 39Note again.", 16, "39Note"
  WScript.Quit 2
End If

commandLine = """" & commandProcessor & """ /d /c call """ & hiddenCommandPath & """"
shell.Run commandLine, 0, False

If Err.Number <> 0 Then
  Set logFile = fileSystem.OpenTextFile(logPath, 8, True)
  logFile.WriteLine Now & " ERROR: Hidden launcher could not start cmd.exe. Code " & Err.Number
  logFile.Close
  WScript.Quit 1
End If

WScript.Quit 0
