using System.ComponentModel;
using System.Runtime.CompilerServices;

using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace ClassicUwpWinUI2
{
    public sealed partial class MainPage : Page, INotifyPropertyChanged
    {
        int _clickCount;

        public MainPage()
        {
            InitializeComponent();
        }

        /// <summary>
        /// Bound with x:Bind rather than Binding, deliberately: compiled bindings are what make
        /// a XamlReader.Load-based hot reload useless on real pages, so the sample has one.
        /// </summary>
        public string ClickCountText => _clickCount == 0
            ? "not clicked yet"
            : $"clicked {_clickCount} time{(_clickCount == 1 ? "" : "s")}";

        public event PropertyChangedEventHandler PropertyChanged;

        void OnCounterClick(object sender, RoutedEventArgs e)
        {
            _clickCount++;
            OnPropertyChanged(nameof(ClickCountText));
        }

        void OnPropertyChanged([CallerMemberName] string propertyName = null)
            => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}
