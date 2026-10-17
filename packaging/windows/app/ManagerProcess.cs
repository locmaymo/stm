using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace SillyTavernManager;

internal sealed class ManagerProcess : IDisposable
{
    private const string NotifyPrefix = "STM-NOTIFY ";
    private const string EventPrefix = "STM-EVENT ";
    private const int DefaultPort = 7860;
    private const int ReadyTimeoutMs = 180_000;
    private const int GracefulStopMs = 20_000;
    private const int MaxRecentLines = 80;

    private readonly object _gate = new();
    private readonly Queue<string> _recentLines = new();
    private readonly JavaScriptSerializer _json = new();
    private Process? _process;
    private bool _stopping;

    public string BaseDirectory { get; }
    public string PackagedRoot { get; }
    public string ApplicationRoot { get; }
    public string StaticRoot { get; }
    public string NodeBinary { get; }
    public string DataDirectory { get; }
    public int ManagerPort { get; private set; } = DefaultPort;
    public string ManagerUrl => $"http://127.0.0.1:{ManagerPort}";
    public string ShutdownToken { get; }
    public bool IsRunning => _process is { HasExited: false };

    public event Action<string, string>? NotificationReceived;
    public event Action<string>? EventReceived;
    public event Action<int>? UnexpectedExit;

    public ManagerProcess()
    {
        BaseDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        PackagedRoot = Path.Combine(BaseDirectory, "resources");
        bool isPackaged = Directory.Exists(Path.Combine(PackagedRoot, "app"));

        ApplicationRoot = Environment.GetEnvironmentVariable("STM_APP_ROOT")
            ?? (isPackaged ? Path.Combine(PackagedRoot, "app") : Path.GetFullPath(Path.Combine(BaseDirectory, "..", "..", "..")));
        StaticRoot = Environment.GetEnvironmentVariable("STM_STATIC_ROOT")
            ?? (isPackaged ? Path.Combine(PackagedRoot, "panel") : Path.Combine(ApplicationRoot, "apps", "manager-panel", "dist"));

        string packagedNode = Path.Combine(PackagedRoot, "runtime", "node.exe");
        NodeBinary = Environment.GetEnvironmentVariable("STM_NODE_BINARY")
            ?? (File.Exists(packagedNode) ? packagedNode : "node.exe");

        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        DataDirectory = Environment.GetEnvironmentVariable("STM_DATA_DIR")
            ?? Path.Combine(localAppData, "SillyTavernManager");

        byte[] tokenBytes = new byte[24];
        using (var rng = RandomNumberGenerator.Create())
        {
            rng.GetBytes(tokenBytes);
        }
        ShutdownToken = Convert.ToBase64String(tokenBytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }

    public async Task<(bool Ok, string? Error)> StartAsync(CancellationToken cancellationToken)
    {
        _stopping = false;
        lock (_gate)
        {
            _recentLines.Clear();
        }

        string? envPortText = Environment.GetEnvironmentVariable("STM_PORT");
        bool pinnedPort = int.TryParse(envPortText, out int configuredPort) && configuredPort >= 1024 && configuredPort <= 65535;
        int initialPort = pinnedPort ? configuredPort : DefaultPort;

        if (!IsPortFree(initialPort))
        {
            if (pinnedPort)
            {
                return (false, Program.IsVietnamese
                    ? $"Cổng {initialPort} (STM_PORT) đang được chương trình khác sử dụng."
                    : $"Port {initialPort} (STM_PORT) is already in use by another program.");
            }

            int? nextPort = FindNextFreePort(initialPort + 1);
            if (nextPort == null)
            {
                return (false, Program.IsVietnamese
                    ? $"Cổng {initialPort} đang bận và không tìm thấy cổng trống lân cận."
                    : $"Port {initialPort} is in use and no free port was found nearby.");
            }
            ManagerPort = nextPort.Value;
        }
        else
        {
            ManagerPort = initialPort;
        }

        string compiledEntry = Path.Combine(ApplicationRoot, "apps", "manager-server", "src", "main.js");
        string sourceEntry = Path.Combine(ApplicationRoot, "apps", "manager-server", "src", "main.ts");
        string serverEntry = File.Exists(compiledEntry) ? compiledEntry : sourceEntry;
        if (!File.Exists(serverEntry))
        {
            return (false, $"Manager server entry not found: {serverEntry}");
        }

        string args = serverEntry.EndsWith(".ts", StringComparison.OrdinalIgnoreCase)
            ? $"--import tsx \"{serverEntry}\""
            : $"\"{serverEntry}\"";

        var psi = new ProcessStartInfo
        {
            FileName = NodeBinary,
            Arguments = args,
            WorkingDirectory = ApplicationRoot,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        PrependBundledToolsToPath(psi);
        psi.EnvironmentVariables["STM_WINDOWS_LAUNCHER"] = "1";
        psi.EnvironmentVariables["STM_DESKTOP_APP"] = "1";
        psi.EnvironmentVariables["STM_APP_ROOT"] = ApplicationRoot;
        psi.EnvironmentVariables["STM_STATIC_ROOT"] = StaticRoot;
        psi.EnvironmentVariables["STM_SHUTDOWN_TOKEN"] = ShutdownToken;
        psi.EnvironmentVariables["STM_OPEN_BROWSER"] = "0";
        psi.EnvironmentVariables["STM_PORT"] = ManagerPort.ToString();

        string bundledCloudflared = Path.Combine(PackagedRoot, "bin", "cloudflared.exe");
        if (File.Exists(bundledCloudflared))
        {
            psi.EnvironmentVariables["STM_CLOUDFLARED_BUNDLED"] = bundledCloudflared;
        }

        try
        {
            var proc = new Process
            {
                StartInfo = psi,
                EnableRaisingEvents = true,
            };
            proc.OutputDataReceived += (_, e) => HandleOutputLine(e.Data, isError: false);
            proc.ErrorDataReceived += (_, e) => HandleOutputLine(e.Data, isError: true);
            proc.Exited += (_, _) =>
            {
                if (_stopping) return;
                int code = 1;
                try { code = proc.ExitCode; } catch { }
                UnexpectedExit?.Invoke(code);
            };

            if (!proc.Start())
            {
                return (false, "Failed to start node.exe process.");
            }

            _process = proc;
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }

        bool ready = await WaitForReadyAsync(cancellationToken);
        if (!ready)
        {
            string details = GetRecentOutput();
            return (false, string.IsNullOrWhiteSpace(details)
                ? (Program.IsVietnamese ? "Trình quản lý dừng trước khi sẵn sàng." : "The manager exited before becoming ready.")
                : details);
        }

        return (true, null);
    }

    private void PrependBundledToolsToPath(ProcessStartInfo psi)
    {
        var toolDirs = new List<string>();
        string runtimeDir = Path.Combine(PackagedRoot, "runtime");
        string gitCmdDir = Path.Combine(PackagedRoot, "git", "cmd");
        if (Directory.Exists(runtimeDir)) toolDirs.Add(runtimeDir);
        if (Directory.Exists(gitCmdDir)) toolDirs.Add(gitCmdDir);
        if (toolDirs.Count == 0) return;

        string currentPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        psi.EnvironmentVariables["PATH"] = string.IsNullOrEmpty(currentPath)
            ? string.Join(Path.PathSeparator.ToString(), toolDirs)
            : string.Join(Path.PathSeparator.ToString(), toolDirs) + Path.PathSeparator + currentPath;
    }

    private void HandleOutputLine(string? line, bool isError)
    {
        if (string.IsNullOrEmpty(line)) return;
        string text = line!;

        if (!isError && text.StartsWith(NotifyPrefix, StringComparison.Ordinal))
        {
            ParseNotification(text.Substring(NotifyPrefix.Length));
            return;
        }

        if (!isError && text.StartsWith(EventPrefix, StringComparison.Ordinal))
        {
            ParseEvent(text.Substring(EventPrefix.Length));
            return;
        }

        lock (_gate)
        {
            if (_recentLines.Count >= MaxRecentLines)
            {
                _recentLines.Dequeue();
            }
            _recentLines.Enqueue(text);
        }
    }

    private void ParseNotification(string jsonText)
    {
        try
        {
            if (_json.DeserializeObject(jsonText) is IDictionary<string, object> obj)
            {
                string title = obj.TryGetValue("title", out var t) && t != null ? t.ToString() : "SillyTavern Manager";
                string body = obj.TryGetValue("body", out var b) && b != null ? b.ToString() : string.Empty;
                if (!string.IsNullOrWhiteSpace(title) || !string.IsNullOrWhiteSpace(body))
                {
                    NotificationReceived?.Invoke(title, body);
                }
            }
        }
        catch
        {
            // Ignore malformed notification lines.
        }
    }

    private void ParseEvent(string jsonText)
    {
        try
        {
            if (_json.DeserializeObject(jsonText) is IDictionary<string, object> obj
                && obj.TryGetValue("type", out var typeVal)
                && typeVal is string type
                && !string.IsNullOrEmpty(type))
            {
                EventReceived?.Invoke(type);
            }
        }
        catch
        {
            // Ignore malformed event lines.
        }
    }

    private async Task<bool> WaitForReadyAsync(CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(ReadyTimeoutMs);
        while (DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
        {
            var proc = _process;
            if (proc == null || proc.HasExited)
            {
                return false;
            }

            if (await ProbeHealthAsync())
            {
                return true;
            }

            try
            {
                await Task.Delay(350, cancellationToken);
            }
            catch (TaskCanceledException)
            {
                return false;
            }
        }
        return false;
    }

    private async Task<bool> ProbeHealthAsync()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create($"{ManagerUrl}/api/v1/health");
            req.Method = "GET";
            req.Timeout = 1500;
            req.ReadWriteTimeout = 1500;
            using var resp = (HttpWebResponse)await req.GetResponseAsync();
            return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 300;
        }
        catch
        {
            return false;
        }
    }

    public async Task StopAsync()
    {
        _stopping = true;
        var proc = _process;
        if (proc == null) return;

        try
        {
            if (proc.HasExited) return;
        }
        catch
        {
            return;
        }

        try
        {
            var req = (HttpWebRequest)WebRequest.Create($"{ManagerUrl}/api/v1/shutdown");
            req.Method = "POST";
            req.Headers["x-stm-shutdown-token"] = ShutdownToken;
            req.Timeout = 3000;
            req.ReadWriteTimeout = 3000;
            req.ContentLength = 0;
            using var resp = await req.GetResponseAsync();
        }
        catch
        {
            // Fall through to process wait and tree kill.
        }

        var deadline = DateTime.UtcNow.AddMilliseconds(GracefulStopMs);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                if (proc.HasExited) return;
            }
            catch
            {
                return;
            }
            await Task.Delay(150);
        }

        KillProcessTree(proc);
    }

    private static void KillProcessTree(Process proc)
    {
        try
        {
            if (proc.HasExited) return;
            int pid = proc.Id;
            using var kill = Process.Start(new ProcessStartInfo
            {
                FileName = "taskkill.exe",
                Arguments = $"/pid {pid} /t /f",
                CreateNoWindow = true,
                UseShellExecute = false,
            });
            kill?.WaitForExit(5000);
        }
        catch
        {
            try { proc.Kill(); } catch { }
        }
    }

    public string GetRecentOutput()
    {
        lock (_gate)
        {
            return string.Join(Environment.NewLine, _recentLines);
        }
    }

    private static bool IsPortFree(int port)
    {
        try
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static int? FindNextFreePort(int fromPort)
    {
        for (int port = fromPort; port < fromPort + 64 && port <= 65535; port++)
        {
            if (IsPortFree(port)) return port;
        }
        return null;
    }

    public void Dispose()
    {
        try
        {
            _stopping = true;
            if (_process is { HasExited: false } proc)
            {
                KillProcessTree(proc);
            }
            _process?.Dispose();
        }
        catch
        {
        }
    }
}
