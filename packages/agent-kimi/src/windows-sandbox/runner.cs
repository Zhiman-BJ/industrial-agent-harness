// Harness supervises the pinned Microsoft MXC launcher; MXC owns isolation.
// There is no direct Agent launch, restricted-token backend, or unsandboxed fallback.
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
// https://learn.microsoft.com/windows/win32/procthread/job-objects
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public sealed class Configuration
{
    public Configuration() { }
    public string executable { get; set; }
    public string[] args { get; set; }
    public string workingDirectory { get; set; }
    public string[] writableRoots { get; set; }
    public string[] protectedRoots { get; set; }
    public Dictionary<string, string> environment { get; set; }
    public int parentPid { get; set; }
}

internal static class Runner
{
    const uint ReadControl = 0x20000, Synchronize = 0x100000;
    const uint OpenExisting = 3, BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    const uint ReparsePoint = 0x400, DirectoryAttribute = 0x10;
    const uint WaitObject = 0, WaitTimeout = 258;
    static readonly List<IntPtr> allocations = new List<IntPtr>();
    static readonly List<IntPtr> inheritedHandles = new List<IntPtr>();
    static IntPtr job, attributeList, parent;
    static Thread watcher;
    static bool assigned, attributesInitialized;
    static int finished;
    static string stage = "initialize";

    static void Stage(string value)
    {
        stage = value;
        Console.Error.WriteLine("Windows MXC supervisor: " + value);
    }

    public static int Main(string[] argv)
    {
        int result = 125;
        try
        {
            // The launcher inherits this mode: startup errors must not wait for UI.
            SetErrorMode(GetErrorMode() | 1 | 2 | 0x8000);
            if (argv.Length != 1) throw new InvalidOperationException("Expected one supervisor policy JSON path.");
            Stage("validate MXC launch policy");
            string policyPath = NativePath(argv[0]);
            if (!File.Exists(policyPath)) throw new InvalidOperationException("Supervisor policy must be a regular file.");
            Configuration config = new JavaScriptSerializer().Deserialize<Configuration>(File.ReadAllText(policyPath));
            Validate(config, policyPath);
            Stage("inspect writable storage");
            InspectWritableTrees(config.writableRoots);
            result = Launch(config);
        }
        catch (Exception error)
        {
            Win32Exception native = error as Win32Exception;
            Console.Error.WriteLine("Windows MXC supervisor failed during " + stage + ": " + error.Message +
                (native == null ? "" : " (Win32 " + native.NativeErrorCode + ", 0x" + native.NativeErrorCode.ToString("X8") + ")"));
        }
        finally
        {
            if (!Cleanup()) result = 125;
        }
        return result;
    }

    static bool Cleanup()
    {
        Interlocked.Exchange(ref finished, 1);
        bool confirmed = true;
        if (job != IntPtr.Zero && assigned)
        {
            Stage("stop MXC descendants");
            if (!TerminateJobObject(job, 125))
                Console.Error.WriteLine("Windows MXC Job termination returned Win32 " + Marshal.GetLastWin32Error());
            confirmed = WaitForJobExit();
            if (!confirmed) Console.Error.WriteLine("Windows MXC process-tree termination was not confirmed.");
        }
        bool watcherStopped = watcher == null || watcher.Join(1000);
        if (!watcherStopped)
        {
            Console.Error.WriteLine("Windows MXC parent watchdog did not stop; process handles remain live until supervisor exit.");
            confirmed = false;
        }
        else
        {
            if (parent != IntPtr.Zero) CloseHandle(parent);
            // KILL_ON_JOB_CLOSE also applies if explicit termination could not be confirmed.
            if (job != IntPtr.Zero) CloseHandle(job);
        }
        if (attributesInitialized) DeleteProcThreadAttributeList(attributeList);
        foreach (IntPtr handle in inheritedHandles) CloseHandle(handle);
        foreach (IntPtr allocation in allocations) Marshal.FreeHGlobal(allocation);
        return confirmed;
    }

    static bool WaitForJobExit()
    {
        Stopwatch deadline = Stopwatch.StartNew();
        while (deadline.ElapsedMilliseconds < 10000)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
            if (!QueryInformationJobObject(job, 1, out information, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
            {
                Console.Error.WriteLine("Windows MXC Job accounting failed with Win32 " + Marshal.GetLastWin32Error());
                return false;
            }
            if (information.activeProcesses == 0) return true;
            Thread.Sleep(10);
        }
        return false;
    }

    static void Validate(Configuration config, string policyPath)
    {
        if (config == null || config.args == null || config.args.Length != 1 ||
            config.environment == null || config.parentPid <= 0 ||
            config.writableRoots == null || config.writableRoots.Length != 2 ||
            config.protectedRoots == null || config.protectedRoots.Length == 0)
            throw new InvalidOperationException("Incomplete MXC supervisor policy.");
        config.executable = NativePath(config.executable);
        config.args[0] = NativePath(config.args[0]);
        config.workingDirectory = NativePath(config.workingDirectory);
        string policyDirectory = Path.GetDirectoryName(policyPath);
        if (!Path.GetFileName(config.executable).Equals("wxc-exec.exe", StringComparison.OrdinalIgnoreCase) ||
            !Path.GetDirectoryName(config.executable).Equals(policyDirectory, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetDirectoryName(config.args[0]).Equals(policyDirectory, StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(config.executable) || !File.Exists(config.args[0]) ||
            config.args[0].Equals(policyPath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Supervisor must invoke its bound host-owned wxc-exec.exe with a separate MXC request file.");
        for (int i = 0; i < config.writableRoots.Length; i++) config.writableRoots[i] = NativePath(config.writableRoots[i]);
        // Read-only package/store files may legitimately be hard-linked. Writable
        // trees and the trusted launcher/request/policy files remain single-link.
        for (int i = 0; i < config.protectedRoots.Length; i++) config.protectedRoots[i] = NativePath(config.protectedRoots[i], true);
        if (Inside(config.writableRoots[0], config.writableRoots[1]) || Inside(config.writableRoots[1], config.writableRoots[0]))
            throw new InvalidOperationException("Writable roots overlap.");
        if (!Directory.Exists(config.workingDirectory) || !Inside(config.workingDirectory, config.writableRoots[0]))
            throw new InvalidOperationException("Workspace is outside session storage.");
        foreach (string root in config.writableRoots)
        {
            if (!Directory.Exists(root)) throw new InvalidOperationException("Writable root must be a directory.");
            if (Inside(policyPath, root) || Inside(config.executable, root) || Inside(config.args[0], root))
                throw new InvalidOperationException("MXC launcher and policy files must stay outside writable storage.");
            foreach (string protectedRoot in config.protectedRoots)
                if (Inside(root, protectedRoot) || Inside(protectedRoot, root))
                    throw new InvalidOperationException("Writable and protected roots overlap.");
        }
        HashSet<string> environmentKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, string> entry in config.environment)
            if (String.IsNullOrEmpty(entry.Key) || entry.Key.IndexOfAny(new char[] { '=', '\0' }) >= 0 ||
                entry.Value == null || entry.Value.IndexOf('\0') >= 0 || !environmentKeys.Add(entry.Key))
                throw new InvalidOperationException("Invalid or duplicate environment entry.");
        // Capture the handle once: PID reuse must never change the watchdog target.
        parent = OpenProcess(Synchronize, false, config.parentPid);
        if (parent == IntPtr.Zero) Fail("Open parent watchdog handle");
        uint status = WaitForSingleObject(parent, 0);
        if (status == WaitObject) throw new InvalidOperationException("The requesting parent has already exited.");
        if (status != WaitTimeout) Fail("Inspect requesting parent");
    }

    static bool Inside(string child, string parentPath)
    {
        return child.Equals(parentPath, StringComparison.OrdinalIgnoreCase) ||
            child.StartsWith(parentPath.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    static string NativePath(string source, bool allowReadonlyLeafHardLinks = false)
    {
        if (String.IsNullOrEmpty(source) || source.IndexOf('\0') >= 0) throw new InvalidOperationException("Invalid path.");
        string path = Path.GetFullPath(source).TrimEnd('\\');
        if (path.Length < 3 || path[1] != ':' || path[2] != '\\' || path.IndexOf(':', 2) >= 0)
            throw new InvalidOperationException("Only local drive paths are supported.");
        string root = Path.GetPathRoot(path);
        if (new DriveInfo(root).DriveFormat != "NTFS") throw new InvalidOperationException("MXC launch paths require NTFS.");
        string cursor = root;
        foreach (string component in path.Substring(root.Length).Split('\\'))
        {
            if (component.Length == 0) continue;
            cursor = Path.Combine(cursor, component);
            using (SafeFileHandle handle = OpenMetadata(cursor))
                CheckHandle(handle, cursor, allowReadonlyLeafHardLinks && cursor.Equals(path, StringComparison.OrdinalIgnoreCase));
        }
        return path;
    }

    static SafeFileHandle OpenMetadata(string path)
    {
        // Inspection is read-only. The supervisor never rewrites file ACLs/labels.
        SafeFileHandle handle = CreateFile(path, 0x80 | ReadControl, 7, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "Open MXC launch metadata");
        }
        return handle;
    }

    static BY_HANDLE_FILE_INFORMATION CheckHandle(SafeFileHandle handle, string expected, bool allowReadonlyHardLinks = false)
    {
        BY_HANDLE_FILE_INFORMATION info;
        if (!GetFileInformationByHandle(handle, out info)) Fail("Read file identity");
        if ((info.attributes & ReparsePoint) != 0 ||
            (!allowReadonlyHardLinks && (info.attributes & DirectoryAttribute) == 0 && info.links != 1))
            throw new InvalidOperationException("Reparse points and multiply linked files are not permitted in MXC launch paths.");
        StringBuilder final = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
        if (length == 0 || length >= final.Capacity) Fail("Resolve native file identity");
        string resolved = final.ToString();
        if (!resolved.StartsWith("\\\\?\\", StringComparison.Ordinal) ||
            !resolved.Substring(4).TrimEnd('\\').Equals(expected.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Path and native file identity differ.");
        return info;
    }

    static void InspectWritableTrees(string[] roots)
    {
        Stack<string> pending = new Stack<string>();
        foreach (string root in roots) pending.Push(root);
        int inspected = 0;
        while (pending.Count != 0)
        {
            if (++inspected > 100000) throw new InvalidOperationException("Writable storage exceeds metadata inspection limit.");
            string path = pending.Pop();
            bool directory;
            using (SafeFileHandle handle = OpenMetadata(path))
                directory = (CheckHandle(handle, path).attributes & DirectoryAttribute) != 0;
            if (!directory) continue;
            foreach (string child in Directory.EnumerateFileSystemEntries(path))
            {
                if (inspected + pending.Count >= 100000) throw new InvalidOperationException("Writable storage exceeds metadata inspection limit.");
                pending.Push(child);
            }
        }
    }

    static IntPtr Bytes(byte[] bytes)
    {
        IntPtr result = Marshal.AllocHGlobal(bytes.Length);
        allocations.Add(result);
        Marshal.Copy(bytes, 0, result, bytes.Length);
        return result;
    }

    static string Quote(string text)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char value in text)
        {
            if (value == '\\') { slashes++; continue; }
            if (value == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(value); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    static int Launch(Configuration config)
    {
        Stage("prepare MXC process job");
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) Fail("Create MXC process job");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            Fail("Set kill-on-close MXC job");
        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.info.size = Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.info.flags = 0x100; // STARTF_USESTDHANDLES
        IntPtr current = GetCurrentProcess();
        int[] ids = { -10, -11, -12 };
        foreach (int id in ids)
        {
            IntPtr standard = GetStdHandle(id);
            if (standard == IntPtr.Zero || standard == new IntPtr(-1)) throw new InvalidOperationException("MXC supervisor requires valid standard I/O handles.");
            IntPtr duplicate;
            if (!DuplicateHandle(current, standard, current, out duplicate, 0, true, 2)) Fail("Duplicate standard I/O");
            inheritedHandles.Add(duplicate);
        }
        startup.info.input = inheritedHandles[0];
        startup.info.output = inheritedHandles[1];
        startup.info.error = inheritedHandles[2];
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        if (size == IntPtr.Zero) Fail("Measure process attribute list");
        attributeList = Marshal.AllocHGlobal(size);
        allocations.Add(attributeList);
        if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref size)) Fail("Create process attribute list");
        attributesInitialized = true;
        IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
        allocations.Add(handles);
        for (int i = 0; i < 3; i++) Marshal.WriteIntPtr(handles, i * IntPtr.Size, inheritedHandles[i]);
        if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
            Fail("Restrict inherited handles");
        startup.attributes = attributeList;
        List<string> keys = new List<string>(config.environment.Keys);
        keys.Sort(StringComparer.OrdinalIgnoreCase);
        StringBuilder environment = new StringBuilder();
        foreach (string key in keys) environment.Append(key).Append('=').Append(config.environment[key]).Append('\0');
        environment.Append('\0');
        if (keys.Count == 0) environment.Append('\0');
        IntPtr env = Bytes(Encoding.Unicode.GetBytes(environment.ToString()));
        StringBuilder command = new StringBuilder(Quote(config.executable));
        command.Append(' ').Append(Quote(config.args[0]));
        PROCESS_INFORMATION process;
        Stage("create suspended MXC launcher");
        if (!CreateProcess(config.executable, command, IntPtr.Zero, IntPtr.Zero, true,
            4 | 0x400 | 0x80000 | 0x08000000, env, config.workingDirectory, ref startup, out process))
            Fail("Create MXC launcher");
        Console.Error.WriteLine("Windows MXC launcher PID: " + process.processId);
        try
        {
            if (!AssignProcessToJobObject(job, process.process))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.process, 125);
                if (WaitForSingleObject(process.process, 10000) != WaitObject)
                    Environment.FailFast("Unassigned suspended MXC launcher did not terminate.");
                throw new Win32Exception(error, "Assign suspended MXC launcher to job");
            }
            assigned = true;
            watcher = new Thread(delegate()
            {
                while (Interlocked.CompareExchange(ref finished, 0, 0) == 0)
                {
                    uint status = WaitForSingleObject(parent, 100);
                    if (status == WaitTimeout) continue;
                    Console.Error.WriteLine("Windows MXC requesting parent stopped or became unavailable; terminating the process job.");
                    if (!TerminateJobObject(job, 125))
                        Console.Error.WriteLine("Windows MXC watchdog termination failed with Win32 " + Marshal.GetLastWin32Error());
                    return;
                }
            });
            watcher.IsBackground = true;
            watcher.Start();
            Stage("resume MXC launcher");
            uint suspended = ResumeThread(process.thread);
            if (suspended == UInt32.MaxValue) Fail("Resume MXC launcher");
            if (suspended != 1) throw new InvalidOperationException("MXC launcher had an unexpected suspension count.");
            Stage("wait for MXC launcher");
            if (WaitForSingleObject(process.process, UInt32.MaxValue) != WaitObject) Fail("Wait for MXC launcher");
            uint code;
            if (!GetExitCodeProcess(process.process, out code)) Fail("Read MXC launcher exit code");
            if (code != 0) Console.Error.WriteLine("Windows MXC launcher exited with status 0x" + code.ToString("X8"));
            return unchecked((int)code);
        }
        finally
        {
            CloseHandle(process.thread);
            CloseHandle(process.process);
        }
    }

    static void Fail(string operation) { throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION { public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write; public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int size; public string reserved, desktop, title; public uint x, y, width, height, charsX, charsY, fill, flags; public ushort show, reservedSize; public IntPtr reservedBytes, input, output, error; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long processTime, jobTime; public uint flags; public UIntPtr minimum, maximum; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong read, write, other, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long totalUser, totalKernel, periodUser, periodKernel; public uint faults, totalProcesses, activeProcesses, terminatedProcesses; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint length, IntPtr returned);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
    [DllImport("kernel32.dll")] static extern uint GetErrorMode();
}
