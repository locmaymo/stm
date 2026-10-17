using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace SillyTavernManager;

internal static class BackupImport
{
    private const int ChunkBytes = 32 * 1024 * 1024;
    private const int BufferBytes = 1024 * 1024;
    private const int ProgressEveryMs = 250;
    private const int Retries = 5;
    private const int RetryFirstMs = 1000;

    private static readonly JavaScriptSerializer Json = new();
    private static volatile bool _running;
    private static volatile bool _canceled;

    public static void Cancel()
    {
        _canceled = true;
    }

    public static void PickAndUpload(
        IWin32Window owner,
        string origin,
        string csrfToken,
        string cookieHeader,
        Action<string> postMessage)
    {
        if (_running)
        {
            postMessage(SerializeEvent("failed", ("code", "upload_busy"), ("message", "Another upload is already running.")));
            return;
        }

        using var dialog = new OpenFileDialog
        {
            Title = Program.IsVietnamese ? "Chọn bản sao lưu (.zip)" : "Select backup archive (.zip)",
            Filter = Program.IsVietnamese
                ? "Tệp nén ZIP (*.zip)|*.zip|Tất cả tệp (*.*)|*.*"
                : "ZIP archives (*.zip)|*.zip|All files (*.*)|*.*",
            CheckFileExists = true,
            Multiselect = false,
        };

        if (dialog.ShowDialog(owner) != DialogResult.OK || string.IsNullOrEmpty(dialog.FileName))
        {
            postMessage(SerializeEvent("canceled"));
            return;
        }

        string filePath = dialog.FileName;
        var fileInfo = new FileInfo(filePath);
        if (!fileInfo.Exists)
        {
            postMessage(SerializeEvent("canceled"));
            return;
        }

        _running = true;
        _canceled = false;

        Task.Run(() =>
        {
            try
            {
                UploadFile(fileInfo, origin, csrfToken, cookieHeader, postMessage);
            }
            finally
            {
                _running = false;
            }
        });
    }

    private static void UploadFile(
        FileInfo fileInfo,
        string origin,
        string csrfToken,
        string cookieHeader,
        Action<string> postMessage)
    {
        string name = fileInfo.Name;
        long size = fileInfo.Length;
        postMessage(SerializeEvent("picked", ("name", name), ("size", size)));

        string uploadId = Guid.NewGuid().ToString();
        try
        {
            if (size <= 0)
            {
                throw new IOException("The file is empty.");
            }

            long sent = SendAllChunks(fileInfo, uploadId, origin, csrfToken, cookieHeader, postMessage);
            postMessage(SerializeEvent("progress", ("sent", sent), ("total", size)));

            var finishReq = CreateRequest($"{origin}/api/v1/backups/import/finish", "POST", csrfToken, cookieHeader);
            finishReq.ContentType = "application/json";
            string finishPayload = Json.Serialize(new Dictionary<string, object>
            {
                ["uploadId"] = uploadId,
                ["name"] = name,
                ["expectedBytes"] = sent,
            });
            byte[] bodyBytes = Encoding.UTF8.GetBytes(finishPayload);
            finishReq.ContentLength = bodyBytes.Length;
            using (var reqStream = finishReq.GetRequestStream())
            {
                reqStream.Write(bodyBytes, 0, bodyBytes.Length);
            }

            var (status, responseBody) = ReadResponse(finishReq);
            postMessage(SerializeEvent("done", ("status", status), ("body", responseBody)));
        }
        catch (OperationCanceledException)
        {
            DiscardUpload(origin, uploadId, csrfToken, cookieHeader);
            postMessage(SerializeEvent("canceled"));
        }
        catch (UploadHttpException ex)
        {
            DiscardUpload(origin, uploadId, csrfToken, cookieHeader);
            postMessage(SerializeEvent("failed", ("message", ex.Message), ("status", ex.StatusCode), ("body", ex.ResponseBody)));
        }
        catch (Exception ex)
        {
            DiscardUpload(origin, uploadId, csrfToken, cookieHeader);
            postMessage(SerializeEvent("failed", ("message", ex.Message)));
        }
    }

    private static long SendAllChunks(
        FileInfo fileInfo,
        string uploadId,
        string origin,
        string csrfToken,
        string cookieHeader,
        Action<string> postMessage)
    {
        int failures = 0;
        while (true)
        {
            try
            {
                long fromByte = 0;
                int firstIndex = 0;
                if (failures > 0)
                {
                    var (nextIndex, bytesHeld) = QueryProgress(origin, uploadId, csrfToken, cookieHeader);
                    firstIndex = nextIndex;
                    fromByte = bytesHeld;
                }
                return SendFromOffset(fileInfo, uploadId, fromByte, firstIndex, origin, csrfToken, cookieHeader, postMessage);
            }
            catch (Exception ex) when (ex is IOException || ex is WebException || ex is UploadHttpException)
            {
                if (_canceled) throw new OperationCanceledException();
                if (ex is UploadHttpException httpEx && httpEx.StatusCode < 500) throw;
                if (++failures > Retries) throw;
                PauseWithCancelCheck(RetryFirstMs << (failures - 1));
            }
        }
    }

    private static long SendFromOffset(
        FileInfo fileInfo,
        string uploadId,
        long fromByte,
        int firstIndex,
        string origin,
        string csrfToken,
        string cookieHeader,
        Action<string> postMessage)
    {
        long sent = fromByte;
        long total = fileInfo.Length;
        using var fs = new FileStream(fileInfo.FullName, FileMode.Open, FileAccess.Read, FileShare.Read, BufferBytes);
        if (fromByte > 0)
        {
            fs.Seek(fromByte, SeekOrigin.Begin);
        }

        byte[] buffer = new byte[BufferBytes];
        int pending = ReadFully(fs, buffer);
        long lastReported = 0;

        for (int index = firstIndex; pending > 0; index++)
        {
            if (_canceled) throw new OperationCanceledException();

            var req = CreateRequest($"{origin}/api/v1/backups/import/chunk?uploadId={Uri.EscapeDataString(uploadId)}&index={index}", "POST", csrfToken, cookieHeader);
            req.ContentType = "application/octet-stream";
            req.SendChunked = true;
            req.AllowWriteStreamBuffering = false;

            int chunkWritten = 0;
            using (var outStream = req.GetRequestStream())
            {
                while (pending > 0 && chunkWritten + pending <= ChunkBytes)
                {
                    if (_canceled) throw new OperationCanceledException();
                    outStream.Write(buffer, 0, pending);
                    chunkWritten += pending;
                    sent += pending;
                    pending = ReadFully(fs, buffer);

                    long now = Environment.TickCount;
                    if (now - lastReported >= ProgressEveryMs)
                    {
                        lastReported = now;
                        postMessage(SerializeEvent("progress", ("sent", sent), ("total", total)));
                    }
                }
            }

            var (status, body) = ReadResponse(req);
            if (status < 200 || status >= 300)
            {
                throw new UploadHttpException(status, body);
            }
        }

        return sent;
    }

    private static (int NextIndex, long BytesHeld) QueryProgress(
        string origin,
        string uploadId,
        string csrfToken,
        string cookieHeader)
    {
        var req = CreateRequest($"{origin}/api/v1/backups/import/chunk?uploadId={Uri.EscapeDataString(uploadId)}", "GET", csrfToken, cookieHeader);
        var (status, body) = ReadResponse(req);
        if (status == 404) return (0, 0);
        if (status < 200 || status >= 300) throw new UploadHttpException(status, body);

        if (Json.DeserializeObject(body) is IDictionary<string, object> obj)
        {
            int nextIndex = obj.TryGetValue("nextIndex", out var ni) ? Convert.ToInt32(ni) : 0;
            long bytes = obj.TryGetValue("bytes", out var b) ? Convert.ToInt64(b) : 0;
            return (nextIndex, bytes);
        }
        return (0, 0);
    }

    private static void DiscardUpload(string origin, string uploadId, string csrfToken, string cookieHeader)
    {
        try
        {
            var req = CreateRequest($"{origin}/api/v1/backups/import/chunk?uploadId={Uri.EscapeDataString(uploadId)}", "DELETE", csrfToken, cookieHeader);
            ReadResponse(req);
        }
        catch
        {
            // Swept by the server on next startup.
        }
    }

    private static HttpWebRequest CreateRequest(string url, string method, string csrfToken, string cookieHeader)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = method;
        req.Timeout = 10 * 60 * 1000;
        req.ReadWriteTimeout = 10 * 60 * 1000;
        req.Accept = "application/json";
        if (!string.IsNullOrEmpty(cookieHeader))
        {
            req.Headers[HttpRequestHeader.Cookie] = cookieHeader;
        }
        if (!string.IsNullOrEmpty(csrfToken))
        {
            req.Headers["x-csrf-token"] = csrfToken;
        }
        return req;
    }

    private static (int StatusCode, string Body) ReadResponse(HttpWebRequest req)
    {
        try
        {
            using var resp = (HttpWebResponse)req.GetResponse();
            return ((int)resp.StatusCode, ReadStreamText(resp.GetResponseStream()));
        }
        catch (WebException ex) when (ex.Response is HttpWebResponse errResp)
        {
            using (errResp)
            {
                return ((int)errResp.StatusCode, ReadStreamText(errResp.GetResponseStream()));
            }
        }
    }

    private static string ReadStreamText(Stream? stream)
    {
        if (stream == null) return string.Empty;
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static int ReadFully(Stream stream, byte[] buffer)
    {
        int total = 0;
        while (total < buffer.Length)
        {
            int read = stream.Read(buffer, total, buffer.Length - total);
            if (read <= 0) break;
            total += read;
        }
        return total;
    }

    private static void PauseWithCancelCheck(int delayMs)
    {
        int waited = 0;
        while (waited < delayMs)
        {
            if (_canceled) throw new OperationCanceledException();
            Thread.Sleep(100);
            waited += 100;
        }
    }

    private static string SerializeEvent(string state, params (string Key, object Value)[] fields)
    {
        var payload = new Dictionary<string, object>
        {
            ["type"] = "import",
            ["state"] = state,
        };
        foreach (var (key, value) in fields)
        {
            payload[key] = value;
        }
        return Json.Serialize(payload);
    }

    private sealed class UploadHttpException : Exception
    {
        public int StatusCode { get; }
        public string ResponseBody { get; }

        public UploadHttpException(int statusCode, string responseBody)
            : base($"The manager refused the upload ({statusCode})")
        {
            StatusCode = statusCode;
            ResponseBody = responseBody;
        }
    }
}
