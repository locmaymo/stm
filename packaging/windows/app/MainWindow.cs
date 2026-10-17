using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SillyTavernManager;

internal sealed class MainWindow : Form
{
    private const string RunRegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunRegistryValueName = "SillyTavernManager";
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaUseImmersiveDarkModeBefore20H1 = 19;
    private const int NimModify = 0x00000001;
    private const int NifInfo = 0x00000010;
    private const int NiifUser = 0x00000004;
    private const int NiifLargeIcon = 0x00000020;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NOTIFYICONDATAW
    {
        public int cbSize;
        public IntPtr hWnd;
        public int uID;
        public int uFlags;
        public int uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szTip;
        public int dwState;
        public int dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string szInfo;
        public int uTimeoutOrVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string szInfoTitle;
        public int dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool IsChild(IntPtr hWndParent, IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Shell_NotifyIconW(int dwMessage, ref NOTIFYICONDATAW lpData);

    private readonly ManagerProcess _manager = new();
    private readonly WebView2 _webView = new();
    private readonly NotifyIcon _trayIcon = new();
    private readonly ContextMenuStrip _trayMenu = new();
    private readonly ToolStripMenuItem _autoStartItem;
    private readonly EventWaitHandle _activateEvent;
    private readonly EventWaitHandle _shutdownEvent;
    private readonly CancellationTokenSource _lifetimeCts = new();
    private readonly JavaScriptSerializer _json = new();
    private readonly string _windowStateFile;

    private CoreWebView2Environment? _webViewEnvironment;
    private Form? _sillyTavernWindow;
    private WebView2? _sillyTavernWebView;
    private IntPtr _lastBalloonHIcon = IntPtr.Zero;
    private bool _webViewReady;
    private bool _quitting;
    private bool _trayHintShown;
    private bool _localeSeeded;
    private bool _replyNotificationsEnabled = true;
    private bool _lastNotificationWasReply;
    private bool _startMinimized;

    public MainWindow(bool startMinimized, EventWaitHandle activateEvent, EventWaitHandle shutdownEvent)
    {
        _startMinimized = startMinimized;
        _activateEvent = activateEvent;
        _shutdownEvent = shutdownEvent;
        _windowStateFile = Path.Combine(_manager.DataDirectory, "desktop-window.json");

        Text = "SillyTavern Manager";
        MinimumSize = new Size(900, 600);
        Size = new Size(1280, 840);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(11, 15, 23);
        ForeColor = Color.FromArgb(241, 245, 249);

        Icon? exeIcon = LoadExecutableIcon();
        if (exeIcon != null)
        {
            Icon = exeIcon;
        }

        RestoreWindowBounds();

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.FromArgb(11, 15, 23);
        Controls.Add(_webView);

        _autoStartItem = new ToolStripMenuItem(
            Program.IsVietnamese ? "Khởi động cùng Windows" : "Start with Windows",
            null,
            (_, _) => ToggleAutoStart())
        {
            Checked = IsAutoStartEnabled(),
        };

        BuildTrayIcon(exeIcon);

        _manager.NotificationReceived += (title, body) =>
        {
            BeginInvoke(new Action(() => ShowTrayNotification(title, body, isReply: false)));
        };
        _manager.EventReceived += (eventType) =>
        {
            if (string.Equals(eventType, "sillytavernStopped", StringComparison.Ordinal))
            {
                BeginInvoke(new Action(CloseSillyTavernWindow));
            }
        };
        _manager.UnexpectedExit += (exitCode) =>
        {
            if (_quitting) return;
            BeginInvoke(new Action(() =>
            {
                string reason = Program.IsVietnamese
                    ? $"Trình quản lý đã dừng đột ngột (mã thoát {exitCode})."
                    : $"The manager stopped unexpectedly (exit code {exitCode}).";
                ShowErrorPage(reason, _manager.GetRecentOutput());
            }));
        };

        Load += OnWindowLoad;
        FormClosing += OnWindowClosing;
        ResizeEnd += (_, _) => SaveWindowBounds();
        LocationChanged += (_, _) => SaveWindowBounds();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyDarkTitleBar(Handle);
    }

    public static void ApplyDarkTitleBar(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return;
        try
        {
            int useDark = 1;
            if (DwmSetWindowAttribute(handle, DwmwaUseImmersiveDarkMode, ref useDark, sizeof(int)) != 0)
            {
                DwmSetWindowAttribute(handle, DwmwaUseImmersiveDarkModeBefore20H1, ref useDark, sizeof(int));
            }
        }
        catch
        {
            // Ignore on older builds.
        }
    }

    private void BuildTrayIcon(Icon? exeIcon)
    {
        var openManagerItem = new ToolStripMenuItem(
            Program.IsVietnamese ? "Mở SillyTavern Manager" : "Open SillyTavern Manager",
            null,
            (_, _) => RestoreAndActivate())
        {
            Font = new Font(SystemFonts.MenuFont ?? Control.DefaultFont, FontStyle.Bold),
        };

        var openStItem = new ToolStripMenuItem(
            Program.IsVietnamese ? "Mở SillyTavern" : "Open SillyTavern",
            null,
            (_, _) => OpenSillyTavernWindow("http://127.0.0.1:8000"));

        var openBrowserItem = new ToolStripMenuItem(
            Program.IsVietnamese ? "Mở trong trình duyệt" : "Open in Browser",
            null,
            (_, _) => OpenExternalUrl(_manager.ManagerUrl));

        var restartItem = new ToolStripMenuItem(
            Program.IsVietnamese ? "Khởi động lại Manager" : "Restart Manager",
            null,
            async (_, _) => await RestartManagerAsync());

        var quitItem = new ToolStripMenuItem(
            Program.IsVietnamese ? "Thoát SillyTavern Manager" : "Quit SillyTavern Manager",
            null,
            async (_, _) => await QuitApplicationAsync());

        _trayMenu.Items.Add(openManagerItem);
        _trayMenu.Items.Add(openStItem);
        _trayMenu.Items.Add(openBrowserItem);
        _trayMenu.Items.Add(new ToolStripSeparator());
        _trayMenu.Items.Add(_autoStartItem);
        _trayMenu.Items.Add(restartItem);
        _trayMenu.Items.Add(new ToolStripSeparator());
        _trayMenu.Items.Add(quitItem);

        _trayIcon.Text = "SillyTavern Manager";
        _trayIcon.Icon = exeIcon ?? SystemIcons.Application;
        _trayIcon.ContextMenuStrip = _trayMenu;
        _trayIcon.Visible = true;
        _trayIcon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
            {
                RestoreAndActivate();
            }
        };
        _trayIcon.DoubleClick += (_, _) => RestoreAndActivate();
        _trayIcon.BalloonTipClicked += (_, _) =>
        {
            if (_lastNotificationWasReply && _sillyTavernWindow is { IsDisposed: false } stWin)
            {
                if (stWin.WindowState == FormWindowState.Minimized)
                {
                    stWin.WindowState = FormWindowState.Normal;
                }
                stWin.Show();
                stWin.BringToFront();
                stWin.Activate();
                return;
            }
            RestoreAndActivate();
        };
    }

    private async void OnWindowLoad(object? sender, EventArgs e)
    {
        StartIpcWatchers();

        if (_startMinimized)
        {
            _startMinimized = false;
            BeginInvoke(new Action(Hide));
        }

        await InitializeWebViewAsync();
        ShowLoadingSplash();

        var (ok, error) = await _manager.StartAsync(_lifetimeCts.Token);
        if (_quitting) return;

        if (!ok)
        {
            string heading = Program.IsVietnamese
                ? "Không thể khởi động SillyTavern Manager."
                : "SillyTavern Manager could not be started.";
            ShowErrorPage(heading, error ?? _manager.GetRecentOutput());
            return;
        }

        NavigateToManager();
    }

    private void StartIpcWatchers()
    {
        Task.Run(() =>
        {
            var handles = new WaitHandle[] { _activateEvent, _lifetimeCts.Token.WaitHandle };
            while (!_lifetimeCts.IsCancellationRequested)
            {
                int index = WaitHandle.WaitAny(handles);
                if (index == 0 && !_quitting && IsHandleCreated)
                {
                    try { BeginInvoke(new Action(RestoreAndActivate)); } catch { }
                }
                else
                {
                    break;
                }
            }
        });

        Task.Run(() =>
        {
            var handles = new WaitHandle[] { _shutdownEvent, _lifetimeCts.Token.WaitHandle };
            int index = WaitHandle.WaitAny(handles);
            if (index == 0 && !_quitting && IsHandleCreated)
            {
                try { BeginInvoke(new Action(async () => await QuitApplicationAsync())); } catch { }
            }
        });
    }

    private async Task InitializeWebViewAsync()
    {
        if (_webViewReady) return;

        string userDataFolder = Path.Combine(_manager.DataDirectory, "webview2");
        Directory.CreateDirectory(userDataFolder);

        var envOptions = new CoreWebView2EnvironmentOptions(
            language: Program.IsVietnamese ? "vi-VN" : "en-US");
        _webViewEnvironment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, envOptions);
        await _webView.EnsureCoreWebView2Async(_webViewEnvironment);

        var core = _webView.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.UserAgent = $"{core.Settings.UserAgent} STMDesktop/{Program.AppVersion}";

        if (Program.IsVietnamese && !_localeSeeded)
        {
            _localeSeeded = true;
            SaveWindowBounds();
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                "(() => { try { if (!sessionStorage.getItem('__stmLocaleSeeded')) { sessionStorage.setItem('__stmLocaleSeeded', '1'); localStorage.setItem('stm-locale', 'vi'); } } catch {} })();");
        }

        await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);

        core.WebMessageReceived += OnWebMessageReceived;
        core.NavigationStarting += OnMainNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;

        _webViewReady = true;
    }

    private const string BridgeScript = @"
(() => {
  if (window.STMApp) return;
  const listeners = new Set();
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
      const msg = new MessageEvent('message', { data });
      for (const fn of [...listeners]) {
        try { fn(msg); } catch (err) { console.error(err); }
      }
    });
  }
  if (window === window.top) {
    window.addEventListener('message', (event) => {
      if (!event.data || event.data.__stmBridgeForward !== true || typeof event.data.payload !== 'string') return;
      try {
        const u = new URL(event.origin);
        if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') {
          window.chrome.webview.postMessage(event.data.payload);
        }
      } catch {}
    });
  }
  window.STMApp = {
    postMessage(message) {
      const payload = String(message);
      if (window !== window.top) {
        try {
          window.top.postMessage({ __stmBridgeForward: true, payload }, '*');
          return;
        } catch {}
      }
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(payload);
      }
    },
    addEventListener(type, listener) {
      if (type === 'message' && typeof listener === 'function') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener);
    }
  };

  if (window.__stmChatBridge) return;
  if (location.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(location.hostname)) return;
  window.__stmChatBridge = true;

  const MAX_TEXT = 400;
  const AVATAR_SIZE = 128;
  const avatars = new Map();

  function context() {
    const tavern = globalThis.SillyTavern;
    return tavern && typeof tavern.getContext === 'function' ? tavern.getContext() : null;
  }

  function wordsOf(index, message) {
    const shown = document.querySelector(`#chat .mes[mesid=""${index}""] .mes_text`);
    const words = shown ? shown.innerText : String(message.mes ?? '');
    return words.trim().slice(0, MAX_TEXT);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('load failed'));
      img.src = src;
    });
  }

  async function renderCircularPng(src) {
    if (!src) return '';
    if (avatars.has(src)) return avatars.get(src);
    try {
      const img = await loadImage(src);
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) return '';
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const c = canvas.getContext('2d');
      if (!c) return '';
      c.beginPath();
      c.arc(AVATAR_SIZE / 2, AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
      c.closePath();
      c.clip();
      const side = Math.min(w, h);
      const sx = (w - side) / 2;
      const sy = (h - side) / 2;
      c.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      const dataUrl = canvas.toDataURL('image/png');
      avatars.set(src, dataUrl);
      return dataUrl;
    } catch {
      return '';
    }
  }

  async function resolveAvatar(index, speakerFile) {
    const domImg = document.querySelector(`#chat .mes[mesid=""${index}""] .avatar img`);
    const domSrc = domImg && domImg.src ? domImg.src : '';
    const thumbSrc = speakerFile ? `/thumbnail?type=avatar&file=${encodeURIComponent(speakerFile)}` : '';
    const first = await renderCircularPng(domSrc || thumbSrc);
    if (first || !domSrc || !thumbSrc || domSrc === thumbSrc) return first;
    return await renderCircularPng(thumbSrc);
  }

  async function report(index) {
    const ctx = context();
    const message = ctx?.chat?.[index];
    if (!message || message.is_user || message.is_system) return;
    const words = wordsOf(index, message);
    if (!words) return;
    const group = ctx.groupId ? (ctx.groups ?? []).find((item) => item.id === ctx.groupId) : null;
    const character = !group && ctx.characterId !== undefined ? ctx.characters?.[ctx.characterId] : null;
    const key = group ? `g:${group.id}` : character ? `c:${character.avatar}` : '';
    if (!key) return;
    const speaker = group
      ? message.original_avatar || (ctx.characters ?? []).find((item) => item.name === message.name)?.avatar
      : character.avatar;
    const avatar = await resolveAvatar(index, speaker);
    window.STMApp.postMessage(JSON.stringify({
      type: 'reply',
      key,
      title: String(group ? group.name : character.name),
      group: Boolean(group),
      name: String(message.name ?? ''),
      text: words,
      avatar,
    }));
  }

  function hook() {
    const ctx = context();
    const rendered = ctx?.eventTypes?.CHARACTER_MESSAGE_RENDERED;
    if (!ctx?.eventSource || !rendered) return false;
    ctx.eventSource.on(rendered, (index) => { void report(Number(index)); });
    return true;
  }

  let tries = 0;
  const timer = setInterval(() => { if (hook() || ++tries >= 120) clearInterval(timer); }, 1000);
})();
";

    private void OnMainNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (string.IsNullOrEmpty(e.Uri)) return;

        if (e.Uri.StartsWith("stm-action://", StringComparison.OrdinalIgnoreCase))
        {
            e.Cancel = true;
            if (e.Uri.StartsWith("stm-action://restart", StringComparison.OrdinalIgnoreCase))
            {
                _ = RestartManagerAsync();
            }
            else if (e.Uri.StartsWith("stm-action://open-data", StringComparison.OrdinalIgnoreCase))
            {
                Directory.CreateDirectory(_manager.DataDirectory);
                OpenExternalUrl(_manager.DataDirectory);
            }
            return;
        }

        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)) return;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return;

        if (!IsLoopbackHost(uri.Host))
        {
            e.Cancel = true;
            OpenExternalUrl(e.Uri);
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        string targetUri = e.Uri ?? string.Empty;
        if (Uri.TryCreate(targetUri, UriKind.Absolute, out var parsed)
            && (parsed.Scheme == Uri.UriSchemeHttp || parsed.Scheme == Uri.UriSchemeHttps)
            && !IsLoopbackHost(parsed.Host))
        {
            e.Handled = true;
            OpenExternalUrl(targetUri);
            return;
        }

        var deferral = e.GetDeferral();
        e.Handled = true;
        BeginInvoke(new Action(async () =>
        {
            try
            {
                var childCore = await EnsureSillyTavernWebViewAsync(string.IsNullOrEmpty(targetUri) ? null : targetUri);
                if (childCore != null)
                {
                    e.NewWindow = childCore;
                }
            }
            finally
            {
                deferral.Complete();
            }
        }));
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string raw;
        try
        {
            raw = e.TryGetWebMessageAsString();
        }
        catch
        {
            return;
        }

        if (string.IsNullOrEmpty(raw)) return;
        IDictionary<string, object>? message;
        try
        {
            message = _json.DeserializeObject(raw) as IDictionary<string, object>;
        }
        catch
        {
            return;
        }
        if (message == null || !message.TryGetValue("type", out var typeObj) || typeObj is not string type)
        {
            return;
        }

        switch (type)
        {
            case "features":
                PostToWebView(_json.Serialize(new Dictionary<string, object>
                {
                    ["type"] = "features",
                    ["importZip"] = true,
                    ["termux"] = false,
                    ["termuxOffer"] = false,
                    ["appUpdate"] = true,
                }));
                break;

            case "bubbles":
                if (message.TryGetValue("replies", out var repliesObj) && repliesObj is bool repliesEnabled)
                {
                    _replyNotificationsEnabled = repliesEnabled;
                    SaveWindowBounds();
                }
                PostToWebView(_json.Serialize(new Dictionary<string, object>
                {
                    ["type"] = "bubbles",
                    ["replies"] = _replyNotificationsEnabled,
                    ["enabled"] = false,
                    ["bubbles"] = false,
                    ["allowed"] = false,
                }));
                break;

            case "reply":
                if (!_replyNotificationsEnabled) break;
                {
                    Form? sourceForm = ReferenceEquals(sender, _sillyTavernWebView?.CoreWebView2)
                        ? _sillyTavernWindow
                        : this;
                    if (IsFormInForeground(sourceForm)) break;

                    string title = message.TryGetValue("title", out var tObj) && tObj is string ts ? ts.Trim() : string.Empty;
                    string name = message.TryGetValue("name", out var nObj) && nObj is string ns ? ns.Trim() : string.Empty;
                    bool isGroup = message.TryGetValue("group", out var gObj) && gObj is bool gb && gb;
                    string text = message.TryGetValue("text", out var txObj) && txObj is string txs ? txs.Trim() : string.Empty;
                    string avatar = message.TryGetValue("avatar", out var avObj) && avObj is string avs ? avs.Trim() : string.Empty;
                    if (string.IsNullOrEmpty(text)) break;

                    string speaker = isGroup && !string.IsNullOrEmpty(name) && !string.Equals(name, title, StringComparison.Ordinal)
                        ? $"{name} · {title}"
                        : (!string.IsNullOrEmpty(name) ? name : (!string.IsNullOrEmpty(title) ? title : "SillyTavern"));
                    string preview = CollapseWhitespace(text, 160);
                    ShowTrayNotification(speaker, preview, isReply: true, avatarDataUrl: avatar);
                }
                break;

            case "open":
                if (message.TryGetValue("url", out var urlObj) && urlObj is string url && !string.IsNullOrEmpty(url))
                {
                    OpenSillyTavernWindow(url);
                }
                break;

            case "importZip":
                {
                    string csrf = message.TryGetValue("csrf", out var csrfObj) && csrfObj is string c ? c : string.Empty;
                    string cookieHeader = await GetCookieHeaderAsync(_manager.ManagerUrl);
                    BackupImport.PickAndUpload(this, _manager.ManagerUrl, csrf, cookieHeader, PostToWebView);
                }
                break;

            case "importCancel":
                BackupImport.Cancel();
                break;

            case "appUpdate":
                if (message.TryGetValue("version", out var verObj) && verObj is string version)
                {
                    WindowsAppUpdate.Start(version, _manager.DataDirectory, PostToWebView, installerPath =>
                    {
                        BeginInvoke(new Action(async () => await ApplyAppUpdateAsync(installerPath)));
                    });
                }
                break;

            case "appUpdateCancel":
                WindowsAppUpdate.Cancel();
                break;
        }
    }

    private async Task<string> GetCookieHeaderAsync(string url)
    {
        if (!_webViewReady || _webView.CoreWebView2 == null) return string.Empty;
        try
        {
            var cookies = await _webView.CoreWebView2.CookieManager.GetCookiesAsync(url);
            if (cookies == null || cookies.Count == 0) return string.Empty;
            var parts = new List<string>(cookies.Count);
            foreach (var c in cookies)
            {
                parts.Add($"{c.Name}={c.Value}");
            }
            return string.Join("; ", parts);
        }
        catch
        {
            return string.Empty;
        }
    }

    private void PostToWebView(string jsonMessage)
    {
        if (_quitting || !IsHandleCreated) return;
        if (InvokeRequired)
        {
            try { BeginInvoke(new Action(() => PostToWebView(jsonMessage))); } catch { }
            return;
        }
        try
        {
            if (_webViewReady && _webView.CoreWebView2 != null)
            {
                _webView.CoreWebView2.PostWebMessageAsString(jsonMessage);
            }
        }
        catch
        {
        }
    }

    private void OpenSillyTavernWindow(string url)
    {
        _ = EnsureSillyTavernWebViewAsync(url);
    }

    private async Task<CoreWebView2?> EnsureSillyTavernWebViewAsync(string? navigateUrl)
    {
        if (_webViewEnvironment == null) return null;

        if (_sillyTavernWindow == null || _sillyTavernWindow.IsDisposed || _sillyTavernWebView == null)
        {
            var stWebView = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.FromArgb(11, 15, 23),
            };
            var stForm = new Form
            {
                Text = "SillyTavern",
                Size = new Size(1280, 860),
                MinimumSize = new Size(800, 560),
                StartPosition = FormStartPosition.CenterScreen,
                BackColor = Color.FromArgb(11, 15, 23),
                Icon = Icon,
            };
            stForm.HandleCreated += (_, _) => ApplyDarkTitleBar(stForm.Handle);
            stForm.Controls.Add(stWebView);
            stForm.FormClosed += (_, _) =>
            {
                _sillyTavernWebView = null;
                _sillyTavernWindow = null;
            };

            _sillyTavernWindow = stForm;
            _sillyTavernWebView = stWebView;
            stForm.Show();

            await stWebView.EnsureCoreWebView2Async(_webViewEnvironment);
            var core = stWebView.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.UserAgent = $"{core.Settings.UserAgent} STMDesktop/{Program.AppVersion}";
            await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);
            core.WebMessageReceived += OnWebMessageReceived;
            core.DocumentTitleChanged += (_, _) =>
            {
                string title = core.DocumentTitle;
                if (!string.IsNullOrWhiteSpace(title) && !stForm.IsDisposed)
                {
                    stForm.Text = title;
                }
            };
            core.NavigationStarting += (_, navArgs) =>
            {
                if (Uri.TryCreate(navArgs.Uri, UriKind.Absolute, out var uri)
                    && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
                    && !IsLoopbackHost(uri.Host))
                {
                    navArgs.Cancel = true;
                    OpenExternalUrl(navArgs.Uri);
                    if (string.IsNullOrEmpty(core.Source) || core.Source == "about:blank")
                    {
                        stForm.Close();
                    }
                }
            };
            core.NewWindowRequested += OnNewWindowRequested;
        }
        else
        {
            if (_sillyTavernWindow.WindowState == FormWindowState.Minimized)
            {
                _sillyTavernWindow.WindowState = FormWindowState.Normal;
            }
            _sillyTavernWindow.Show();
            _sillyTavernWindow.BringToFront();
            _sillyTavernWindow.Activate();
        }

        if (!string.IsNullOrEmpty(navigateUrl)
            && !string.Equals(navigateUrl, "about:blank", StringComparison.OrdinalIgnoreCase)
            && _sillyTavernWebView.CoreWebView2 != null)
        {
            _sillyTavernWebView.CoreWebView2.Navigate(navigateUrl);
        }

        return _sillyTavernWebView.CoreWebView2;
    }

    private void CloseSillyTavernWindow()
    {
        if (_sillyTavernWindow is { IsDisposed: false } win)
        {
            try { win.Close(); } catch { }
        }
        _sillyTavernWindow = null;
        _sillyTavernWebView = null;
    }

    private void NavigateToManager()
    {
        if (!_webViewReady || _webView.CoreWebView2 == null) return;
        _webView.CoreWebView2.Navigate(_manager.ManagerUrl);
    }

    private void ShowLoadingSplash()
    {
        if (!_webViewReady || _webView.CoreWebView2 == null) return;
        string subtitle = Program.IsVietnamese
            ? "Đang khởi động trình quản lý…"
            : "Starting the manager…";
        string html = $@"<!doctype html>
<html lang=""{(Program.IsVietnamese ? "vi" : "en")}"" class=""dark"">
<head>
<meta charset=""utf-8"">
<style>
  html, body {{
    margin: 0; height: 100%; background: #0b0f17; color: #f1f5f9;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center;
    user-select: none;
  }}
  .box {{ display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; }}
  .spinner {{
    width: 28px; height: 28px; border-radius: 50%;
    border: 2.5px solid rgba(255,255,255,0.12);
    border-top-color: #60a5fa;
    animation: spin 0.8s linear infinite;
  }}
  .title {{ font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }}
  .sub {{ font-size: 13px; color: #94a3b8; }}
  @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
</style>
</head>
<body>
  <div class=""box"">
    <div class=""spinner""></div>
    <div class=""title"">SillyTavern Manager</div>
    <div class=""sub"">{WebUtility.HtmlEncode(subtitle)}</div>
  </div>
</body>
</html>";
        _webView.CoreWebView2.NavigateToString(html);
    }

    private void ShowErrorPage(string reason, string details)
    {
        if (!_webViewReady || _webView.CoreWebView2 == null) return;
        RestoreAndActivate();

        string restartLabel = Program.IsVietnamese ? "Khởi động lại Manager" : "Restart Manager";
        string openDataLabel = Program.IsVietnamese ? "Mở thư mục dữ liệu" : "Open data folder";
        string logHeading = Program.IsVietnamese ? "Nhật ký gần nhất:" : "Recent output:";
        string safeDetails = string.IsNullOrWhiteSpace(details)
            ? (Program.IsVietnamese ? "(Không có dòng đầu ra nào)" : "(No output captured)")
            : details;

        string html = $@"<!doctype html>
<html lang=""{(Program.IsVietnamese ? "vi" : "en")}"" class=""dark"">
<head>
<meta charset=""utf-8"">
<style>
  html, body {{
    margin: 0; height: 100%; background: #0b0f17; color: #f1f5f9;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center;
  }}
  .card {{
    width: min(640px, calc(100vw - 48px));
    background: #111827; border: 1px solid #1f2937; border-radius: 14px;
    padding: 24px; display: flex; flex-direction: column; gap: 16px;
  }}
  h1 {{ margin: 0; font-size: 17px; font-weight: 600; color: #f87171; }}
  p {{ margin: 0; font-size: 13.5px; color: #cbd5e1; line-height: 1.5; }}
  pre {{
    margin: 0; padding: 12px; border-radius: 8px;
    background: #090d14; border: 1px solid #1e293b;
    color: #cbd5e1; font-family: Consolas, monospace; font-size: 12px;
    max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  }}
  .actions {{ display: flex; gap: 10px; flex-wrap: wrap; }}
  a.btn {{
    display: inline-flex; align-items: center; justify-content: center;
    padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
    text-decoration: none; cursor: pointer;
  }}
  a.primary {{ background: #2563eb; color: #ffffff; }}
  a.primary:hover {{ background: #1d4ed8; }}
  a.secondary {{ background: #1e293b; color: #e2e8f0; border: 1px solid #334155; }}
  a.secondary:hover {{ background: #334155; }}
</style>
</head>
<body>
  <div class=""card"">
    <h1>SillyTavern Manager</h1>
    <p>{WebUtility.HtmlEncode(reason)}</p>
    <p style=""font-size:12px;color:#94a3b8"">{WebUtility.HtmlEncode(logHeading)}</p>
    <pre>{WebUtility.HtmlEncode(safeDetails)}</pre>
    <div class=""actions"">
      <a class=""btn primary"" href=""stm-action://restart"">{WebUtility.HtmlEncode(restartLabel)}</a>
      <a class=""btn secondary"" href=""stm-action://open-data"">{WebUtility.HtmlEncode(openDataLabel)}</a>
    </div>
  </div>
</body>
</html>";
        _webView.CoreWebView2.NavigateToString(html);
    }

    private async Task RestartManagerAsync()
    {
        ShowLoadingSplash();
        await _manager.StopAsync();
        var (ok, error) = await _manager.StartAsync(_lifetimeCts.Token);
        if (!ok)
        {
            string heading = Program.IsVietnamese
                ? "Không thể khởi động lại SillyTavern Manager."
                : "SillyTavern Manager could not be restarted.";
            ShowErrorPage(heading, error ?? _manager.GetRecentOutput());
            return;
        }
        NavigateToManager();
    }

    private async Task ApplyAppUpdateAsync(string installerPath)
    {
        _quitting = true;
        SaveWindowBounds();
        _trayIcon.Visible = false;
        CloseSillyTavernWindow();
        await _manager.StopAsync();

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = installerPath,
                Arguments = "/S /LAUNCH=1",
                UseShellExecute = false,
            });
        }
        catch
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = installerPath,
                    UseShellExecute = true,
                });
            }
            catch { }
        }

        _lifetimeCts.Cancel();
        Application.Exit();
    }

    private async Task QuitApplicationAsync()
    {
        if (_quitting) return;
        _quitting = true;
        SaveWindowBounds();
        Hide();
        CloseSillyTavernWindow();
        _trayIcon.Visible = false;
        await _manager.StopAsync();
        _lifetimeCts.Cancel();
        Application.Exit();
    }

    private void OnWindowClosing(object? sender, FormClosingEventArgs e)
    {
        if (!_quitting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            SaveWindowBounds();
            Hide();

            if (!_trayHintShown)
            {
                _trayHintShown = true;
                SaveWindowBounds();
                string title = "SillyTavern Manager";
                string body = Program.IsVietnamese
                    ? "ST Manager vẫn đang chạy dưới khay hệ thống. Nhấp chuột phải vào biểu tượng ở góc dưới bên phải và chọn Thoát khi bạn muốn tắt hẳn."
                    : "ST Manager is still running in the system tray. Right-click the tray icon and choose Quit when you want to stop everything.";
                ShowTrayNotification(title, body, isReply: false);
            }
            return;
        }

        if (!_quitting)
        {
            // Windows is shutting down or logging off: stop manager synchronously.
            _quitting = true;
            _trayIcon.Visible = false;
            Task.Run(() => _manager.StopAsync()).Wait(10_000);
            _lifetimeCts.Cancel();
        }
    }

    private void RestoreAndActivate()
    {
        if (!Visible)
        {
            Show();
        }
        if (WindowState == FormWindowState.Minimized)
        {
            WindowState = FormWindowState.Normal;
        }
        BringToFront();
        Activate();
    }

    private void ShowTrayNotification(string title, string body, bool isReply, string? avatarDataUrl = null)
    {
        try
        {
            _lastNotificationWasReply = isReply;
            string safeTitle = string.IsNullOrWhiteSpace(title) ? "SillyTavern Manager" : title.Trim();
            string safeBody = string.IsNullOrWhiteSpace(body) ? safeTitle : body.Trim();
            if (safeTitle.Length > 60) safeTitle = safeTitle.Substring(0, 59) + "…";
            if (safeBody.Length > 240) safeBody = safeBody.Substring(0, 239) + "…";

            if (_lastBalloonHIcon != IntPtr.Zero)
            {
                DestroyIcon(_lastBalloonHIcon);
                _lastBalloonHIcon = IntPtr.Zero;
            }

            IntPtr customIcon = CreateIconFromDataUrl(avatarDataUrl);
            if (customIcon != IntPtr.Zero)
            {
                _lastBalloonHIcon = customIcon;
            }

            IntPtr balloonIcon = customIcon != IntPtr.Zero
                ? customIcon
                : (_trayIcon.Icon?.Handle ?? IntPtr.Zero);

            if (balloonIcon != IntPtr.Zero && TryShowCustomBalloon(safeTitle, safeBody, balloonIcon))
            {
                return;
            }

            _trayIcon.ShowBalloonTip(5000, safeTitle, safeBody, ToolTipIcon.Info);
        }
        catch
        {
        }
    }

    private bool TryShowCustomBalloon(string title, string body, IntPtr balloonIcon)
    {
        try
        {
            FieldInfo? windowField = typeof(NotifyIcon).GetField("window", BindingFlags.Instance | BindingFlags.NonPublic);
            FieldInfo? idField = typeof(NotifyIcon).GetField("id", BindingFlags.Instance | BindingFlags.NonPublic);
            if (windowField?.GetValue(_trayIcon) is not NativeWindow nativeWindow || nativeWindow.Handle == IntPtr.Zero)
            {
                return false;
            }
            if (idField?.GetValue(_trayIcon) is not int iconId)
            {
                return false;
            }

            var data = new NOTIFYICONDATAW
            {
                cbSize = Marshal.SizeOf(typeof(NOTIFYICONDATAW)),
                hWnd = nativeWindow.Handle,
                uID = iconId,
                uFlags = NifInfo,
                szInfoTitle = title,
                szInfo = body,
                uTimeoutOrVersion = 5000,
                dwInfoFlags = NiifUser | NiifLargeIcon,
                hBalloonIcon = balloonIcon,
            };

            return Shell_NotifyIconW(NimModify, ref data);
        }
        catch
        {
            return false;
        }
    }

    private static IntPtr CreateIconFromDataUrl(string? dataUrl)
    {
        if (string.IsNullOrWhiteSpace(dataUrl)) return IntPtr.Zero;
        const string prefix = "base64,";
        int idx = dataUrl!.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);
        if (idx < 0) return IntPtr.Zero;
        try
        {
            byte[] bytes = Convert.FromBase64String(dataUrl.Substring(idx + prefix.Length));
            using var ms = new MemoryStream(bytes);
            using var bmp = new Bitmap(ms);
            return bmp.GetHicon();
        }
        catch
        {
            return IntPtr.Zero;
        }
    }

    private static bool IsFormInForeground(Form? form)
    {
        if (form == null || form.IsDisposed || !form.Visible || form.WindowState == FormWindowState.Minimized)
        {
            return false;
        }
        try
        {
            IntPtr fg = GetForegroundWindow();
            if (fg == IntPtr.Zero) return false;
            return fg == form.Handle || IsChild(form.Handle, fg);
        }
        catch
        {
            return Form.ActiveForm == form;
        }
    }

    private static string CollapseWhitespace(string input, int maxLength)
    {
        var sb = new StringBuilder(Math.Min(input.Length, maxLength + 4));
        bool inSpace = false;
        foreach (char ch in input)
        {
            if (char.IsWhiteSpace(ch))
            {
                if (sb.Length > 0 && !inSpace)
                {
                    sb.Append(' ');
                    inSpace = true;
                }
            }
            else
            {
                sb.Append(ch);
                inSpace = false;
            }
            if (sb.Length >= maxLength)
            {
                return sb.ToString().TrimEnd() + "…";
            }
        }
        return sb.ToString().Trim();
    }

    private bool IsAutoStartEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunRegistryPath, writable: false);
            return key?.GetValue(RunRegistryValueName) is string value && !string.IsNullOrWhiteSpace(value);
        }
        catch
        {
            return false;
        }
    }

    private void ToggleAutoStart()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunRegistryPath, writable: true);
            if (key == null) return;
            if (IsAutoStartEnabled())
            {
                key.DeleteValue(RunRegistryValueName, throwOnMissingValue: false);
                _autoStartItem.Checked = false;
            }
            else
            {
                string exePath = Application.ExecutablePath;
                key.SetValue(RunRegistryValueName, $"\"{exePath}\" --minimized", RegistryValueKind.String);
                _autoStartItem.Checked = true;
            }
        }
        catch
        {
        }
    }

    private void RestoreWindowBounds()
    {
        try
        {
            if (!File.Exists(_windowStateFile)) return;
            string raw = File.ReadAllText(_windowStateFile, Encoding.UTF8);
            if (_json.DeserializeObject(raw) is not IDictionary<string, object> state) return;

            if (state.TryGetValue("trayHintShown", out var hintVal) && hintVal is bool hs)
            {
                _trayHintShown = hs;
            }
            if (state.TryGetValue("localeSeeded", out var locVal) && locVal is bool ls)
            {
                _localeSeeded = ls;
            }
            if (state.TryGetValue("replyNotificationsEnabled", out var repVal) && repVal is bool re)
            {
                _replyNotificationsEnabled = re;
            }

            int width = state.TryGetValue("width", out var w) ? Convert.ToInt32(w) : Width;
            int height = state.TryGetValue("height", out var h) ? Convert.ToInt32(h) : Height;
            int x = state.TryGetValue("x", out var xv) ? Convert.ToInt32(xv) : int.MinValue;
            int y = state.TryGetValue("y", out var yv) ? Convert.ToInt32(yv) : int.MinValue;
            bool maximized = state.TryGetValue("maximized", out var mv) && mv is bool m && m;

            if (width >= MinimumSize.Width && height >= MinimumSize.Height)
            {
                var candidate = new Rectangle(x, y, width, height);
                if (x != int.MinValue && y != int.MinValue && IsVisibleOnAnyScreen(candidate))
                {
                    StartPosition = FormStartPosition.Manual;
                    DesktopBounds = candidate;
                }
                else
                {
                    Size = new Size(width, height);
                }
            }

            if (maximized)
            {
                WindowState = FormWindowState.Maximized;
            }
        }
        catch
        {
        }
    }

    private void SaveWindowBounds()
    {
        try
        {
            Directory.CreateDirectory(_manager.DataDirectory);
            Rectangle bounds = WindowState == FormWindowState.Normal ? DesktopBounds : RestoreBounds;
            var payload = new Dictionary<string, object>
            {
                ["x"] = bounds.X,
                ["y"] = bounds.Y,
                ["width"] = Math.Max(bounds.Width, MinimumSize.Width),
                ["height"] = Math.Max(bounds.Height, MinimumSize.Height),
                ["maximized"] = WindowState == FormWindowState.Maximized,
                ["trayHintShown"] = _trayHintShown,
                ["localeSeeded"] = _localeSeeded,
                ["replyNotificationsEnabled"] = _replyNotificationsEnabled,
            };
            File.WriteAllText(_windowStateFile, _json.Serialize(payload), new UTF8Encoding(false));
        }
        catch
        {
        }
    }

    private static bool IsVisibleOnAnyScreen(Rectangle rect)
    {
        foreach (var screen in Screen.AllScreens)
        {
            var intersection = Rectangle.Intersect(screen.WorkingArea, rect);
            if (intersection.Width >= 120 && intersection.Height >= 80)
            {
                return true;
            }
        }
        return false;
    }

    private static bool IsLoopbackHost(string host)
    {
        return string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "[::1]", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "::1", StringComparison.OrdinalIgnoreCase);
    }

    private static void OpenExternalUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });
        }
        catch
        {
        }
    }

    private static Icon? LoadExecutableIcon()
    {
        try
        {
            return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
            return null;
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (_lastBalloonHIcon != IntPtr.Zero)
            {
                DestroyIcon(_lastBalloonHIcon);
                _lastBalloonHIcon = IntPtr.Zero;
            }
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            _trayMenu.Dispose();
            _webView.Dispose();
            _manager.Dispose();
            _lifetimeCts.Dispose();
        }
        base.Dispose(disposing);
    }
}
