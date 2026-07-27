Option Explicit

Dim fileSystem, shell, projectDirectory, hiddenCommandPath
Dim commandProcessor, commandLine, logPath, logFile

On Error Resume Next
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

projectDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
hiddenCommandPath = fileSystem.BuildPath(projectDirectory, "Start 39Note Hidden.cmd")
logPath = fileSystem.BuildPath(projectDirectory, "39note-launch.log")
commandProcessor = shell.ExpandEnvironmentStrings("%ComSpec%")

If Not fileSystem.FileExists(hiddenCommandPath) Then
  Set logFile = fileSystem.OpenTextFile(logPath, 8, True)
  logFile.WriteLine Now & " ERROR: Start 39Note Hidden.cmd is missing."
  logFile.Close
  WScript.Quit 1
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
