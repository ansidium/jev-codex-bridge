using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// A GUI-subsystem host avoids creating a console, including a Windows Terminal
// window. Task Scheduler waits for this process and receives the worker's exit code.
internal static class WindowsServiceHost
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 3 || (args[2] != "serve" && args[2] != "update")) return 2;
        string home = Path.GetFullPath(args[0]);
        string logPath = Path.Combine(home, args[2] + ".log");
        try
        {
            bool legacyEncoding = false;
            if (File.Exists(logPath))
            {
                using (var file = File.OpenRead(logPath))
                {
                    int first = file.ReadByte(), second = file.ReadByte();
                    legacyEncoding = (first == 255 && second == 254) || (first == 254 && second == 255);
                }
            }
            if (File.Exists(logPath) && (legacyEncoding || new FileInfo(logPath).Length > 5 * 1024 * 1024))
            {
                string previous = logPath + ".previous";
                if (File.Exists(previous)) File.Delete(previous);
                File.Move(logPath, previous);
            }
            using (var log = new StreamWriter(logPath, true, new UTF8Encoding(false)))
            using (var child = new Process())
            {
                log.AutoFlush = true;
                child.StartInfo = new ProcessStartInfo
                {
                    FileName = args[1],
                    Arguments = "\"" + Path.Combine(home, "launch.mjs") + "\" " + args[2] + " --automatic",
                    WorkingDirectory = home,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = new UTF8Encoding(false),
                    StandardErrorEncoding = new UTF8Encoding(false)
                };
                DataReceivedEventHandler write = (sender, e) =>
                {
                    if (e.Data != null) lock (log) log.WriteLine(e.Data);
                };
                child.OutputDataReceived += write;
                child.ErrorDataReceived += write;
                child.Start();
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            try { File.AppendAllText(logPath, error.Message + Environment.NewLine, new UTF8Encoding(false)); }
            catch { }
            return 1;
        }
    }
}
