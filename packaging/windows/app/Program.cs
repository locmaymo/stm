using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;

namespace SillyTavernManager;

internal static class Program
{
    public const string AppId = "top.locmaymo.stm";
    private const string MutexName = @"Local\SillyTavernManager.SingleInstance";
    private const string ActivateEventName = @"Local\SillyTavernManager.ActivateEvent";
    private const string ShutdownEventName = @"Local\SillyTavernManager.ShutdownEvent";
    private const string WebView2BootstrapperUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appID);

    public static string AppVersion { get; } =
        typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(Program).Assembly.GetName().Version?.ToString(3)
        ?? "1.0.0";

    public static bool IsVietnamese { get; } = DetectVietnamese();

    private static bool DetectVietnamese()
    {
        try
        {
            if ((CultureInfo.CurrentUICulture.Name ?? string.Empty).StartsWith("vi", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
            if ((CultureInfo.CurrentCulture.Name ?? string.Empty).StartsWith("vi", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
            if (string.Equals(RegionInfo.CurrentRegion.TwoLetterISORegionName, "VN", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
            using (var geoKey = Registry.CurrentUser.OpenSubKey(@"Control Panel\International\Geo", writable: false))
            {
                string? geoName = geoKey?.GetValue("Name") as string;
                string? geoNation = geoKey?.GetValue("Nation") as string;
                if (string.Equals(geoName, "VN", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(geoNation, "251", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            if (string.Equals(TimeZoneInfo.Local.Id, "SE Asia Standard Time", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        catch
        {
        }
        return false;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)3072;
        try
        {
            SetCurrentProcessExplicitAppUserModelID(AppId);
        }
        catch
        {
            // Non-fatal on older shells.
        }

        bool requestShutdown = false;
        bool startMinimized = false;
        foreach (string arg in args)
        {
            if (string.Equals(arg, "--shutdown", StringComparison.OrdinalIgnoreCase))
            {
                requestShutdown = true;
            }
            else if (string.Equals(arg, "--minimized", StringComparison.OrdinalIgnoreCase))
            {
                startMinimized = true;
            }
        }

        if (requestShutdown)
        {
            SignalRunningInstanceToShutDown();
            return 0;
        }

        using var mutex = new Mutex(true, MutexName, out bool createdNew);
        if (!createdNew)
        {
            SignalRunningInstanceToActivate();
            return 0;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        if (!EnsureWebView2Runtime())
        {
            return 1;
        }

        using var activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ActivateEventName);
        using var shutdownEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShutdownEventName);
        using var mainWindow = new MainWindow(startMinimized, activateEvent, shutdownEvent);
        Application.Run(mainWindow);
        return 0;
    }

    private static void SignalRunningInstanceToActivate()
    {
        try
        {
            using var ev = EventWaitHandle.OpenExisting(ActivateEventName);
            ev.Set();
        }
        catch
        {
            // Running instance is starting or already exiting.
        }
    }

    private static void SignalRunningInstanceToShutDown()
    {
        try
        {
            using var ev = EventWaitHandle.OpenExisting(ShutdownEventName);
            ev.Set();
        }
        catch
        {
            return;
        }

        // Wait up to 25 seconds for the existing instance to release the single-instance mutex.
        var deadline = DateTime.UtcNow.AddSeconds(25);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var probe = new Mutex(true, MutexName, out bool free);
                if (free)
                {
                    probe.ReleaseMutex();
                    return;
                }
            }
            catch
            {
                return;
            }
            Thread.Sleep(200);
        }
    }

    private static bool EnsureWebView2Runtime()
    {
        try
        {
            string? version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            if (!string.IsNullOrEmpty(version))
            {
                return true;
            }
        }
        catch
        {
            // Fall through to bootstrapper.
        }

        string title = IsVietnamese ? "SillyTavern Manager — Thành phần hiển thị" : "SillyTavern Manager — WebView2 Runtime";
        string prompt = IsVietnamese
            ? "Windows cần cài đặt thành phần Microsoft Edge WebView2 Runtime (miễn phí của Microsoft) để mở giao diện ứng dụng.\n\nBạn có muốn tự động tải và cài đặt ngay bây giờ không?"
            : "Microsoft Edge WebView2 Runtime is required to display the application window.\n\nWould you like to download and install it automatically now?";

        var answer = MessageBox.Show(prompt, title, MessageBoxButtons.YesNo, MessageBoxIcon.Information);
        if (answer != DialogResult.Yes)
        {
            return false;
        }

        string tempSetup = Path.Combine(Path.GetTempPath(), $"MicrosoftEdgeWebview2Setup-{Guid.NewGuid():N}.exe");
        try
        {
            using (var client = new WebClient())
            {
                client.DownloadFile(WebView2BootstrapperUrl, tempSetup);
            }

            using var proc = Process.Start(new ProcessStartInfo
            {
                FileName = tempSetup,
                Arguments = "/install",
                UseShellExecute = true,
            });
            proc?.WaitForExit();

            string? installedVersion = CoreWebView2Environment.GetAvailableBrowserVersionString();
            return !string.IsNullOrEmpty(installedVersion);
        }
        catch (Exception ex)
        {
            string failMsg = IsVietnamese
                ? $"Không thể cài đặt Microsoft Edge WebView2 Runtime: {ex.Message}"
                : $"Could not install Microsoft Edge WebView2 Runtime: {ex.Message}";
            MessageBox.Show(failMsg, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
        finally
        {
            try { if (File.Exists(tempSetup)) File.Delete(tempSetup); } catch { }
        }
    }
}
