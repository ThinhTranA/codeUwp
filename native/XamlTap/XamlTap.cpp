// A minimal XAML Diagnostics provider ("TAP"), injected into a running UWP app to prove the
// injection path works before anything is built on top of it.
//
// How it gets here: the host calls InitializeXamlDiagnosticsEx (exported from
// Windows.UI.Xaml.dll) with this DLL's path and CLSID and the target's pid. The XAML
// framework loads this DLL *inside the app*, creates the coclass below, and calls
// IObjectWithSite::SetSite with an object that QIs to IXamlDiagnostics. From that site the
// whole live visual tree is reachable.
//
// Constraints that are not obvious and are not documented together anywhere:
//   - The endpoint name must be exactly "VisualDiagConnection1"; anything else returns
//     ERROR_NOT_FOUND (0x80070490).
//   - This DLL must match the TARGET's architecture, not merely the host's.
//   - It runs inside the app's AppContainer, so it cannot read Program Files or write
//     arbitrary paths. Everything it touches must live in a directory the package's SID has
//     been granted access to; the host passes that directory as the initialization data.
//   - SetSite arrives on the app's UI thread. XAML may only be touched from that thread, so
//     doing real work here means doing it fast or marshalling it away.

#include <windows.h>
#include <unknwn.h>
#include <ocidl.h>

#undef GetCurrentTime
#include <xamlOM.h>

#include <string>
#include <vector>
#include <sstream>

// Must match the CLSID the host passes to InitializeXamlDiagnosticsEx.
// {2C7B1E44-9F3A-4D5E-B18C-6A0D5E7F2A91}
static const CLSID CLSID_UwpToolsTap =
{ 0x2c7b1e44, 0x9f3a, 0x4d5e, { 0xb1, 0x8c, 0x6a, 0x0d, 0x5e, 0x7f, 0x2a, 0x91 } };

static LONG g_objectCount = 0;
static HMODULE g_module = nullptr;

/// The directory this DLL was loaded from. Used as a fallback when the host supplies no
/// initialization data: it is by definition a place the AppContainer can already read.
static std::wstring ModuleDirectory()
{
    wchar_t path[MAX_PATH] = {};
    if (GetModuleFileNameW(g_module, path, MAX_PATH) == 0)
    {
        return L"";
    }
    std::wstring full(path);
    const size_t slash = full.find_last_of(L'\\');
    return slash == std::wstring::npos ? L"" : full.substr(0, slash);
}

static void WriteTextFile(const std::wstring& path, const std::wstring& text)
{
    HANDLE handle = CreateFileW(
        path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE)
    {
        return;
    }
    // UTF-16 with a BOM, so the host can read it without guessing an encoding.
    const wchar_t bom = 0xFEFF;
    DWORD written = 0;
    WriteFile(handle, &bom, sizeof(bom), &written, nullptr);
    WriteFile(handle, text.c_str(), static_cast<DWORD>(text.size() * sizeof(wchar_t)), &written, nullptr);
    CloseHandle(handle);
}

static void WriteReport(const std::wstring& directory, const std::wstring& text)
{
    if (directory.empty())
    {
        return;
    }
    WriteTextFile(directory + L"\\tap-report.txt", text);
}

static std::wstring Hex(HRESULT hr)
{
    wchar_t buffer[32] = {};
    swprintf_s(buffer, L"0x%08X", static_cast<unsigned>(hr));
    return buffer;
}

static std::wstring Num(unsigned long long value)
{
    wchar_t buffer[32] = {};
    swprintf_s(buffer, L"%llu", value);
    return buffer;
}

/// Tabs and newlines are the record and field separators, so any value carrying them would
/// silently corrupt the row. XAML type and property names never contain them; user-authored
/// x:Name values are not supposed to either, but "not supposed to" is not a guarantee worth
/// betting a parser on.
static std::wstring Escape(const wchar_t* value)
{
    std::wstring out;
    if (!value)
    {
        return out;
    }
    for (const wchar_t* p = value; *p; ++p)
    {
        switch (*p)
        {
        case L'\t': out += L"\\t"; break;
        case L'\r': out += L"\\r"; break;
        case L'\n': out += L"\\n"; break;
        case L'\\': out += L"\\\\"; break;
        default: out += *p; break;
        }
    }
    return out;
}

/// One node of the live visual tree, flattened. Parent and child index are kept rather than a
/// nested structure so the host can rebuild the tree itself and so a row stays one line.
struct TreeNode
{
    unsigned long long handle = 0;
    unsigned long long parent = 0;
    unsigned int childIndex = 0;
    std::wstring type;
    std::wstring name;
    std::wstring sourceFile;
    unsigned int sourceLine = 0;
};

class Tap final : public IObjectWithSite, public IVisualTreeServiceCallback
{
public:
    Tap() { InterlockedIncrement(&g_objectCount); }
    ~Tap()
    {
        if (m_diagnostics) { m_diagnostics->Release(); }
        if (m_tree) { m_tree->Release(); }
        InterlockedDecrement(&g_objectCount);
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override
    {
        if (!ppv) { return E_POINTER; }
        if (riid == IID_IUnknown || riid == __uuidof(IObjectWithSite))
        {
            *ppv = static_cast<IObjectWithSite*>(this);
        }
        else if (riid == __uuidof(IVisualTreeServiceCallback))
        {
            *ppv = static_cast<IVisualTreeServiceCallback*>(this);
        }
        else
        {
            *ppv = nullptr;
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&m_refs); }

    ULONG STDMETHODCALLTYPE Release() override
    {
        const ULONG remaining = InterlockedDecrement(&m_refs);
        if (remaining == 0) { delete this; }
        return remaining;
    }

    /// Where the framework hands over the live diagnostics session. Everything this spike is
    /// meant to prove is established here.
    HRESULT STDMETHODCALLTYPE SetSite(IUnknown* site) override
    {
        if (!site)
        {
            return S_OK;
        }

        std::wstring report;
        report += L"loaded            = yes\r\n";

        wchar_t pid[32] = {};
        swprintf_s(pid, L"%lu", GetCurrentProcessId());
        report += L"pid               = ";
        report += pid;
        report += L"\r\n";

        const HRESULT hrDiag = site->QueryInterface(
            __uuidof(IXamlDiagnostics), reinterpret_cast<void**>(&m_diagnostics));
        report += L"IXamlDiagnostics  = ";
        report += SUCCEEDED(hrDiag) ? L"OK" : Hex(hrDiag);
        report += L"\r\n";

        std::wstring directory;

        if (SUCCEEDED(hrDiag) && m_diagnostics)
        {
            BSTR data = nullptr;
            const HRESULT hrData = m_diagnostics->GetInitializationData(&data);
            if (SUCCEEDED(hrData) && data)
            {
                directory = data;
                SysFreeString(data);
            }
            report += L"initializationData= ";
            report += directory.empty() ? Hex(hrData) : directory;
            report += L"\r\n";

            const HRESULT hrTree = m_diagnostics->QueryInterface(
                __uuidof(IVisualTreeService), reinterpret_cast<void**>(&m_tree));
            report += L"IVisualTreeService= ";
            report += SUCCEEDED(hrTree) ? L"OK" : Hex(hrTree);
            report += L"\r\n";

            // IVisualTreeService3 is what carries the hot-reload verbs this project needs
            // (CreateInstance / SetProperty / ReplaceResource live on it and its ancestors),
            // so whether this app's framework offers it is the question worth answering now
            // rather than at the point of writing the reload engine.
            IVisualTreeService3* tree3 = nullptr;
            const HRESULT hrTree3 = m_diagnostics->QueryInterface(
                __uuidof(IVisualTreeService3), reinterpret_cast<void**>(&tree3));
            report += L"IVisualTreeService3=";
            report += SUCCEEDED(hrTree3) ? L"OK" : Hex(hrTree3);
            report += L"\r\n";
            if (tree3) { tree3->Release(); }
        }

        if (directory.empty())
        {
            directory = ModuleDirectory();
            report += L"reportDirectory   = (fell back to module directory)\r\n";
        }

        // Enumerate the live tree. AdviseVisualTreeChange replays what already exists as Add
        // notifications before returning, so by the time it comes back m_nodes holds the
        // current tree. There is no separate "read the tree" call to make.
        if (m_tree)
        {
            const HRESULT hrAdvise = m_tree->AdviseVisualTreeChange(this);
            report += L"AdviseVisualTree  = ";
            report += SUCCEEDED(hrAdvise) ? L"OK" : Hex(hrAdvise);
            report += L"\r\n";
            report += L"elements          = ";
            report += Num(m_nodes.size());
            report += L"\r\n";
            if (SUCCEEDED(hrAdvise))
            {
                WriteTree(directory);
            }
        }

        WriteReport(directory, report);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetSite(REFIID riid, void** ppv) override
    {
        if (!m_diagnostics) { return E_FAIL; }
        return m_diagnostics->QueryInterface(riid, ppv);
    }

    /// <summary>
    /// The framework's running commentary on the visual tree.
    ///
    /// Calling AdviseVisualTreeChange replays the tree that already exists as a burst of Add
    /// notifications, then keeps sending them as it changes — so this is both the enumeration
    /// mechanism and the live feed; there is no separate "get the tree" call.
    ///
    /// This arrives on the app's UI thread, which is the only thread XAML may be touched from.
    /// Nothing here does real work for that reason: it records and returns.
    /// </summary>
    HRESULT STDMETHODCALLTYPE OnVisualTreeChange(
        ParentChildRelation relation, VisualElement element, VisualMutationType mutation) override
    {
        if (mutation == VisualMutationType::Add)
        {
            TreeNode node;
            node.handle = element.Handle;
            node.parent = relation.Parent;
            node.childIndex = relation.ChildIndex;
            node.type = Escape(element.Type);
            node.name = Escape(element.Name);
            // Populated only when ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO was set at process
            // start; without it these are empty and an element cannot be traced to markup.
            node.sourceFile = Escape(element.SrcInfo.FileName);
            node.sourceLine = element.SrcInfo.LineNumber;
            m_nodes.push_back(std::move(node));
        }
        else
        {
            // A Remove during the initial replay would mean the tree changed under us; drop
            // the node so the snapshot stays consistent with what is actually there.
            for (size_t i = 0; i < m_nodes.size(); ++i)
            {
                if (m_nodes[i].handle == element.Handle)
                {
                    m_nodes.erase(m_nodes.begin() + static_cast<ptrdiff_t>(i));
                    break;
                }
            }
        }
        return S_OK;
    }

private:
    /// Writes the flattened tree as TSV. One line per element, fixed columns, so the host can
    /// parse it without a dependency and a truncated write is detectable.
    void WriteTree(const std::wstring& directory) const
    {
        std::wostringstream out;
        out << L"handle\tparent\tindex\ttype\tname\tsourceFile\tsourceLine\r\n";
        for (const TreeNode& node : m_nodes)
        {
            out << Num(node.handle) << L'\t'
                << Num(node.parent) << L'\t'
                << node.childIndex << L'\t'
                << node.type << L'\t'
                << node.name << L'\t'
                << node.sourceFile << L'\t'
                << node.sourceLine << L"\r\n";
        }
        WriteTextFile(directory + L"\\tree.tsv", out.str());
    }

    ULONG m_refs = 1;
    IXamlDiagnostics* m_diagnostics = nullptr;
    IVisualTreeService* m_tree = nullptr;
    std::vector<TreeNode> m_nodes;
};

class TapFactory final : public IClassFactory
{
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override
    {
        if (!ppv) { return E_POINTER; }
        if (riid == IID_IUnknown || riid == IID_IClassFactory)
        {
            *ppv = static_cast<IClassFactory*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }

    HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override
    {
        if (outer) { return CLASS_E_NOAGGREGATION; }
        Tap* tap = new (std::nothrow) Tap();
        if (!tap) { return E_OUTOFMEMORY; }
        const HRESULT hr = tap->QueryInterface(riid, ppv);
        tap->Release();
        return hr;
    }

    HRESULT STDMETHODCALLTYPE LockServer(BOOL) override { return S_OK; }
};

static TapFactory g_factory;

extern "C" BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        g_module = instance;
        DisableThreadLibraryCalls(instance);
    }
    return TRUE;
}

extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv)
{
    if (rclsid != CLSID_UwpToolsTap) { return CLASS_E_CLASSNOTAVAILABLE; }
    return g_factory.QueryInterface(riid, ppv);
}

extern "C" HRESULT __stdcall DllCanUnloadNow()
{
    return g_objectCount == 0 ? S_OK : S_FALSE;
}
