/*
 * ScreenDraw.exe (single-file) launcher.
 *
 * The app's files are appended to this exe as a 7z archive. On the first run
 * (or after an update) they are unpacked once to
 *   %LOCALAPPDATA%\ScreenDraw\app\<build-id>\
 * and every launch after that starts the app straight from there.
 *
 * Layout of ScreenDraw.exe:  [this launcher][7z archive][trailer]
 * trailer (40 bytes): "SDPAYLD1" | u64 archive offset | u64 archive size | 16-char build id
 *
 * Uses the public-domain LZMA SDK (7-Zip) decoder.
 * Build with -DSD_TEST on Linux to test the extractor: launcher <exe> <outdir>
 */
#include "7z.h"
#include "7zAlloc.h"
#include "7zBuf.h"
#include "7zCrc.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#ifdef _WIN32
#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>
#define FSEEK _fseeki64
#define FTELL _ftelli64
typedef wchar_t PCHAR_T;
#else
#include <sys/stat.h>
#include <errno.h>
#define FSEEK fseeko
#define FTELL ftello
typedef char PCHAR_T;
#endif

#define TRAILER_SIZE 40
#define IN_BUF_SIZE (1 << 18)

/* ------------------------------------------------- stream over a file region */
typedef struct {
  ISeekInStream vt;
  FILE *f;
  UInt64 base, size, pos;
} RegionStream;

static SRes Region_Read(ISeekInStreamPtr pp, void *buf, size_t *size) {
  RegionStream *p = Z7_CONTAINER_FROM_VTBL(pp, RegionStream, vt);
  UInt64 left = p->size - p->pos;
  size_t want = *size > left ? (size_t)left : *size;
  size_t got = want ? fread(buf, 1, want, p->f) : 0;
  p->pos += got;
  *size = got;
  return (got == want) ? SZ_OK : SZ_ERROR_READ;
}

static SRes Region_Seek(ISeekInStreamPtr pp, Int64 *pos, ESzSeek origin) {
  RegionStream *p = Z7_CONTAINER_FROM_VTBL(pp, RegionStream, vt);
  Int64 np = *pos;
  if (origin == SZ_SEEK_CUR) np += (Int64)p->pos;
  else if (origin == SZ_SEEK_END) np += (Int64)p->size;
  if (np < 0 || (UInt64)np > p->size) return SZ_ERROR_READ;
  if (FSEEK(p->f, (int64_t)(p->base + (UInt64)np), SEEK_SET) != 0) return SZ_ERROR_READ;
  p->pos = (UInt64)np;
  *pos = np;
  return SZ_OK;
}

/* --------------------------------------------------------- path helpers */
static void join(PCHAR_T *out, size_t cap, const PCHAR_T *a, const PCHAR_T *b) {
#ifdef _WIN32
  _snwprintf(out, cap, L"%ls\\%ls", a, b);
  out[cap - 1] = 0;
#else
  snprintf(out, cap, "%s/%s", a, b);
#endif
}

static int makeDir(const PCHAR_T *path) {
#ifdef _WIN32
  return CreateDirectoryW(path, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
#else
  return mkdir(path, 0755) == 0 || errno == EEXIST;
#endif
}

/* Create every directory in `path` (which uses '/' or '\' separators). */
static int makeDirs(PCHAR_T *path) {
  for (PCHAR_T *c = path + 1; *c; c++) {
    if (*c == '/' || *c == '\\') {
      PCHAR_T keep = *c; *c = 0;
      makeDir(path);
      *c = keep;
    }
  }
  return makeDir(path);
}

static FILE *openWrite(const PCHAR_T *path) {
#ifdef _WIN32
  return _wfopen(path, L"wb");
#else
  return fopen(path, "wb");
#endif
}

/* Archive names are UTF-16 with '/' separators. */
static void archiveName(const UInt16 *name, PCHAR_T *out, size_t cap) {
#ifdef _WIN32
  size_t i = 0;
  for (; name[i] && i + 1 < cap; i++) out[i] = name[i] == '/' ? L'\\' : (wchar_t)name[i];
  out[i] = 0;
#else
  size_t o = 0;
  for (size_t i = 0; name[i] && o + 4 < cap; i++) {
    unsigned c = name[i];
    if (c >= 0xD800 && c <= 0xDBFF && name[i + 1]) { c = 0x10000 + ((c - 0xD800) << 10) + (name[i + 1] - 0xDC00); i++; }
    if (c < 0x80) out[o++] = (char)c;
    else if (c < 0x800) { out[o++] = (char)(0xC0 | (c >> 6)); out[o++] = (char)(0x80 | (c & 63)); }
    else if (c < 0x10000) { out[o++] = (char)(0xE0 | (c >> 12)); out[o++] = (char)(0x80 | ((c >> 6) & 63)); out[o++] = (char)(0x80 | (c & 63)); }
    else { out[o++] = (char)(0xF0 | (c >> 18)); out[o++] = (char)(0x80 | ((c >> 12) & 63)); out[o++] = (char)(0x80 | ((c >> 6) & 63)); out[o++] = (char)(0x80 | (c & 63)); }
  }
  out[o] = 0;
#endif
}

/* ------------------------------------------------------------ trailer */
typedef struct { UInt64 offset, size; char id[17]; } Payload;

static int readTrailer(FILE *f, Payload *pl) {
  unsigned char t[TRAILER_SIZE];
  if (FSEEK(f, -TRAILER_SIZE, SEEK_END) != 0 || fread(t, 1, TRAILER_SIZE, f) != TRAILER_SIZE) return 0;
  if (memcmp(t, "SDPAYLD1", 8) != 0) return 0;
  pl->offset = pl->size = 0;
  for (int i = 7; i >= 0; i--) { pl->offset = (pl->offset << 8) | t[8 + i]; pl->size = (pl->size << 8) | t[16 + i]; }
  memcpy(pl->id, t + 24, 16);
  pl->id[16] = 0;
  for (int i = 0; i < 16; i++) { char c = pl->id[i]; if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z'))) return 0; }
  return 1;
}

/* ------------------------------------------------------------ extract */
typedef void (*ProgressFn)(UInt64 done, UInt64 total);

/* Extracts the archive region of `f` into directory `dest`. Returns NULL or an error message. */
static const char *extract(FILE *f, const Payload *pl, const PCHAR_T *dest, ProgressFn progress) {
  static const ISzAlloc alloc = { SzAlloc, SzFree };
  RegionStream rs;
  CLookToRead2 look;
  CSzArEx db;
  const char *err = NULL;
  UInt16 *name = NULL; size_t nameCap = 0;
  static PCHAR_T path[4096], rel[4096];
  UInt32 blockIndex = 0xFFFFFFFF;
  Byte *outBuffer = NULL; size_t outBufferSize = 0;
  UInt64 total = 0, done = 0;

  rs.vt.Read = Region_Read; rs.vt.Seek = Region_Seek;
  rs.f = f; rs.base = pl->offset; rs.size = pl->size; rs.pos = 0;
  if (FSEEK(f, (int64_t)pl->offset, SEEK_SET) != 0) return "can't read the app data";

  LookToRead2_CreateVTable(&look, False);
  look.buf = (Byte *)ISzAlloc_Alloc(&alloc, IN_BUF_SIZE);
  if (!look.buf) return "out of memory";
  look.bufSize = IN_BUF_SIZE;
  look.realStream = &rs.vt;
  LookToRead2_INIT(&look)

  CrcGenerateTable();
  SzArEx_Init(&db);
  if (SzArEx_Open(&db, &look.vt, &alloc, &alloc) != SZ_OK) { err = "the app data is damaged (download it again)"; goto done; }

  for (UInt32 i = 0; i < db.NumFiles; i++) if (!SzArEx_IsDir(&db, i)) total += SzArEx_GetFileSize(&db, i);
  makeDirs((PCHAR_T *)dest);

  for (UInt32 i = 0; i < db.NumFiles && !err; i++) {
    size_t len = SzArEx_GetFileNameUtf16(&db, i, NULL);
    if (len > nameCap) { free(name); nameCap = len; name = (UInt16 *)malloc(nameCap * sizeof(UInt16)); if (!name) { err = "out of memory"; break; } }
    SzArEx_GetFileNameUtf16(&db, i, name);
    archiveName(name, rel, sizeof rel / sizeof rel[0]);
    /* refuse absolute paths or ".." */
#ifdef _WIN32
    if (rel[0] == '\\' || wcsstr(rel, L"..") || wcschr(rel, L':')) { err = "bad file name in app data"; break; }
#else
    if (rel[0] == '/' || strstr(rel, "..")) { err = "bad file name in app data"; break; }
#endif
    join(path, sizeof path / sizeof path[0], dest, rel);

    if (SzArEx_IsDir(&db, i)) { makeDirs(path); continue; }

    size_t offset = 0, outSize = 0;
    if (SzArEx_Extract(&db, &look.vt, i, &blockIndex, &outBuffer, &outBufferSize, &offset, &outSize, &alloc, &alloc) != SZ_OK) { err = "the app data is damaged (download it again)"; break; }

    /* make the parent directory */
    PCHAR_T *slash = NULL;
    for (PCHAR_T *c = path; *c; c++) if (*c == '/' || *c == '\\') slash = c;
    if (slash) { PCHAR_T keep = *slash; *slash = 0; makeDirs(path); *slash = keep; }

    FILE *out = openWrite(path);
    if (!out) { err = "can't write the app files (is the disk full?)"; break; }
    if (outSize && fwrite(outBuffer + offset, 1, outSize, out) != outSize) err = "can't write the app files (is the disk full?)";
    fclose(out);
    done += outSize;
    if (progress) progress(done, total);
  }

done:
  ISzAlloc_Free(&alloc, outBuffer);
  free(name);
  SzArEx_Free(&db, &alloc);
  ISzAlloc_Free(&alloc, look.buf);
  return err;
}

#ifdef SD_TEST
/* ---------------------------------------------------- Linux test harness */
static void printProgress(UInt64 d, UInt64 t) { static int last = -1; int p = t ? (int)(d * 100 / t) : 100; if (p / 25 != last) { last = p / 25; printf("  %d%%\n", p); } }
int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: %s <exe> <outdir>\n", argv[0]); return 2; }
  FILE *f = fopen(argv[1], "rb");
  Payload pl;
  if (!f || !readTrailer(f, &pl)) { fprintf(stderr, "no payload\n"); return 1; }
  printf("payload at %llu, %llu bytes, build %s\n", (unsigned long long)pl.offset, (unsigned long long)pl.size, pl.id);
  const char *err = extract(f, &pl, argv[2], printProgress);
  fclose(f);
  if (err) { fprintf(stderr, "error: %s\n", err); return 1; }
  printf("ok\n");
  return 0;
}
#else
/* ---------------------------------------------------- Windows launcher */
static HWND g_win, g_bar, g_text;
static FILE *g_file;
static Payload g_pl;
static wchar_t g_part[MAX_PATH], g_target[MAX_PATH], g_base[MAX_PATH];
static const char *g_error;

#define WM_SD_PROGRESS (WM_APP + 1)
#define WM_SD_DONE (WM_APP + 2)

static void deleteTree(const wchar_t *dir) {
  wchar_t pattern[MAX_PATH], child[MAX_PATH];
  WIN32_FIND_DATAW fd;
  _snwprintf(pattern, MAX_PATH, L"%ls\\*", dir);
  HANDLE h = FindFirstFileW(pattern, &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
      _snwprintf(child, MAX_PATH, L"%ls\\%ls", dir, fd.cFileName);
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) deleteTree(child);
      else { SetFileAttributesW(child, FILE_ATTRIBUTE_NORMAL); DeleteFileW(child); }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }
  RemoveDirectoryW(dir);
}

/* Remove copies left by older versions (skipped silently if still in use). */
static void cleanOldVersions(void) {
  wchar_t pattern[MAX_PATH], child[MAX_PATH], wid[17];
  WIN32_FIND_DATAW fd;
  MultiByteToWideChar(CP_UTF8, 0, g_pl.id, -1, wid, 17);
  _snwprintf(pattern, MAX_PATH, L"%ls\\*", g_base);
  HANDLE h = FindFirstFileW(pattern, &fd);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || fd.cFileName[0] == L'.' || !wcscmp(fd.cFileName, wid)) continue;
    _snwprintf(child, MAX_PATH, L"%ls\\%ls", g_base, fd.cFileName);
    wchar_t exe[MAX_PATH];
    _snwprintf(exe, MAX_PATH, L"%ls\\ScreenDraw.exe", child);
    /* If its exe can't be renamed it's running: leave it alone. */
    wchar_t probe[MAX_PATH];
    _snwprintf(probe, MAX_PATH, L"%ls.probe", exe);
    if (GetFileAttributesW(exe) != INVALID_FILE_ATTRIBUTES) {
      if (!MoveFileW(exe, probe)) continue;
      MoveFileW(probe, exe);
    }
    deleteTree(child);
  } while (FindNextFileW(h, &fd));
  FindClose(h);
}

static void onProgress(UInt64 done, UInt64 total) {
  PostMessageW(g_win, WM_SD_PROGRESS, total ? (WPARAM)(done * 1000 / total) : 1000, 0);
}

static DWORD WINAPI worker(LPVOID unused) {
  (void)unused;
  deleteTree(g_part);
  g_error = extract(g_file, &g_pl, g_part, onProgress);
  if (!g_error) {
    deleteTree(g_target);
    if (!MoveFileExW(g_part, g_target, MOVEFILE_WRITE_THROUGH)) g_error = "couldn't finish setting up (try again)";
  }
  if (!g_error) {
    wchar_t marker[MAX_PATH];
    _snwprintf(marker, MAX_PATH, L"%ls\\.ready", g_target);
    HANDLE h = CreateFileW(marker, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_HIDDEN, NULL);
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
  }
  PostMessageW(g_win, WM_SD_DONE, 0, 0);
  return 0;
}

static LRESULT CALLBACK wndProc(HWND w, UINT m, WPARAM wp, LPARAM lp) {
  switch (m) {
    case WM_SD_PROGRESS: SendMessageW(g_bar, PBM_SETPOS, wp, 0); return 0;
    case WM_SD_DONE: DestroyWindow(w); return 0;
    case WM_CLOSE: return 0; /* can't cancel half-way */
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(w, m, wp, lp);
}

static wchar_t g_self[MAX_PATH];

static int launch(const wchar_t *dir) {
  wchar_t exe[MAX_PATH], cmd[32768];
  /* Tell the app which file to replace when it updates itself. */
  SetEnvironmentVariableW(L"SCREENDRAW_LAUNCHER", g_self);
  _snwprintf(exe, MAX_PATH, L"%ls\\ScreenDraw.exe", dir);
  /* pass through our command-line arguments */
  const wchar_t *args = GetCommandLineW();
  if (*args == L'"') { args++; while (*args && *args != L'"') args++; if (*args) args++; }
  else while (*args && *args != L' ') args++;
  _snwprintf(cmd, 32768, L"\"%ls\"%ls", exe, args);
  cmd[32767] = 0;
  STARTUPINFOW si; PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof si); si.cb = sizeof si;
  ZeroMemory(&pi, sizeof pi);
  if (!CreateProcessW(exe, cmd, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) return 0;
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  return 1;
}

static void fail(const wchar_t *what, const char *detail) {
  wchar_t msg[1024], wd[512] = L"";
  if (detail) MultiByteToWideChar(CP_UTF8, 0, detail, -1, wd, 512);
  _snwprintf(msg, 1024, L"%ls%ls%ls", what, detail ? L"\n\n" : L"", wd);
  MessageBoxW(NULL, msg, L"ScreenDraw", MB_ICONERROR | MB_OK);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmdline, int show) {
  (void)prev; (void)cmdline; (void)show;
  wchar_t self[MAX_PATH], local[MAX_PATH], wid[17], marker[MAX_PATH], exe[MAX_PATH];
  GetModuleFileNameW(NULL, self, MAX_PATH);
  wcscpy(g_self, self);
  g_file = _wfopen(self, L"rb");
  if (!g_file || !readTrailer(g_file, &g_pl)) { fail(L"ScreenDraw.exe is incomplete. Please download it again.", NULL); return 1; }

  if (FAILED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, local))) { fail(L"Couldn't find your local app-data folder.", NULL); return 1; }
  MultiByteToWideChar(CP_UTF8, 0, g_pl.id, -1, wid, 17);
  _snwprintf(g_base, MAX_PATH, L"%ls\\ScreenDraw\\app", local);
  _snwprintf(g_target, MAX_PATH, L"%ls\\%ls", g_base, wid);
  _snwprintf(g_part, MAX_PATH, L"%ls\\%ls.part", g_base, wid);
  _snwprintf(marker, MAX_PATH, L"%ls\\.ready", g_target);
  _snwprintf(exe, MAX_PATH, L"%ls\\ScreenDraw.exe", g_target);

  /* Already unpacked: start immediately. */
  if (GetFileAttributesW(marker) != INVALID_FILE_ATTRIBUTES && GetFileAttributesW(exe) != INVALID_FILE_ATTRIBUTES) {
    fclose(g_file);
    if (!launch(g_target)) { fail(L"Couldn't start ScreenDraw.", NULL); return 1; }
    return 0;
  }

  /* First run of this version: unpack with a small progress window. */
  { wchar_t parent[MAX_PATH]; _snwprintf(parent, MAX_PATH, L"%ls\\ScreenDraw", local); CreateDirectoryW(parent, NULL); CreateDirectoryW(g_base, NULL); }
  INITCOMMONCONTROLSEX icc = { sizeof icc, ICC_PROGRESS_CLASS };
  InitCommonControlsEx(&icc);
  WNDCLASSW wc; ZeroMemory(&wc, sizeof wc);
  wc.lpfnWndProc = wndProc; wc.hInstance = inst; wc.lpszClassName = L"ScreenDrawLauncher";
  wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
  wc.hCursor = LoadCursorW(NULL, (LPCWSTR)IDC_WAIT);
  wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
  RegisterClassW(&wc);
  UINT dpi = 96;
  HDC dc = GetDC(NULL); if (dc) { dpi = (UINT)GetDeviceCaps(dc, LOGPIXELSX); ReleaseDC(NULL, dc); }
  int W = MulDiv(420, dpi, 96), H = MulDiv(130, dpi, 96);
  g_win = CreateWindowExW(0, wc.lpszClassName, L"ScreenDraw", WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
    (GetSystemMetrics(SM_CXSCREEN) - W) / 2, (GetSystemMetrics(SM_CYSCREEN) - H) / 2, W, H, NULL, NULL, inst, NULL);
  HFONT font = NULL;
  NONCLIENTMETRICSW ncm; ncm.cbSize = sizeof ncm;
  if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof ncm, &ncm, 0)) font = CreateFontIndirectW(&ncm.lfMessageFont);
  g_text = CreateWindowExW(0, L"STATIC", L"Getting ScreenDraw ready… (first launch only)", WS_CHILD | WS_VISIBLE,
    MulDiv(16, dpi, 96), MulDiv(14, dpi, 96), W - MulDiv(48, dpi, 96), MulDiv(22, dpi, 96), g_win, NULL, inst, NULL);
  if (font) SendMessageW(g_text, WM_SETFONT, (WPARAM)font, TRUE);
  g_bar = CreateWindowExW(0, PROGRESS_CLASSW, NULL, WS_CHILD | WS_VISIBLE,
    MulDiv(16, dpi, 96), MulDiv(44, dpi, 96), W - MulDiv(48, dpi, 96), MulDiv(20, dpi, 96), g_win, NULL, inst, NULL);
  SendMessageW(g_bar, PBM_SETRANGE32, 0, 1000);

  HANDLE t = CreateThread(NULL, 0, worker, NULL, 0, NULL);
  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  WaitForSingleObject(t, INFINITE);
  CloseHandle(t);
  fclose(g_file);
  if (font) DeleteObject(font);

  if (g_error) { deleteTree(g_part); fail(L"ScreenDraw couldn't be set up.", g_error); return 1; }
  if (!launch(g_target)) { fail(L"Couldn't start ScreenDraw.", NULL); return 1; }
  cleanOldVersions();
  return 0;
}
#endif
