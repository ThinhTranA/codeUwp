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

static void WriteReport(const std::wstring& directory, const std::wstring& text)
{
    if (directory.empty())
    {
        return;
    }
    const std::wstring file = directory + L"\\tap-report.txt";
    HANDLE handle = CreateFileW(
        file.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
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

static std::wstring Hex(HRESULT hr)
{
    wchar_t buffer[32] = {};
    swprintf_s(buffer, L"0x%08X", static_cast<unsigned>(hr));
    return buffer;
}

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

        WriteReport(directory, report);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetSite(REFIID riid, void** ppv) override
    {
        if (!m_diagnostics) { return E_FAIL; }
        return m_diagnostics->QueryInterface(riid, ppv);
    }

    /// Called as the framework walks the tree. Not used by this spike, but the interface has
    /// to be implemented or the framework will not treat this as a diagnostics provider.
    HRESULT STDMETHODCALLTYPE OnVisualTreeChange(
        ParentChildRelation, VisualElement, VisualMutationType) override
    {
        return S_OK;
    }

private:
    ULONG m_refs = 1;
    IXamlDiagnostics* m_diagnostics = nullptr;
    IVisualTreeService* m_tree = nullptr;
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
