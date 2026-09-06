using System;

using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Navigation;

namespace ClassicUwpWinUI2
{
    /// <summary>
    /// The sample the extension's inner loop is developed against: classic UWP (flavour A),
    /// which runs on CoreCLR in Debug and is therefore the one flavour a managed debugger
    /// can attach to at all.
    /// </summary>
    sealed partial class App : Application
    {
        public App()
        {
            // Startup crashes in a packaged app leave nothing useful behind: WER records only
            // "unhandled exception e0434352" with no stack, and the report folder needs
            // elevation to read. Writing the exception into the app's own LocalState is the
            // one channel that always works from inside an AppContainer.
            UnhandledException += (s, e) => Log("UnhandledException", e.Exception);

            try
            {
                InitializeComponent();
            }
            catch (Exception ex)
            {
                Log("App.InitializeComponent", ex);
                throw;
            }

            Suspending += OnSuspending;
        }

        internal static void Log(string stage, Exception ex)
        {
            try
            {
                var path = System.IO.Path.Combine(
                    Windows.Storage.ApplicationData.Current.LocalFolder.Path, "crash.txt");
                System.IO.File.AppendAllText(path,
                    $"[{DateTime.Now:HH:mm:ss}] {stage}{System.Environment.NewLine}{ex}{System.Environment.NewLine}{System.Environment.NewLine}");
            }
            catch
            {
                // A logger that throws during a crash makes the crash harder to read, not easier.
            }
        }

        protected override void OnLaunched(LaunchActivatedEventArgs e)
        {
            try
            {
                LaunchCore(e);
            }
            catch (Exception ex)
            {
                Log("OnLaunched", ex);
                throw;
            }
        }

        /// <summary>
        /// Records what the process actually received at startup, so the launcher's claims can
        /// be checked rather than believed. ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO is the one that
        /// matters: XAML hot reload needs it set at process start, and EnableDebugging is the
        /// only way to get any environment variable into an AppContainer.
        /// </summary>
        static void RecordStartup()
        {
            try
            {
                var path = System.IO.Path.Combine(
                    Windows.Storage.ApplicationData.Current.LocalFolder.Path, "startup.txt");
                var lines = new[]
                {
                    $"time              = {DateTime.Now:HH:mm:ss.fff}",
                    $"pid               = {System.Diagnostics.Process.GetCurrentProcess().Id}",
                    $"debuggerAttached  = {System.Diagnostics.Debugger.IsAttached}",
                    $"XAML_DIAG_SOURCE  = {Environment.GetEnvironmentVariable("ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO") ?? "(not set)"}",
                    $"UWP_TOOLS_MARKER  = {Environment.GetEnvironmentVariable("UWP_TOOLS_MARKER") ?? "(not set)"}",
                    ""
                };
                System.IO.File.WriteAllText(path, string.Join(System.Environment.NewLine, lines));
            }
            catch
            {
                // Diagnostics must never be the reason a launch fails.
            }
        }

        void LaunchCore(LaunchActivatedEventArgs e)
        {
            RecordStartup();

            // The breakpoint that proves from-birth attach works. If the debugger is only
            // attached after activation, this line is long gone by the time it lands.
            var rootFrame = Window.Current.Content as Frame;

            if (rootFrame == null)
            {
                rootFrame = new Frame();
                rootFrame.NavigationFailed += OnNavigationFailed;
                Window.Current.Content = rootFrame;
            }

            if (!e.PrelaunchActivated)
            {
                if (rootFrame.Content == null)
                {
                    rootFrame.Navigate(typeof(MainPage), e.Arguments);
                }

                Window.Current.Activate();
            }
        }

        void OnNavigationFailed(object sender, NavigationFailedEventArgs e)
        {
            throw new Exception("Failed to load Page " + e.SourcePageType.FullName);
        }

        void OnSuspending(object sender, SuspendingEventArgs e)
        {
            var deferral = e.SuspendingOperation.GetDeferral();
            deferral.Complete();
        }
    }
}
