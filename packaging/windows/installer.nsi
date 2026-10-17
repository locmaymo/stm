Unicode True
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!ifndef VERSION
  !define VERSION "1.2.0"
!endif
!ifndef SOURCE_DIR
  !define SOURCE_DIR "..\..\build\release\windows-x64"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\..\build\SillyTavernManager-windows-x64-v${VERSION}-setup.exe"
!endif
!ifndef ICO_FILE
  !define ICO_FILE "app.ico"
!endif

!define APP_NAME "SillyTavern Manager"
!define APP_EXE "SillyTavernManager.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SillyTavernManager"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\SillyTavernManager"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
BrandingText "${APP_NAME} v${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "AGPL-3.0-only"

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "${ICO_FILE}"
!define MUI_UNICON "${ICO_FILE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Vietnamese"

Var LaunchAfterSilent

Function .onInit
  ReadRegStr $R2 HKCU "Control Panel\International\Geo" "Name"
  StrCmp $R2 "VN" use_vi 0
  ReadRegStr $R2 HKCU "Control Panel\International\Geo" "Nation"
  StrCmp $R2 "251" use_vi 0
  ReadRegStr $R2 HKLM "SYSTEM\CurrentControlSet\Control\TimeZoneInformation" "TimeZoneKeyName"
  StrCmp $R2 "SE Asia Standard Time" use_vi check_params
use_vi:
  StrCpy $LANGUAGE ${LANG_VIETNAMESE}
check_params:
  StrCpy $LaunchAfterSilent "0"
  ${GetParameters} $R0
  ${GetOptions} $R0 "/LAUNCH=" $R1
  IfErrors +2 0
    StrCpy $LaunchAfterSilent $R1
FunctionEnd

Function .onInstSuccess
  StrCmp $LaunchAfterSilent "1" 0 +2
    Exec '"$INSTDIR\${APP_EXE}"'
FunctionEnd

Function un.onInit
  ReadRegStr $R2 HKCU "Control Panel\International\Geo" "Name"
  StrCmp $R2 "VN" un_use_vi 0
  ReadRegStr $R2 HKCU "Control Panel\International\Geo" "Nation"
  StrCmp $R2 "251" un_use_vi 0
  ReadRegStr $R2 HKLM "SYSTEM\CurrentControlSet\Control\TimeZoneInformation" "TimeZoneKeyName"
  StrCmp $R2 "SE Asia Standard Time" un_use_vi un_done
un_use_vi:
  StrCpy $LANGUAGE ${LANG_VIETNAMESE}
un_done:
FunctionEnd

Section "Install" SecMain
  SetShellVarContext current

  ; Gracefully stop any running SillyTavern Manager instance before replacing files.
  IfFileExists "$INSTDIR\${APP_EXE}" 0 +3
    nsExec::ExecToLog '"$INSTDIR\${APP_EXE}" --shutdown'
    Pop $0
  nsExec::ExecToLog 'taskkill.exe /F /IM "${APP_EXE}"'
  Pop $0

  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortCut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  SetShellVarContext current

  IfFileExists "$INSTDIR\${APP_EXE}" 0 +3
    nsExec::ExecToLog '"$INSTDIR\${APP_EXE}" --shutdown'
    Pop $0
  nsExec::ExecToLog 'taskkill.exe /F /IM "${APP_EXE}"'
  Pop $0

  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  DeleteRegValue HKCU "${RUN_KEY}" "SillyTavernManager"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"

  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\${APP_EXE}.config"
  Delete "$INSTDIR\Microsoft.Web.WebView2.Core.dll"
  Delete "$INSTDIR\Microsoft.Web.WebView2.WinForms.dll"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  Delete "$INSTDIR\Read me first.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
