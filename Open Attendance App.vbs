Dim shell
Dim fso
Dim projectPath
Dim electronPath
Dim ps1Path
Dim batPath
Dim command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectPath = fso.GetParentFolderName(WScript.ScriptFullName)
electronPath = projectPath & "\node_modules\electron\dist\electron.exe"
ps1Path = projectPath & "\run_gui.ps1"
batPath = projectPath & "\run_gui.bat"

If fso.FileExists(electronPath) Then
  command = """" & electronPath & """ """ & projectPath & """"
ElseIf fso.FileExists(batPath) Then
  command = "cmd.exe /c """ & batPath & """"
ElseIf fso.FileExists(ps1Path) Then
  command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1Path & """"
Else
  MsgBox "Could not find a valid launcher." & vbCrLf & vbCrLf & _
         "Expected one of these files:" & vbCrLf & _
         "- run_gui.ps1" & vbCrLf & _
         "- run_gui.bat" & vbCrLf & _
         "- node_modules\electron\dist\electron.exe" & vbCrLf & vbCrLf & _
         "Run npm install, then try again.", vbCritical, "Attendance App"
  WScript.Quit 1
End If

shell.CurrentDirectory = projectPath
shell.Run command, 1, False
