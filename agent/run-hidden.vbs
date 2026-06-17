' ─────────────────────────────────────────────────────────────
' run-hidden.vbs — launch the Tally Cloud Sync agent with NO console
' window, in the current user's session, then exit. The agent keeps
' running in the background until it is stopped. Must sit next to
' TallyCloudSyncAgent.exe (or one folder above a dist\ subfolder).
' ─────────────────────────────────────────────────────────────
Option Explicit
Dim sh, fso, here, exe
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

exe = here & "\TallyCloudSyncAgent.exe"
If Not fso.FileExists(exe) Then exe = here & "\dist\TallyCloudSyncAgent.exe"

If fso.FileExists(exe) Then
    sh.CurrentDirectory = fso.GetParentFolderName(exe)
    ' 0 = hidden window, False = don't wait (fire-and-forget, runs detached).
    sh.Run """" & exe & """", 0, False
End If
