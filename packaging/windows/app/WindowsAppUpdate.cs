using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace SillyTavernManager;

internal static class WindowsAppUpdate
{
    private const string DefaultReleasesBaseUrl = "https://github.com/locmaymo/stm/releases/download";
    private const int BufferBytes = 256 * 1024;
    private const int ProgressEveryMs = 250;

    private static readonly Regex VersionPattern = new(@"^\d{1,4}\.\d{1,4}\.\d{1,4}$", RegexOptions.Compiled);
    private static readonly Regex Sha256Pattern = new(@"^[0-9a-f]{64}$", RegexOptions.Compiled);
    private static readonly JavaScriptSerializer Json = new();

    private static volatile bool _running;
    private static volatile bool _canceled;

    public static void Cancel()
    {
        _canceled = true;
    }

    public static void Start(
        string version,
        string dataDirectory,
        Action<string> postMessage,
        Action<string> onReadyToInstall)
    {
        if (_running) return;

        if (!VersionPattern.IsMatch(version ?? string.Empty) || CompareVersions(version!, Program.AppVersion) <= 0)
        {
            postMessage(SerializeEvent("failed", ("code", "notNewer")));
            return;
        }

        _running = true;
        _canceled = false;

        Task.Run(() =>
        {
            try
            {
                string? installerPath = DownloadAndVerify(version!, dataDirectory, postMessage);
                if (installerPath == null) return;

                postMessage(SerializeEvent("installing"));
                onReadyToInstall(installerPath);
            }
            finally
            {
                _running = false;
            }
        });
    }

    private static string? DownloadAndVerify(string version, string dataDirectory, Action<string> postMessage)
    {
        string releasesBase = (Environment.GetEnvironmentVariable("STM_WINDOWS_RELEASES_URL") ?? DefaultReleasesBaseUrl).TrimEnd('/');
        string assetName = $"SillyTavernManager-windows-x64-v{version}-setup.exe";
        string baseUrl = $"{releasesBase}/v{version}/{assetName}";
        string updateFolder = Path.Combine(dataDirectory, "updates");
        string installerPath = Path.Combine(updateFolder, assetName);

        try
        {
            string? expectedHash = FetchExpectedDigest($"{baseUrl}.sha256");
            if (expectedHash == null)
            {
                postMessage(SerializeEvent("failed", ("code", "missing")));
                return null;
            }

            if (Directory.Exists(updateFolder))
            {
                try { Directory.Delete(updateFolder, recursive: true); } catch { }
            }
            Directory.CreateDirectory(updateFolder);

            var req = CreateRequest(baseUrl);
            using var resp = (HttpWebResponse)req.GetResponse();
            if (resp.StatusCode == HttpStatusCode.NotFound)
            {
                postMessage(SerializeEvent("failed", ("code", "missing")));
                return null;
            }
            if (resp.StatusCode != HttpStatusCode.OK)
            {
                throw new IOException($"HTTP {(int)resp.StatusCode}");
            }

            long total = resp.ContentLength;
            long received = 0;
            long lastReported = 0;

            using var sha256 = SHA256.Create();
            using (var inStream = resp.GetResponseStream())
            using (var outStream = new FileStream(installerPath, FileMode.Create, FileAccess.Write, FileShare.None, BufferBytes))
            {
                if (inStream == null) throw new IOException("Empty response stream.");
                byte[] buffer = new byte[BufferBytes];
                int read;
                while ((read = inStream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (_canceled)
                    {
                        outStream.Close();
                        TryDelete(installerPath);
                        postMessage(SerializeEvent("canceled"));
                        return null;
                    }

                    outStream.Write(buffer, 0, read);
                    sha256.TransformBlock(buffer, 0, read, null, 0);
                    received += read;

                    long now = Environment.TickCount;
                    if (now - lastReported >= ProgressEveryMs)
                    {
                        lastReported = now;
                        postMessage(SerializeEvent("progress", ("received", received), ("total", total)));
                    }
                }
                sha256.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
            }

            postMessage(SerializeEvent("progress", ("received", received), ("total", total)));

            string actualHash = ToHex(sha256.Hash ?? Array.Empty<byte>());
            if (!string.Equals(expectedHash, actualHash, StringComparison.OrdinalIgnoreCase))
            {
                TryDelete(installerPath);
                postMessage(SerializeEvent("failed", ("code", "checksum")));
                return null;
            }

            return installerPath;
        }
        catch (WebException ex) when (ex.Response is HttpWebResponse { StatusCode: HttpStatusCode.NotFound })
        {
            TryDelete(installerPath);
            postMessage(SerializeEvent("failed", ("code", "missing")));
            return null;
        }
        catch
        {
            TryDelete(installerPath);
            postMessage(SerializeEvent("failed", ("code", "network")));
            return null;
        }
    }

    private static string? FetchExpectedDigest(string checksumUrl)
    {
        try
        {
            var req = CreateRequest(checksumUrl);
            using var resp = (HttpWebResponse)req.GetResponse();
            if (resp.StatusCode == HttpStatusCode.NotFound) return null;
            if (resp.StatusCode != HttpStatusCode.OK) throw new IOException($"HTTP {(int)resp.StatusCode}");

            using var stream = resp.GetResponseStream();
            if (stream == null) return null;
            using var reader = new StreamReader(stream, Encoding.UTF8);
            string text = reader.ReadToEnd().Trim();
            if (string.IsNullOrEmpty(text)) return null;

            string firstToken = text.Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)[0]
                .ToLowerInvariant();
            if (!Sha256Pattern.IsMatch(firstToken))
            {
                throw new IOException("Invalid SHA-256 digest format.");
            }
            return firstToken;
        }
        catch (WebException ex) when (ex.Response is HttpWebResponse { StatusCode: HttpStatusCode.NotFound })
        {
            return null;
        }
    }

    private static HttpWebRequest CreateRequest(string url)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "GET";
        req.Timeout = 20_000;
        req.ReadWriteTimeout = 30_000;
        req.AllowAutoRedirect = true;
        req.UserAgent = $"STMDesktop/{Program.AppVersion}";
        return req;
    }

    private static int CompareVersions(string a, string b)
    {
        string[] left = a.Split('.', '-');
        string[] right = b.Split('.', '-');
        for (int i = 0; i < 3; i++)
        {
            int x = i < left.Length && int.TryParse(left[i], out int lx) ? lx : 0;
            int y = i < right.Length && int.TryParse(right[i], out int ry) ? ry : 0;
            if (x != y) return x.CompareTo(y);
        }
        return 0;
    }

    private static string ToHex(byte[] bytes)
    {
        var sb = new StringBuilder(bytes.Length * 2);
        foreach (byte b in bytes)
        {
            sb.Append(b.ToString("x2"));
        }
        return sb.ToString();
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private static string SerializeEvent(string state, params (string Key, object Value)[] fields)
    {
        var payload = new Dictionary<string, object>
        {
            ["type"] = "appUpdate",
            ["state"] = state,
        };
        foreach (var (key, value) in fields)
        {
            payload[key] = value;
        }
        return Json.Serialize(payload);
    }
}
