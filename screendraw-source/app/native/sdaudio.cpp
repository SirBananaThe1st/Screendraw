// sdaudio.exe — ScreenDraw's Windows audio helper.
//
// Chromium can only capture *all* system audio. This helper uses WASAPI to
// capture exactly what the sharer chooses:
//   include:<pid>   one app (and its child processes)          [Windows 10 2004+]
//   exclude:<pid>   everything except one app (e.g. Discord)    [Windows 10 2004+]
//   window:<hwnd>   the app that owns a window (include)        [Windows 10 2004+]
//   device:<id>     everything played on one output device (e.g. "Chat" / "Game")
//
// Usage:
//   sdaudio list [hwnd]         -> JSON: output devices + apps that use audio
//   sdaudio capture SPEC...     -> binary frames on stdout until stdin closes;
//                                  more sources can be added with "add SPEC" lines on stdin
//
// Frame: 'S' u8 stream-index, u16 0, u32 byte-length (LE), then 16-bit stereo PCM.
// Status lines on stderr: "READY <idx> <rate>" / "ERROR <idx> <message>".
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <tlhelp32.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdarg>
#include <cstdint>
#include <string>
#include <vector>
#include <map>
#include <mutex>
#include <thread>
#include <atomic>
#include <algorithm>

/* ---------------------------------------------------------------- process loopback */
// From <audioclientactivationparams.h> (not in all SDKs).
enum SD_ACTIVATION_TYPE { SD_ACTIVATION_TYPE_DEFAULT = 0, SD_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1 };
enum SD_LOOPBACK_MODE { SD_LOOPBACK_INCLUDE_TREE = 0, SD_LOOPBACK_EXCLUDE_TREE = 1 };
struct SD_PROCESS_LOOPBACK_PARAMS { DWORD TargetProcessId; SD_LOOPBACK_MODE ProcessLoopbackMode; };
struct SD_ACTIVATION_PARAMS { SD_ACTIVATION_TYPE ActivationType; SD_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; };
static const wchar_t *PROCESS_LOOPBACK_DEVICE = L"VAD\\Process_Loopback";

typedef HRESULT(WINAPI *ActivateAudioInterfaceAsyncFn)(LPCWSTR, REFIID, PROPVARIANT *, IActivateAudioInterfaceCompletionHandler *, IActivateAudioInterfaceAsyncOperation **);

// Completion handler for ActivateAudioInterfaceAsync. Must be agile (free-threaded).
class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  LONG refs = 1;
public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  IAudioClient *client = nullptr;
  ~ActivationHandler() { CloseHandle(done); }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs); }
  ULONG STDMETHODCALLTYPE Release() override { ULONG r = InterlockedDecrement(&refs); if (!r) delete this; return r; }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **out) override {
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) *out = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
    else if (iid == __uuidof(IAgileObject)) *out = static_cast<IAgileObject *>(this);
    else { *out = nullptr; return E_NOINTERFACE; }
    AddRef();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation *op) override {
    IUnknown *unk = nullptr;
    HRESULT hr = S_OK;
    HRESULT callHr = op->GetActivateResult(&hr, &unk);
    if (FAILED(callHr)) hr = callHr;
    if (SUCCEEDED(hr) && unk) hr = unk->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void **>(&client));
    if (unk) unk->Release();
    result = hr;
    SetEvent(done);
    return S_OK;
  }
};

/* ------------------------------------------------------------------------ output */
static std::mutex outLock;
static void writeFrame(uint8_t idx, const void *data, uint32_t bytes) {
  uint8_t header[8] = { 'S', idx, 0, 0, (uint8_t)(bytes & 255), (uint8_t)((bytes >> 8) & 255), (uint8_t)((bytes >> 16) & 255), (uint8_t)(bytes >> 24) };
  std::lock_guard<std::mutex> g(outLock);
  fwrite(header, 1, 8, stdout);
  if (bytes) fwrite(data, 1, bytes, stdout);
  fflush(stdout);
}
static void status(const char *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  std::lock_guard<std::mutex> g(outLock);
  vfprintf(stderr, fmt, ap); fputc('\n', stderr); fflush(stderr);
  va_end(ap);
}

static std::string utf8(const wchar_t *w) {
  if (!w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}
static std::string jsonStr(const std::string &s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}

/* --------------------------------------------------------------------- processes */
struct ProcInfo { DWORD parent; std::wstring exe; };
static std::map<DWORD, ProcInfo> snapshotProcesses() {
  std::map<DWORD, ProcInfo> m;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return m;
  PROCESSENTRY32W pe; pe.dwSize = sizeof pe;
  if (Process32FirstW(snap, &pe)) do { m[pe.th32ProcessID] = { pe.th32ParentProcessID, pe.szExeFile }; } while (Process32NextW(snap, &pe));
  CloseHandle(snap);
  return m;
}
static bool sameExe(const std::wstring &a, const std::wstring &b) { return _wcsicmp(a.c_str(), b.c_str()) == 0; }
// Apps like Discord or browsers play sound from a child process; capture from
// the top-most process of the same program so its whole tree is included.
static DWORD rootOf(DWORD pid, const std::map<DWORD, ProcInfo> &procs) {
  for (int guard = 0; guard < 32; guard++) {
    auto it = procs.find(pid);
    if (it == procs.end()) return pid;
    auto parent = procs.find(it->second.parent);
    if (parent == procs.end() || parent->first == pid || !sameExe(parent->second.exe, it->second.exe)) return pid;
    pid = parent->first;
  }
  return pid;
}
static std::string appName(const std::wstring &exe) {
  std::string n = utf8(exe.c_str());
  if (n.size() > 4 && _stricmp(n.c_str() + n.size() - 4, ".exe") == 0) n.resize(n.size() - 4);
  return n;
}

/* ------------------------------------------------------------------------- list */
static int listCommand(HWND window) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  auto procs = snapshotProcesses();
  DWORD self = GetCurrentProcessId();
  DWORD selfParent = procs.count(self) ? procs[self].parent : 0; // ScreenDraw itself
  DWORD selfRoot = rootOf(selfParent, procs);

  IMMDeviceEnumerator *en = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void **)&en))) {
    printf("{\"error\":\"audio devices unavailable\"}\n");
    return 1;
  }
  std::wstring defaultId;
  IMMDevice *def = nullptr;
  if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &def))) { LPWSTR id = nullptr; if (SUCCEEDED(def->GetId(&id))) { defaultId = id; CoTaskMemFree(id); } def->Release(); }

  std::string devices;
  std::map<DWORD, std::pair<std::string, bool>> apps; // root pid -> (name, active)
  IMMDeviceCollection *col = nullptr;
  if (SUCCEEDED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col))) {
    UINT count = 0; col->GetCount(&count);
    for (UINT i = 0; i < count; i++) {
      IMMDevice *dev = nullptr;
      if (FAILED(col->Item(i, &dev))) continue;
      LPWSTR id = nullptr; dev->GetId(&id);
      std::string name = "Output " + std::to_string(i + 1);
      IPropertyStore *props = nullptr;
      if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props))) {
        PROPVARIANT v; PropVariantInit(&v);
        if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = utf8(v.pwszVal);
        PropVariantClear(&v); props->Release();
      }
      if (!devices.empty()) devices += ",";
      devices += "{\"id\":" + jsonStr(utf8(id)) + ",\"name\":" + jsonStr(name) + ",\"default\":" + (id && defaultId == id ? "true" : "false") + "}";

      // Apps with audio sessions on this device
      IAudioSessionManager2 *mgr = nullptr;
      if (SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void **)&mgr))) {
        IAudioSessionEnumerator *sessions = nullptr;
        if (SUCCEEDED(mgr->GetSessionEnumerator(&sessions))) {
          int n = 0; sessions->GetCount(&n);
          for (int s = 0; s < n; s++) {
            IAudioSessionControl *ctl = nullptr;
            if (FAILED(sessions->GetSession(s, &ctl))) continue;
            IAudioSessionControl2 *ctl2 = nullptr;
            if (SUCCEEDED(ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void **)&ctl2))) {
              DWORD pid = 0;
              ctl2->GetProcessId(&pid);
              AudioSessionState st = AudioSessionStateInactive; ctl->GetState(&st);
              if (pid && procs.count(pid)) {
                DWORD root = rootOf(pid, procs);
                if (root != selfRoot && root != self) {
                  auto &e = apps[root];
                  e.first = appName(procs[root].exe);
                  e.second = e.second || st == AudioSessionStateActive;
                }
              }
              ctl2->Release();
            }
            ctl->Release();
          }
          sessions->Release();
        }
        mgr->Release();
      }
      if (id) CoTaskMemFree(id);
      dev->Release();
    }
    col->Release();
  }
  en->Release();

  std::string appJson;
  for (auto &a : apps) {
    if (!appJson.empty()) appJson += ",";
    appJson += "{\"pid\":" + std::to_string(a.first) + ",\"name\":" + jsonStr(a.second.first) + ",\"playing\":" + (a.second.second ? "true" : "false") + "}";
  }
  std::string win = "null";
  if (window) {
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (pid && procs.count(pid)) { DWORD root = rootOf(pid, procs); win = "{\"pid\":" + std::to_string(root) + ",\"name\":" + jsonStr(appName(procs[root].exe)) + "}"; }
  }
  OSVERSIONINFOW os = {}; // process loopback needs Windows 10 build 19041+
  typedef LONG(WINAPI * RtlGetVersionFn)(OSVERSIONINFOW *);
  os.dwOSVersionInfoSize = sizeof os;
  auto rtl = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  if (rtl) rtl(&os);
  bool perApp = os.dwMajorVersion > 10 || (os.dwMajorVersion == 10 && os.dwBuildNumber >= 19041);
  printf("{\"devices\":[%s],\"apps\":[%s],\"window\":%s,\"perApp\":%s}\n", devices.c_str(), appJson.c_str(), win.c_str(), perApp ? "true" : "false");
  return 0;
}

/* ---------------------------------------------------------------------- capture */
static std::atomic<bool> stopping(false);

static WAVEFORMATEX pcmFormat(DWORD rate) {
  WAVEFORMATEX f = {};
  f.wFormatTag = WAVE_FORMAT_PCM; f.nChannels = 2; f.nSamplesPerSec = rate; f.wBitsPerSample = 16;
  f.nBlockAlign = f.nChannels * f.wBitsPerSample / 8; f.nAvgBytesPerSec = f.nSamplesPerSec * f.nBlockAlign;
  return f;
}

static HRESULT activateProcessLoopback(DWORD pid, bool include, IAudioClient **out) {
  static auto activate = (ActivateAudioInterfaceAsyncFn)GetProcAddress(LoadLibraryW(L"Mmdevapi.dll"), "ActivateAudioInterfaceAsync");
  if (!activate) return E_NOTIMPL;
  SD_ACTIVATION_PARAMS params = {};
  params.ActivationType = SD_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = include ? SD_LOOPBACK_INCLUDE_TREE : SD_LOOPBACK_EXCLUDE_TREE;
  PROPVARIANT pv; PropVariantInit(&pv);
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof params;
  pv.blob.pBlobData = reinterpret_cast<BYTE *>(&params);
  auto *handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation *op = nullptr;
  HRESULT hr = activate(PROCESS_LOOPBACK_DEVICE, __uuidof(IAudioClient), &pv, handler, &op);
  if (SUCCEEDED(hr)) {
    WaitForSingleObject(handler->done, 10000);
    hr = handler->result;
    if (SUCCEEDED(hr)) { *out = handler->client; handler->client = nullptr; }
  }
  if (handler->client) handler->client->Release();
  if (op) op->Release();
  handler->Release();
  return hr;
}

static void captureThread(uint8_t idx, std::string spec) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  IAudioClient *client = nullptr;
  HRESULT hr = E_FAIL;
  bool processLoopback = false;
  auto procs = snapshotProcesses();
  std::string kind = spec.substr(0, spec.find(':'));
  std::string arg = spec.substr(spec.find(':') + 1);

  if (kind == "include" || kind == "exclude" || kind == "window") {
    DWORD pid = 0;
    if (kind == "window") GetWindowThreadProcessId((HWND)(uintptr_t)_strtoui64(arg.c_str(), nullptr, 10), &pid);
    else pid = (DWORD)strtoul(arg.c_str(), nullptr, 10);
    if (!pid) { status("ERROR %d app not found", idx); return; }
    pid = rootOf(pid, procs);
    hr = activateProcessLoopback(pid, kind != "exclude", &client);
    processLoopback = true;
    if (FAILED(hr)) { status("ERROR %d per-app audio isn't available (needs Windows 10 version 2004 or later) [0x%08lx]", idx, (unsigned long)hr); return; }
  } else if (kind == "device") {
    IMMDeviceEnumerator *en = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void **)&en);
    IMMDevice *dev = nullptr;
    if (SUCCEEDED(hr)) {
      int n = MultiByteToWideChar(CP_UTF8, 0, arg.c_str(), -1, nullptr, 0);
      std::wstring wid(n, L'\0'); MultiByteToWideChar(CP_UTF8, 0, arg.c_str(), -1, &wid[0], n);
      hr = en->GetDevice(wid.c_str(), &dev);
      en->Release();
    }
    if (SUCCEEDED(hr)) { hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void **)&client); dev->Release(); }
    if (FAILED(hr)) { status("ERROR %d output device not available [0x%08lx]", idx, (unsigned long)hr); return; }
  } else { status("ERROR %d unknown source %s", idx, spec.c_str()); return; }

  // 48 kHz 16-bit stereo, converted by Windows if the source differs.
  DWORD rate = 48000;
  WAVEFORMATEX fmt = pcmFormat(rate);
  HANDLE evt = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  const DWORD convert = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  bool useEvent = processLoopback; // device loopback is polled (works on all Windows 10/11 builds)
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | convert | (useEvent ? AUDCLNT_STREAMFLAGS_EVENTCALLBACK : 0), 2000000, 0, &fmt, nullptr);
  if (FAILED(hr) && processLoopback) { // older builds: try without conversion flags / at 44.1 kHz
    client->Release(); client = nullptr;
    DWORD pid = 0; // re-activate: a failed Initialize leaves the client unusable
    if (kind == "window") GetWindowThreadProcessId((HWND)(uintptr_t)_strtoui64(arg.c_str(), nullptr, 10), &pid); else pid = (DWORD)strtoul(arg.c_str(), nullptr, 10);
    pid = rootOf(pid, procs);
    if (SUCCEEDED(activateProcessLoopback(pid, kind != "exclude", &client))) {
      rate = 44100; fmt = pcmFormat(rate);
      hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 2000000, 0, &fmt, nullptr);
    }
  }
  if (FAILED(hr)) { status("ERROR %d couldn't start audio capture [0x%08lx]", idx, (unsigned long)hr); if (client) client->Release(); return; }
  if (useEvent) client->SetEventHandle(evt);

  IAudioCaptureClient *cap = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), (void **)&cap);
  if (FAILED(hr) || FAILED(client->Start())) { status("ERROR %d couldn't start audio capture [0x%08lx]", idx, (unsigned long)hr); client->Release(); return; }
  status("READY %d %lu", idx, (unsigned long)rate);

  std::vector<uint8_t> silence;
  while (!stopping) {
    if (useEvent) WaitForSingleObject(evt, 100); else Sleep(10);
    UINT32 packet = 0;
    while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE *data = nullptr; UINT32 frames = 0; DWORD flags = 0;
      if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      uint32_t bytes = frames * fmt.nBlockAlign;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        if (silence.size() < bytes) silence.assign(bytes, 0);
        writeFrame(idx, silence.data(), bytes);
      } else writeFrame(idx, data, bytes);
      cap->ReleaseBuffer(frames);
    }
  }
  client->Stop();
  cap->Release();
  client->Release();
  CloseHandle(evt);
}

static int captureCommand(int argc, wchar_t **argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  std::vector<std::thread> threads;
  int next = 0;
  for (int i = 2; i < argc && next < 64; i++) threads.emplace_back(captureThread, (uint8_t)next++, utf8(argv[i]));
  // "add SPEC" lines start more captures; ScreenDraw closing stdin stops everything.
  char line[1024];
  while (fgets(line, sizeof line, stdin)) {
    std::string l(line);
    while (!l.empty() && (l.back() == '\n' || l.back() == '\r')) l.pop_back();
    if (l.rfind("add ", 0) == 0 && next < 64) threads.emplace_back(captureThread, (uint8_t)next++, l.substr(4));
  }
  stopping = true;
  for (auto &t : threads) t.join();
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc >= 2 && wcscmp(argv[1], L"list") == 0) return listCommand(argc >= 3 ? (HWND)(uintptr_t)_wcstoui64(argv[2], nullptr, 10) : nullptr);
  if (argc >= 3 && wcscmp(argv[1], L"capture") == 0) return captureCommand(argc, argv);
  fprintf(stderr, "usage: sdaudio list [hwnd] | sdaudio capture include:<pid>|exclude:<pid>|window:<hwnd>|device:<id> ...\n");
  return 2;
}
