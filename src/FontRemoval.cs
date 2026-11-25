using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Litera
{
    internal static class FontRemoval
    {
        private const uint Recycle = 0x00080000;
        private const uint PreserveUndo = 0x0040;
        private const uint Silent = 0x0004;
        private const uint NoConfirmation = 0x0010;
        private const uint NoErrorUi = 0x0400;

        internal static string Remove(string[] files, IntPtr window)
        {
            if (files.Length == 0 || files.Any(file => !Catalog.IsUserFontPath(file)))
                return "Этим семейством можно управлять в настройках шрифтов Windows.";

            using (RegistryKey registration = Registry.CurrentUser.OpenSubKey(Catalog.RegistryPath, true))
            {
                var changed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                try
                {
                    foreach (string file in files)
                    {
                        if (!File.Exists(file))
                        {
                            changed.Add(file);
                            continue;
                        }
                        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) continue;
                        bool unloaded = RemoveFontResource(file);
                        try { RecycleFile(file, window); }
                        catch (COMException) { /* Check whether Explorer moved the file. */ }
                        if (File.Exists(file))
                        {
                            if (unloaded) AddFontResource(file);
                        }
                        else changed.Add(file);
                    }
                    if (registration != null) RemoveRegistrations(registration, changed);
                }
                finally
                {
                    if (changed.Count != 0)
                    {
                        UIntPtr unused;
                        SendMessageTimeout(new IntPtr(0xffff), 0x001D, UIntPtr.Zero, IntPtr.Zero, 2, 400, out unused);
                    }
                }
                if (changed.Count == files.Length) return null;
                return changed.Count > 0
                    ? "Часть начертаний отправлена в корзину. Остальные файлы заняты или защищены."
                    : "Windows не смогла переместить файлы в корзину. Закройте приложения, которые используют шрифт, и повторите операцию.";
            }
        }

        private static void RemoveRegistrations(RegistryKey registration, HashSet<string> changed)
        {
            foreach (string key in registration.GetValueNames())
            {
                string value = registration.GetValue(key) as string;
                if (String.IsNullOrWhiteSpace(value)) continue;
                string path = Environment.ExpandEnvironmentVariables(value);
                try
                {
                    if (!Path.IsPathRooted(path)) path = Path.Combine(Catalog.UserFonts, path);
                    if (changed.Contains(Path.GetFullPath(path))) registration.DeleteValue(key, false);
                }
                catch (ArgumentException) { /* Ignore malformed registrations for other fonts. */ }
            }
        }

        internal static void RecycleFile(string path, IntPtr window)
        {
            var operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(
                new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
            IShellItem item = null;
            try
            {
                operation.SetOwnerWindow(window);
                operation.SetOperationFlags(Recycle | PreserveUndo | Silent | NoConfirmation | NoErrorUi);
                Guid shellItem = typeof(IShellItem).GUID;
                Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, IntPtr.Zero, ref shellItem, out item));
                operation.DeleteItem(item, IntPtr.Zero);
                operation.PerformOperations();
            }
            finally
            {
                if (item != null) Marshal.ReleaseComObject(item);
                Marshal.ReleaseComObject(operation);
            }
        }

        [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
        private static extern bool RemoveFontResource(string file);
        [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
        private static extern int AddFontResource(string file);
        [DllImport("user32.dll")]
        private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam,
            uint flags, uint timeout, out UIntPtr result);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int SHCreateItemFromParsingName(string path, IntPtr bind, ref Guid id, out IShellItem item);

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem {}

        [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOperation
        {
            void Advise(IntPtr sink, out uint subscription);
            void Unadvise(uint subscription);
            void SetOperationFlags(uint flags);
            void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
            void SetProgressDialog(IntPtr dialog);
            void SetProperties(IntPtr properties);
            void SetOwnerWindow(IntPtr window);
            void ApplyPropertiesToItem(IShellItem item);
            void ApplyPropertiesToItems(IntPtr items);
            void RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
            void RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
            void MoveItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
            void MoveItems(IntPtr items, IShellItem destination);
            void CopyItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
            void CopyItems(IntPtr items, IShellItem destination);
            void DeleteItem(IShellItem item, IntPtr sink);
            void DeleteItems(IntPtr items);
            void NewItem(IShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name,
                [MarshalAs(UnmanagedType.LPWStr)] string template, IntPtr sink);
            void PerformOperations();
            void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
        }
    }
}
