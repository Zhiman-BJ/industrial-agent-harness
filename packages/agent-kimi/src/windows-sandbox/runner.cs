// Original Harness implementation using documented Microsoft Windows APIs.
// This candidate fails closed; native Windows qualification is required before release.
// https://learn.microsoft.com/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken
// https://learn.microsoft.com/windows/win32/secauthz/mandatory-integrity-control
// https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw
// https://learn.microsoft.com/windows/win32/procthread/job-objects
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
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
    const uint ReadControl = 0x20000, WriteDac = 0x40000, WriteOwner = 0x80000;
    const uint Modify = 0x1301bf, Synchronize = 0x100000;
    const uint DaclInformation = 4, LabelInformation = 16;
    const uint ProtectedDacl = 0x80000000, UnprotectedDacl = 0x20000000;
    const uint OpenExisting = 3, BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    const uint ReparsePoint = 0x400, DirectoryAttribute = 0x10;
    static readonly List<Grant> grants = new List<Grant>();
    static readonly List<IntPtr> allocations = new List<IntPtr>();
    static readonly List<IntPtr> inheritedHandles = new List<IntPtr>();
    static IntPtr token, job, windowStation, desktop, attributeList, parent;
    static Thread watcher;
    static SecurityIdentifier launchSid;
    static IntPtr originalStation;
    static bool assigned;
    static int finished;
    static string stage = "initialize";

    static void Stage(string value)
    {
        stage = value;
        Console.Error.WriteLine("Windows agent isolation: " + value);
    }

    sealed class Grant
    {
        public SafeFileHandle handle;
        public RawSecurityDescriptor original;
        public bool directory;
        public string path;
    }

    public static int Main(string[] argv)
    {
        try
        {
            // Children inherit this mode. A DLL startup failure must return its
            // status, not wait forever for a dialog on the noninteractive desktop.
            SetErrorMode(GetErrorMode() | 1 | 2 | 0x8000);
            if (argv.Length != 1) throw new InvalidOperationException("Expected one policy JSON path.");
            Configuration config = new JavaScriptSerializer().Deserialize<Configuration>(File.ReadAllText(argv[0]));
            Stage("validate policy");
            Validate(config);
            SecurityIdentifier sid = NewSid();
            launchSid = sid;
            SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
            Stage("prepare token");
            PrepareToken(sid, user);
            // Inspect the complete trees before changing any ACL. All ACL changes use these handles.
            foreach (string root in config.writableRoots) InspectTree(root);
            foreach (Grant grant in grants) ApplyGrant(grant, sid);
            Stage("verify file boundary");
            VerifyBoundary(config);
            Stage("prepare noninteractive desktop");
            CreatePrivateDesktop(sid, user);
            return Launch(config);
        }
        catch (Exception error)
        {
            Win32Exception native = error as Win32Exception;
            Console.Error.WriteLine("Windows agent isolation failed during " + stage + ": " + error.Message +
                (native == null ? "" : " (Win32 " + native.NativeErrorCode + ", 0x" + native.NativeErrorCode.ToString("X8") + ")"));
            return 125;
        }
        finally
        {
            Interlocked.Exchange(ref finished, 1);
            if (watcher != null) watcher.Join(1000);
            if (parent != IntPtr.Zero) CloseHandle(parent);
            // Never remove this launch's ACL grants before its entire child tree terminates.
            bool canRestore = true;
            if (job != IntPtr.Zero)
            {
                if (assigned)
                {
                    TerminateJobObject(job, 125);
                    canRestore = WaitForJobExit();
                }
                CloseHandle(job);
            }
            if (attributeList != IntPtr.Zero) DeleteProcThreadAttributeList(attributeList);
            foreach (IntPtr handle in inheritedHandles) CloseHandle(handle);
            if (desktop != IntPtr.Zero) CloseDesktop(desktop);
            if (windowStation != IntPtr.Zero) CloseWindowStation(windowStation);
            if (token != IntPtr.Zero) CloseHandle(token);
            for (int index = grants.Count - 1; index >= 0; index--)
            {
                Grant grant = grants[index];
                try { if (canRestore) RemoveLaunchGrant(grant.handle); }
                catch (Exception error) { Console.Error.WriteLine("Sandbox ACL cleanup failed: " + error.Message); }
                grant.handle.Dispose();
            }
            if (!canRestore) Console.Error.WriteLine("Sandbox process termination was not confirmed; restrictive storage ACLs were retained.");
            foreach (IntPtr allocation in allocations) Marshal.FreeHGlobal(allocation);
        }
    }

    static void RemoveLaunchGrant(SafeFileHandle handle)
    {
        // Preserve current host/inherited ACEs and Low labels; remove only this launch's SID.
        IntPtr descriptor;
        uint status = GetSecurityInfo(handle, 1, DaclInformation, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
        if (status != 0) throw new Win32Exception((int)status, "Read current sandbox ACL for cleanup");
        RawAcl dacl;
        try
        {
            byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            dacl = new RawSecurityDescriptor(bytes, 0).DiscretionaryAcl;
        }
        finally { LocalFree(descriptor); }
        if (dacl == null) return;
        bool changed = false;
        for (int index = dacl.Count - 1; index >= 0; index--)
        {
            KnownAce ace = dacl[index] as KnownAce;
            if (ace != null && ace.SecurityIdentifier.Equals(launchSid))
            {
                dacl.RemoveAce(index);
                changed = true;
            }
        }
        if (!changed) return;
        status = SetSecurityInfo(handle, 1, DaclInformation, IntPtr.Zero, IntPtr.Zero, AclBytes(dacl), IntPtr.Zero);
        if (status != 0) throw new Win32Exception((int)status, "Remove launch-specific sandbox grants");
    }

    static bool WaitForJobExit()
    {
        Stopwatch deadline = Stopwatch.StartNew();
        while (deadline.ElapsedMilliseconds < 10000)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
            if (!QueryInformationJobObject(job, 1, out information, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) return false;
            if (information.activeProcesses == 0) return true;
            Thread.Sleep(10);
        }
        return false;
    }

    static void Validate(Configuration config)
    {
        if (config == null || config.args == null || config.environment == null || config.parentPid <= 0 ||
            config.writableRoots == null || config.writableRoots.Length != 2 ||
            config.protectedRoots == null || config.protectedRoots.Length == 0)
            throw new InvalidOperationException("Incomplete sandbox policy.");
        config.executable = NativePath(config.executable);
        config.workingDirectory = NativePath(config.workingDirectory);
        for (int i = 0; i < config.writableRoots.Length; i++) config.writableRoots[i] = NativePath(config.writableRoots[i]);
        for (int i = 0; i < config.protectedRoots.Length; i++) config.protectedRoots[i] = NativePath(config.protectedRoots[i]);
        if (Inside(config.writableRoots[0], config.writableRoots[1]) || Inside(config.writableRoots[1], config.writableRoots[0]))
            throw new InvalidOperationException("Writable roots overlap.");
        if (!Inside(config.workingDirectory, config.writableRoots[0])) throw new InvalidOperationException("Workspace is outside session storage.");
        foreach (string root in config.writableRoots)
        {
            if (!Directory.Exists(root)) throw new InvalidOperationException("Writable root must be a directory.");
            foreach (string protectedRoot in config.protectedRoots)
                if (Inside(root, protectedRoot) || Inside(protectedRoot, root)) throw new InvalidOperationException("Writable and protected roots overlap.");
        }
        foreach (KeyValuePair<string, string> entry in config.environment)
            if (String.IsNullOrEmpty(entry.Key) || entry.Key.IndexOfAny(new char[] { '=', '\0' }) >= 0 || entry.Value == null || entry.Value.IndexOf('\0') >= 0)
                throw new InvalidOperationException("Invalid environment entry.");
        foreach (string arg in config.args) if (arg == null || arg.IndexOf('\0') >= 0) throw new InvalidOperationException("Invalid argument.");
        // Capture the existing process handle now: a later PID reuse must not change the watchdog target.
        parent = OpenProcess(Synchronize, false, config.parentPid);
        if (parent == IntPtr.Zero) Fail("Open parent watchdog handle");
    }

    static bool Inside(string child, string parent)
    {
        return child.Equals(parent, StringComparison.OrdinalIgnoreCase) || child.StartsWith(parent.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    static string NativePath(string source)
    {
        if (String.IsNullOrEmpty(source) || source.IndexOf('\0') >= 0) throw new InvalidOperationException("Invalid path.");
        string path = Path.GetFullPath(source).TrimEnd('\\');
        if (path.Length < 3 || path[1] != ':' || path[2] != '\\' || path.IndexOf(':', 2) >= 0)
            throw new InvalidOperationException("Only local drive paths are supported.");
        string root = Path.GetPathRoot(path);
        if (new DriveInfo(root).DriveFormat != "NTFS") throw new InvalidOperationException("Sandbox paths require NTFS.");
        string cursor = root;
        foreach (string component in path.Substring(root.Length).Split('\\'))
        {
            if (component.Length == 0) continue;
            cursor = Path.Combine(cursor, component);
            using (SafeFileHandle handle = OpenMetadata(cursor, false)) CheckHandle(handle, cursor);
        }
        return path;
    }

    static SafeFileHandle OpenMetadata(string path, bool changeAcl)
    {
        uint access = 0x80 | ReadControl | (changeAcl ? WriteDac | WriteOwner : 0);
        SafeFileHandle handle = CreateFile(path, access, 7, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); Fail("Open sandbox metadata"); }
        return handle;
    }

    static BY_HANDLE_FILE_INFORMATION CheckHandle(SafeFileHandle handle, string expected)
    {
        BY_HANDLE_FILE_INFORMATION info;
        if (!GetFileInformationByHandle(handle, out info)) Fail("Read file identity");
        if ((info.attributes & ReparsePoint) != 0 || ((info.attributes & DirectoryAttribute) == 0 && info.links != 1))
            throw new InvalidOperationException("Reparse points and multiply linked files are not permitted in sandbox paths.");
        StringBuilder final = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
        if (length == 0 || length >= final.Capacity) Fail("Resolve native file identity");
        string resolved = final.ToString();
        if (!resolved.StartsWith("\\\\?\\", StringComparison.Ordinal) ||
            !resolved.Substring(4).TrimEnd('\\').Equals(expected.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Path and native file identity differ.");
        return info;
    }

    static void InspectTree(string path)
    {
        if (grants.Count >= 100000) throw new InvalidOperationException("Sandbox storage exceeds metadata inspection limit.");
        SafeFileHandle handle = OpenMetadata(path, true);
        try
        {
            BY_HANDLE_FILE_INFORMATION info = CheckHandle(handle, path);
            bool directory = (info.attributes & DirectoryAttribute) != 0;
            IntPtr descriptor;
            uint result = GetSecurityInfo(handle, 1, DaclInformation | LabelInformation, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
            if (result != 0) throw new Win32Exception((int)result, "Read sandbox ACL");
            RawSecurityDescriptor original;
            try { byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor, bytes, 0, bytes.Length); original = new RawSecurityDescriptor(bytes, 0); }
            finally { LocalFree(descriptor); }
            grants.Add(new Grant { handle = handle, original = original, directory = directory, path = path });
            handle = null;
            if (directory) foreach (string child in Directory.GetFileSystemEntries(path)) InspectTree(child);
        }
        finally { if (handle != null) handle.Dispose(); }
    }

    static RawAcl CloneAcl(RawAcl source, int extra)
    {
        RawAcl result = new RawAcl(2, (source == null ? 0 : source.Count) + extra);
        if (source != null) for (int i = 0; i < source.Count; i++) result.InsertAce(result.Count, source[i]);
        return result;
    }

    static void ApplyGrant(Grant grant, SecurityIdentifier sid)
    {
        // OWNER_RIGHTS suppresses the owner's implicit WRITE_DAC. No grant permits ACL/owner modification.
        RawAcl dacl = CloneAcl(grant.original.DiscretionaryAcl, 2);
        AceFlags flags = grant.directory ? AceFlags.ContainerInherit | AceFlags.ObjectInherit : AceFlags.None;
        int insertion = 0;
        while (insertion < dacl.Count)
        {
            QualifiedAce existing = dacl[insertion] as QualifiedAce;
            if (existing == null || (existing.AceFlags & AceFlags.Inherited) != 0 ||
                existing.AceQualifier != AceQualifier.AccessDenied) break;
            insertion++;
        }
        dacl.InsertAce(insertion, new CommonAce(flags, AceQualifier.AccessAllowed, (int)ReadControl, new SecurityIdentifier("S-1-3-4"), false, null));
        dacl.InsertAce(insertion + 1, new CommonAce(flags, AceQualifier.AccessAllowed, (int)(Modify | Synchronize), sid, false, null));
        RawSecurityDescriptor low = new RawSecurityDescriptor("S:(ML;OICI;NW;;;LW)");
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected | ControlFlags.SystemAclPresent,
            null, null, low.SystemAcl, dacl);
        SetDescriptor(grant.handle, descriptor);
    }

    static IntPtr Bytes(byte[] bytes)
    {
        IntPtr result = Marshal.AllocHGlobal(bytes.Length); allocations.Add(result); Marshal.Copy(bytes, 0, result, bytes.Length); return result;
    }
    static IntPtr AclBytes(RawAcl acl)
    {
        if (acl == null) return IntPtr.Zero;
        byte[] bytes = new byte[acl.BinaryLength]; acl.GetBinaryForm(bytes, 0); return Bytes(bytes);
    }
    static void SetDescriptor(SafeFileHandle handle, RawSecurityDescriptor descriptor)
    {
        uint information = DaclInformation | LabelInformation |
            ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 ? ProtectedDacl : UnprotectedDacl);
        uint result = SetSecurityInfo(handle, 1, information, IntPtr.Zero, IntPtr.Zero, AclBytes(descriptor.DiscretionaryAcl), AclBytes(descriptor.SystemAcl));
        if (result != 0) throw new Win32Exception((int)result, "Set sandbox ACL");
    }

    static SecurityIdentifier NewSid()
    {
        byte[] bytes = new byte[16]; using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
        return new SecurityIdentifier("S-1-5-21-" + BitConverter.ToUInt32(bytes, 0) + "-" + BitConverter.ToUInt32(bytes, 4) + "-" + BitConverter.ToUInt32(bytes, 8) + "-" + BitConverter.ToUInt32(bytes, 12));
    }
    static IntPtr SidBytes(SecurityIdentifier sid)
    {
        byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0); return Bytes(bytes);
    }
    static void PrepareToken(SecurityIdentifier sid, SecurityIdentifier user)
    {
        IntPtr current;
        if (!OpenProcessToken(GetCurrentProcess(), 0xf01ff, out current)) Fail("Open current token");
        try
        {
            SID_AND_ATTRIBUTES restrict = new SID_AND_ATTRIBUTES { sid = SidBytes(sid), attributes = 0 };
            // Only the launch-specific SID belongs to the restricting list. Do not add Everyone/Users.
            if (!CreateRestrictedToken(current, 1 | 4 | 8, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, ref restrict, out token)) Fail("Create restricted token");
        }
        finally { CloseHandle(current); }
        SID_AND_ATTRIBUTES low = new SID_AND_ATTRIBUTES { sid = SidBytes(new SecurityIdentifier("S-1-16-4096")), attributes = 0x20 };
        IntPtr mandatory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES))); allocations.Add(mandatory); Marshal.StructureToPtr(low, mandatory, false);
        if (!SetTokenInformation(token, 25, mandatory, Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)) + 12)) Fail("Set low integrity token");
        // A token default DACL applies to new kernel objects as well as files.
        // File Modify is not a process/thread/event access mask (it omits process
        // query rights, for example). Generic access maps to each object's type.
        // Existing host paths receive no new grants; the restricting list is
        // still solely the launch SID, and writable storage keeps its bounded ACL.
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor("D:(A;;GA;;;" + user.Value + ")(A;;GA;;;" + sid.Value + ")(A;;GA;;;SY)(A;;RC;;;OW)");
        IntPtr dacl = AclBytes(descriptor.DiscretionaryAcl);
        IntPtr value = Marshal.AllocHGlobal(IntPtr.Size); allocations.Add(value); Marshal.WriteIntPtr(value, dacl);
        if (!SetTokenInformation(token, 6, value, IntPtr.Size)) Fail("Set token default ACL");
    }

    static void VerifyBoundary(Configuration config)
    {
        if (!ImpersonateLoggedOnUser(token)) Fail("Impersonate final sandbox token");
        try
        {
            foreach (string root in config.writableRoots)
                using (SafeFileHandle handle = CreateFile(root, Modify, 7, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero))
                    if (handle.IsInvalid) Fail("Final token cannot access session storage");
            foreach (string root in config.protectedRoots)
                foreach (uint access in new uint[] { 2, 4, 0x10, 0x40, 0x100, 0x10000, WriteDac, WriteOwner })
                    using (SafeFileHandle handle = CreateFile(root, access, 7, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero))
                    {
                        if (!handle.IsInvalid) throw new InvalidOperationException("Final token can modify a protected root.");
                        int error = Marshal.GetLastWin32Error();
                        if (error != 5 && error != 1314) throw new Win32Exception(error, "Protected-root preflight did not establish access denial");
                    }
        }
        finally { if (!RevertToSelf()) Environment.FailFast("Cannot revert sandbox-token impersonation."); }
    }

    static void CreatePrivateDesktop(SecurityIdentifier sid, SecurityIdentifier user)
    {
        RawSecurityDescriptor acl = new RawSecurityDescriptor("D:(A;;GA;;;" + user.Value + ")(A;;GA;;;" + sid.Value + ")(A;;GA;;;SY)S:(ML;;NW;;;LW)");
        byte[] bytes = new byte[acl.BinaryLength]; acl.GetBinaryForm(bytes, 0);
        SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), descriptor = Bytes(bytes), inherit = false };
        // Standard users cannot supply a window-station name. Let Windows choose
        // the noninteractive logon station, without rewriting any existing ACL.
        // Each launch still owns a uniquely named, separately secured desktop.
        windowStation = CreateWindowStation(null, 0, 0x37f, ref security);
        if (windowStation == IntPtr.Zero) Fail("Open noninteractive window station");
        StringBuilder name = new StringBuilder(32768);
        uint required;
        if (!GetUserObjectInformation(windowStation, 2, name, (uint)(name.Capacity * 2), out required)) Fail("Read noninteractive window station name");
        string privateDesktop = "industrial-agent-" + Guid.NewGuid().ToString("N");
        originalStation = GetProcessWindowStation();
        if (!SetProcessWindowStation(windowStation)) Fail("Select private window station");
        try { desktop = CreateDesktop(privateDesktop, IntPtr.Zero, IntPtr.Zero, 0, 0x1ff, ref security); if (desktop == IntPtr.Zero) Fail("Create private desktop"); }
        finally { if (!SetProcessWindowStation(originalStation)) Environment.FailFast("Cannot restore host window station."); }
        desktopName = name.ToString() + "\\" + privateDesktop;
    }
    static string desktopName;

    static string Quote(string text)
    {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char value in text)
        {
            if (value == '\\') { slashes++; continue; }
            if (value == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(value); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static int Launch(Configuration config)
    {
        job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) Fail("Create process job");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.basic.flags = 0x2000;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) Fail("Set kill-on-close job");
        STARTUPINFOEX startup = new STARTUPINFOEX(); startup.info.size = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.info.desktop = desktopName; startup.info.flags = 0x100;
        IntPtr current = GetCurrentProcess();
        int[] ids = { -10, -11, -12 };
        foreach (int id in ids)
        {
            IntPtr duplicate;
            if (!DuplicateHandle(current, GetStdHandle(id), current, out duplicate, 0, true, 2)) Fail("Duplicate standard I/O");
            inheritedHandles.Add(duplicate);
        }
        startup.info.input = inheritedHandles[0]; startup.info.output = inheritedHandles[1]; startup.info.error = inheritedHandles[2];
        IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        attributeList = Marshal.AllocHGlobal(size); allocations.Add(attributeList);
        if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref size)) Fail("Create process attribute list");
        IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * 3); allocations.Add(handles);
        for (int i = 0; i < 3; i++) Marshal.WriteIntPtr(handles, i * IntPtr.Size, inheritedHandles[i]);
        if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) Fail("Restrict inherited handles");
        startup.attributes = attributeList;
        List<string> keys = new List<string>(config.environment.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
        StringBuilder environment = new StringBuilder(); foreach (string key in keys) environment.Append(key).Append('=').Append(config.environment[key]).Append('\0'); environment.Append('\0');
        IntPtr env = Bytes(Encoding.Unicode.GetBytes(environment.ToString()));
        StringBuilder command = new StringBuilder(Quote(config.executable)); foreach (string arg in config.args) command.Append(' ').Append(Quote(arg));
        PROCESS_INFORMATION process;
        Stage("create suspended target");
        if (!CreateProcessAsUser(token, config.executable, command, IntPtr.Zero, IntPtr.Zero, true, 4 | 0x400 | 0x80000, env, config.workingDirectory, ref startup, out process)) Fail("Create isolated agent");
        try
        {
            if (!AssignProcessToJobObject(job, process.process))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.process, 125);
                if (WaitForSingleObject(process.process, 10000) != 0) Environment.FailFast("Unassigned suspended process did not terminate.");
                throw new Win32Exception(error, "Assign suspended agent to job");
            }
            assigned = true;
            watcher = new Thread(delegate()
            {
                while (Interlocked.CompareExchange(ref finished, 0, 0) == 0)
                {
                    uint status = WaitForSingleObject(parent, 100);
                    if (status == 0) { TerminateJobObject(job, 125); return; }
                    if (status != 258) { TerminateJobObject(job, 125); return; }
                }
            }); watcher.IsBackground = true; watcher.Start();
            Stage("resume target");
            if (ResumeThread(process.thread) == UInt32.MaxValue) Fail("Resume isolated agent");
            Stage("wait for target");
            if (WaitForSingleObject(process.process, UInt32.MaxValue) != 0) Fail("Wait for isolated agent");
            uint code; if (!GetExitCodeProcess(process.process, out code)) Fail("Read agent exit code");
            if (code != 0) Console.Error.WriteLine("Windows agent target exited with status 0x" + code.ToString("X8"));
            return unchecked((int)code);
        }
        finally { CloseHandle(process.thread); CloseHandle(process.process); }
    }

    static void Fail(string operation) { throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr sid; public uint attributes; }
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
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
    [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr current, uint flags, uint disableCount, IntPtr disabled, uint privilegeCount, IntPtr privileges, uint restrictCount, ref SID_AND_ATTRIBUTES restricting, out IntPtr restricted);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool RevertToSelf();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowStation(string name, uint flags, uint access, ref SECURITY_ATTRIBUTES security);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr value, int index, StringBuilder information, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SECURITY_ATTRIBUTES security);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseWindowStation(IntPtr station);
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
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
    [DllImport("kernel32.dll")] static extern uint GetErrorMode();
}
