using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Fonty")]
[assembly: AssemblyProduct("Fonty")]
[assembly: AssemblyDescription("Коллекция шрифтов")]
[assembly: AssemblyVersion("1.4.2.0")]

namespace Litera
{
    internal static class Program
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibrary(string filename);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

        [STAThread]
        private static void Main()
        {
            AppDomain.CurrentDomain.AssemblyResolve += Resolve;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
                string appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Litera");
                LoadNative(appData);
                Run(appData);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Не удалось открыть Fonty.\n\n" + ex.Message, "Fonty", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        internal static Stream Resource(string name)
        {
            return typeof(Program).Assembly.GetManifestResourceStream(name);
        }

        internal static string Json(object value)
        {
            return new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue }.Serialize(value);
        }

        private static Assembly Resolve(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name;
            if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
            using (Stream resource = Resource(name + ".dll"))
            using (var bytes = new MemoryStream())
            {
                resource.CopyTo(bytes);
                return Assembly.Load(bytes.ToArray());
            }
        }

        private static void LoadNative(string appData)
        {
            string directory = Path.Combine(appData, "runtime", "4370.26");
            Directory.CreateDirectory(directory);
            string loader = Path.Combine(directory, "WebView2Loader.dll");
            if (!File.Exists(loader))
            {
                string temporary = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".tmp");
                try
                {
                    using (Stream resource = Resource("WebView2Loader.dll"))
                    using (Stream output = File.Create(temporary))
                        resource.CopyTo(output);
                    try { File.Move(temporary, loader); }
                    catch (IOException) { if (!File.Exists(loader)) throw; }
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
            if (LoadLibrary(loader) == IntPtr.Zero)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void Run(string appData)
        {
            Application.Run(new LiteraWindow(appData));
        }
    }

    internal sealed class LiteraWindow : Form
    {
        private const string Origin = "https://litera.local";
        private const int CalculateNonClient = 0x0083, NonClientHitTest = 0x0084;
        private const int HitLeft = 10, HitRight = 11, HitTop = 12, HitTopLeft = 13, HitTopRight = 14;
        private const int HitBottom = 15, HitBottomLeft = 16, HitBottomRight = 17;
        private readonly string appData;
        private readonly WebView2 view = new WebView2();
        private readonly Dictionary<int, Catalog> catalogs = new Dictionary<int, Catalog>();
        private int revision;
        private bool removing;
        private bool? maximizedReported;
        private static readonly Dictionary<string, string> Assets = new Dictionary<string, string>
        {
            { "index.html", "text/html; charset=utf-8" }, { "style.css", "text/css; charset=utf-8" },
            { "app.js", "text/javascript; charset=utf-8" }, { "google.js", "text/javascript; charset=utf-8" },
            { "workspaces.js", "text/javascript; charset=utf-8" },
            { "mark.svg", "image/svg+xml" },
            { "google-catalog.json", "application/json; charset=utf-8" }, { "license.txt", "text/plain; charset=utf-8" }
        };

        internal LiteraWindow(string appData)
        {
            this.appData = appData;
            Text = "Fonty";
            FormBorderStyle = FormBorderStyle.None;
            using (Stream icon = Program.Resource("Fonty.ico")) Icon = new Icon(icon);
            BackColor = Color.FromArgb(249, 243, 240);
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(1340, 880);
            MinimumSize = new Size(700, 530);
            view.DefaultBackgroundColor = BackColor;
            view.Dock = DockStyle.Fill;
            view.AllowExternalDrop = false;
            Controls.Add(view);
            Shown += Open;
            Resize += (s, e) => ReportWindow();
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var parameters = base.CreateParams;
                const int sizeableWindow = 0x00040000, windowSystemMenu = 0x00080000;
                const int minimizeBox = 0x00020000, maximizeBox = 0x00010000;
                parameters.Style |= sizeableWindow | windowSystemMenu | minimizeBox | maximizeBox;
                return parameters;
            }
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")]
        private static extern bool IsZoomed(IntPtr window);
        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr window, out Rect bounds);
        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromRect(ref Rect bounds, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo information);

        [StructLayout(LayoutKind.Sequential)]
        private struct Rect
        {
            internal int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MonitorInfo
        {
            internal int Size;
            internal Rect Monitor;
            internal Rect Work;
            internal uint Flags;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            const int cornerPreference = 33, borderColor = 34;
            int rounded = 2, noBorder = unchecked((int)0xFFFFFFFE);
            DwmSetWindowAttribute(Handle, cornerPreference, ref rounded, sizeof(int));
            DwmSetWindowAttribute(Handle, borderColor, ref noBorder, sizeof(int));
            const uint recalculateFrame = 0x0037;
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, recalculateFrame);
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == CalculateNonClient && message.WParam != IntPtr.Zero)
            {
                // Fill the window with our own title bar. Keep maximized content inside the monitor's work area.
                if (IsZoomed(message.HWnd))
                {
                    var proposed = (Rect)Marshal.PtrToStructure(message.LParam, typeof(Rect));
                    var monitor = MonitorFromRect(ref proposed, 2);
                    var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
                    if (GetMonitorInfo(monitor, ref info))
                    {
                        proposed.Left = Math.Max(proposed.Left, info.Work.Left);
                        proposed.Top = Math.Max(proposed.Top, info.Work.Top);
                        proposed.Right = Math.Min(proposed.Right, info.Work.Right);
                        proposed.Bottom = Math.Min(proposed.Bottom, info.Work.Bottom);
                        Marshal.StructureToPtr(proposed, message.LParam, false);
                    }
                }
                message.Result = IntPtr.Zero;
                return;
            }
            if (message.Msg == NonClientHitTest && !IsZoomed(message.HWnd))
            {
                int hit = ResizeEdge(message.HWnd, message.LParam);
                if (hit != 0)
                {
                    message.Result = new IntPtr(hit);
                    return;
                }
            }
            base.WndProc(ref message);
        }

        private static int ResizeEdge(IntPtr window, IntPtr coordinates)
        {
            Rect bounds;
            if (!GetWindowRect(window, out bounds)) return 0;
            long packed = coordinates.ToInt64();
            int x = unchecked((short)packed), y = unchecked((short)(packed >> 16));
            if (x < bounds.Left || x >= bounds.Right || y < bounds.Top || y >= bounds.Bottom) return 0;
            int edge = Math.Max(5, (int)(6 * GetDpiForWindow(window) / 96));
            bool left = x < bounds.Left + edge, right = x >= bounds.Right - edge;
            if (y < bounds.Top + edge) return left ? HitTopLeft : (right ? HitTopRight : HitTop);
            if (y >= bounds.Bottom - edge) return left ? HitBottomLeft : (right ? HitBottomRight : HitBottom);
            if (left) return HitLeft;
            if (right) return HitRight;
            return 0;
        }

        private void ReportWindow()
        {
            if (view.IsDisposed || view.CoreWebView2 == null) return;
            bool maximized = WindowState == FormWindowState.Maximized;
            if (maximizedReported == maximized) return;
            maximizedReported = maximized;
            Post(new { type = "window", maximized });
        }

        private void Post(object message)
        {
            if (!IsDisposed && !view.IsDisposed && view.CoreWebView2 != null)
                view.CoreWebView2.PostWebMessageAsJson(Program.Json(message));
        }

        private async void HandleMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            if (!String.Equals(args.Source, Origin + "/", StringComparison.Ordinal)) return;
            string message;
            try { message = args.TryGetWebMessageAsString(); }
            catch (ArgumentException) { return; }
            if (message == "minimize") WindowState = FormWindowState.Minimized;
            else if (message == "maximize") WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
            else if (message == "close") Close();
            else if (message.StartsWith("copy:", StringComparison.Ordinal))
            {
                string text = message.Substring(5);
                if (text.Length == 0 || text.Length > 1024) return;
                try
                {
                    Clipboard.SetDataObject(text, true, 3, 60);
                    Post(new { type = "status", message = "Скопировано для Figma." });
                }
                catch (ExternalException)
                {
                    Post(new { type = "status", message = "Не удалось скопировать. Попробуйте ещё раз." });
                }
            }
            else if (message == "fonts-settings")
            {
                try { Process.Start(new ProcessStartInfo("ms-settings:fonts") { UseShellExecute = true }); }
                catch (System.ComponentModel.Win32Exception) { Post(new { type = "status", message = "Не удалось открыть настройки шрифтов Windows." }); }
            }
            else if (message.StartsWith("remove:", StringComparison.Ordinal))
            {
                if (removing) return;
                string[] fields = message.Split(':');
                int version, id;
                Catalog catalog;
                string[] paths;
                if (fields.Length != 3 || !Int32.TryParse(fields[1], out version) ||
                    !Int32.TryParse(fields[2], out id) || version != revision ||
                    !catalogs.TryGetValue(version, out catalog) || id < 0 || id >= catalog.Sources.Count ||
                    !catalog.RemovalPaths.TryGetValue(catalog.Sources[id].Family, out paths))
                {
                    Post(new { type = "removal", success = false, message = "Список шрифтов изменился. Закройте окно и выберите семейство снова." });
                    return;
                }
                removing = true;
                IntPtr window = Handle;
                var completion = new TaskCompletionSource<string>();
                var thread = new Thread(() =>
                {
                    try { completion.SetResult(FontRemoval.Remove(paths, window)); }
                    catch (Exception) { completion.SetResult("Не удалось удалить семейство. Проверьте список в настройках шрифтов Windows."); }
                });
                thread.IsBackground = true;
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                string failure = await completion.Task;
                removing = false;
                Post(new { type = "removal", success = failure == null, message = failure });
            }
        }

        private async void Open(object sender, EventArgs args)
        {
            try
            {
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(appData, "profile"));
                if (IsDisposed) return;
                await view.EnsureCoreWebView2Async(environment);
                if (IsDisposed) return;
                var core = view.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.Settings.AreHostObjectsAllowed = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = true;
                core.Settings.IsNonClientRegionSupportEnabled = true;
                core.WebMessageReceived += HandleMessage;
                core.NavigationCompleted += (s, e) => { maximizedReported = null; ReportWindow(); };
                core.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All,
                    CoreWebView2WebResourceRequestSourceKinds.All);
                core.WebResourceRequested += Respond;
                core.NavigationStarting += (s, e) => e.Cancel = !e.Uri.StartsWith(Origin + "/", StringComparison.Ordinal);
                core.NewWindowRequested += (s, e) =>
                {
                    e.Handled = true;
                    Uri link;
                    if (Uri.TryCreate(e.Uri, UriKind.Absolute, out link) && link.Scheme == "https" &&
                        link.Host == "fonts.google.com" && link.AbsolutePath.StartsWith("/specimen/", StringComparison.Ordinal))
                        Process.Start(new ProcessStartInfo(link.AbsoluteUri) { UseShellExecute = true });
                };
                core.Navigate(Origin + "/");
            }
            catch (Exception ex)
            {
                if (IsDisposed) return;
                MessageBox.Show(this, "Не удалось открыть окно Fonty.\n\n" + ex.Message,
                    "Fonty", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }


        private async void Respond(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            var core = (CoreWebView2)sender;
            var uri = new Uri(e.Request.Uri);
            var environment = core.Environment;
            using (var deferral = e.GetDeferral())
            {
                try
                {
                    string path = uri.AbsolutePath.TrimStart('/');
                    if (e.Request.Method != "GET")
                    {
                        e.Response = Response(environment, null, "text/plain", 405, "Method Not Allowed");
                        return;
                    }
                    if (path == "api/fonts")
                    {
                        var catalog = await Task.Run(() => Catalog.Scan());
                        int version = ++revision;
                        catalogs.Add(version, catalog);
                        if (version > 2) catalogs.Remove(version - 2);
                        string json = Program.Json(new { revision = version, catalog.families, catalog.skipped });
                        e.Response = Response(environment, new MemoryStream(Encoding.UTF8.GetBytes(json)), "application/json; charset=utf-8");
                        return;
                    }
                    if (path.StartsWith("font/", StringComparison.Ordinal))
                    {
                        string[] ids = path.Split('/');
                        int version, id;
                        Catalog catalog;
                        if (ids.Length == 3 && Int32.TryParse(ids[1], out version) && Int32.TryParse(ids[2], out id) &&
                            catalogs.TryGetValue(version, out catalog) && id >= 0 && id < catalog.Sources.Count)
                        {
                            e.Response = Response(environment, catalog.Sources[id].Open(), "application/font-sfnt");
                            return;
                        }
                    }
                    string type;
                    if (path.Length == 0) path = "index.html";
                    if (Assets.TryGetValue(path, out type))
                        e.Response = Response(environment, Program.Resource(path), type);
                    else
                        e.Response = Response(environment, null, "text/plain", 404, "Not Found");
                }
                catch (Exception)
                {
                    if (!IsDisposed) e.Response = Response(environment, null, "text/plain", 500, "Unavailable");
                }
            }
        }

        private static CoreWebView2WebResourceResponse Response(CoreWebView2Environment environment, Stream contents,
            string type, int status = 200, string reason = "OK")
        {
            const string policy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://fonts.googleapis.com; img-src 'self' data:; base-uri 'none'; form-action 'none'";
            return environment.CreateWebResourceResponse(contents ?? new MemoryStream(), status, reason,
                "Content-Type: " + type + "\r\nCache-Control: no-store\r\nContent-Security-Policy: " + policy);
        }
    }
}
