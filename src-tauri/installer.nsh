!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering secure outbound firewall rule for student binaries..."
  # Add outbound firewall block rule for student_bin.exe in temp directory
  nsExec::ExecToLog 'powershell -NoProfile -Command "netsh advfirewall firewall add rule name=\\"BlockThemisV2Student\\" dir=out action=block program=\\"$TEMP\themis-v2\student_bin.exe\\""'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing secure outbound firewall rule..."
  # Remove firewall block rule during uninstallation
  nsExec::ExecToLog 'powershell -NoProfile -Command "netsh advfirewall firewall delete rule name=\\"BlockThemisV2Student\\""'
!macroend
