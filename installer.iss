; ==============================================
; DeepSeek 桌面客户端 安装脚本 v1.2.0
; 全中文界面 + 优化安装体验
; ==============================================

#define MyAppName "DeepSeek"
#define MyAppNameCN "DeepSeek 桌面客户端"
#define MyAppVersion "1.2.0"
#define MyAppPublisher "DeepSeek"
#define MyAppExeName "DeepSeek.exe"

; 打包源目录。默认 electron-builder 的输出 dist\win-unpacked；
; 若用其它目录构建（例如 dist-fix），编译时覆盖：
;   ISCC /DUnpackedDir=dist-fix\win-unpacked installer.iss
; 注意：DeepSeek.exe 内写有 app.asar 的完整性哈希，exe 与 asar 必须来自同一次构建，
; 不能只替换其中一个。
#ifndef UnpackedDir
  #define UnpackedDir "dist\win-unpacked"
#endif

[Setup]
AppId={{B8C4D5E6-1A2B-3C4D-5E6F-7A8B9C0D1E2F}
AppName={#MyAppNameCN}
AppVersion={#MyAppVersion}
AppVerName={#MyAppNameCN} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
; 安装目录跟着权限走：普通用户装到 LocalAppData 下的 Program Files，
; 提权安装才进 Program Files。写死 D:\ 会在没有 D 盘的机器上直接失败。
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
; 所有路径以脚本所在目录为基准，换机器/换盘符都能编
OutputDir={#SourcePath}inno-out
OutputBaseFilename=DeepSeek-Setup-{#MyAppVersion}
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName={#MyAppNameCN}
Compression=lzma2/fast
SolidCompression=no

; ===== 品牌资源 =====
SetupIconFile={#SourcePath}assets\icon.ico
WizardImageFile={#SourcePath}assets\installer-sidebar.bmp
WizardSmallImageFile={#SourcePath}assets\installer-small.bmp

; ===== 界面优化 =====
WizardStyle=modern
WizardSizePercent=110
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableReadyPage=no

; ===== 语言 =====
ShowLanguageDialog=no

; ===== 权限与卸载 =====
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppNameCN}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[CustomMessages]
chinesesimp.CreateDesktopIcon=创建桌面快捷方式
chinesesimp.LaunchApp=立即启动 {#MyAppNameCN}

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "附加选项：";

[Files]
Source: "{#SourcePath}{#UnpackedDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppNameCN}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppNameCN}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppNameCN}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall shellexec runasoriginaluser; WorkingDir: "{app}"

[Registry]
; 强制 DeepSeek 使用高性能独立显卡 (GpuPreference=2)
Root: HKCU; Subkey: "Software\Microsoft\DirectX\UserGpuPreferences"; ValueType: string; ValueName: "{app}\{#MyAppExeName}"; ValueData: "GpuPreference=2;"; Flags: uninsdeletevalue
; 卸载表项由 Inno 按 AppId 自动写入（DisplayName/DisplayIcon/UninstallString
; 分别来自 UninstallDisplayName、UninstallDisplayIcon 和内置逻辑）。
; 这里再手写一份 DeepSeek_is1 会让控制面板出现两个同名卸载入口。

[Code]
var
  VersionLabel: TNewStaticText;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if Exec('cmd.exe',
    '/c tasklist /FI "IMAGENAME eq {#MyAppExeName}" | find /I "{#MyAppExeName}" >nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if ResultCode = 0 then
    begin
      if MsgBox('检测到 {#MyAppNameCN} 正在运行。' + #13#10 + #13#10 +
        '是否自动关闭它并继续安装？', mbConfirmation, MB_YESNO) = IDNO then
      begin
        Result := False;
        exit;
      end;
      Exec('taskkill.exe', '/F /IM {#MyAppExeName}', '', SW_HIDE,
        ewWaitUntilTerminated, ResultCode);
      Sleep(1500);
    end;
  end;
end;

procedure InitializeWizard();
begin
  WizardForm.Width := ScaleX(560);
  WizardForm.Height := ScaleY(430);

  { 禁用最大化按钮（Inno 7 通过 BorderIcons 控制）}
  WizardForm.BorderIcons := WizardForm.BorderIcons - [biMaximize];
  WizardForm.BorderStyle := bsDialog;

  VersionLabel := TNewStaticText.Create(WizardForm);
  VersionLabel.Parent := WizardForm;
  VersionLabel.Left := ScaleX(15);
  VersionLabel.Top := WizardForm.ClientHeight - ScaleY(28);
  VersionLabel.Font.Size := 8;
  VersionLabel.Font.Color := clGray;
  VersionLabel.Caption := 'v{#MyAppVersion}';
  VersionLabel.Visible := True;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpWelcome then
  begin
    WizardForm.WelcomeLabel1.Caption := '欢迎安装 {#MyAppNameCN}';
    WizardForm.WelcomeLabel2.Caption :=
      '一款轻量的 AI 对话桌面客户端' + #13#10 + #13#10 +
      '· 系统托盘常驻' + #13#10 +
      '· 全局快捷键唤起' + #13#10 +
      '· AI 工具调用' + #13#10 +
      '· 自动更新' + #13#10 + #13#10 +
      '点击「下一步」开始安装。';
  end;

  if CurPageID = wpSelectTasks then
  begin
    WizardForm.PageNameLabel.Caption := '附加选项';
    WizardForm.PageDescriptionLabel.Caption := '请选择是否创建桌面快捷方式。';
  end;

  if CurPageID = wpSelectDir then
  begin
    WizardForm.PageNameLabel.Caption := '选择安装位置';
    WizardForm.PageDescriptionLabel.Caption := '请选择 {#MyAppNameCN} 的安装位置。';
  end;

  if CurPageID = wpInstalling then
  begin
    WizardForm.PageNameLabel.Caption := '正在安装';
    WizardForm.PageDescriptionLabel.Caption := '正在将文件复制到您的电脑，请稍候...';
  end;

  if CurPageID = wpFinished then
  begin
    WizardForm.PageNameLabel.Caption := '安装完成';
    WizardForm.FinishedLabel.Caption :=
      '{#MyAppNameCN} 已成功安装到您的电脑。' + #13#10 + #13#10 +
      '您现在可以运行它，或点击「完成」退出安装向导。';
  end;
end;
