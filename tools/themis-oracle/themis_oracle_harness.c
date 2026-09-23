/**
 * Themis Oracle Harness (Win32 x86)
 *
 * Calls original Themis C1-C5 judger DLLs (compiled with Delphi XE10)
 * Export specification from Themis documentation:
 *   Pascal: function Judge(a, b, c, d: PWideChar; var e: PWideChar): double; stdcall;
 *   C++:    double __stdcall Judge(const wchar_t *a, const wchar_t *b, const wchar_t *c, const wchar_t *d, wchar_t **e);
 *
 * Parameters:
 *   a: Contestant directory (work_dir)
 *   b: Test answer directory (test_dir)
 *   c: List of output filenames separated by '|' (e.g. "BAI5.OUT" or "A.OUT|B.OUT")
 *   d: Problem name (e.g. "BAI5")
 *   e: Output pointer to Delphi UnicodeString containing comment
 *
 * Return: double between 0.0 and 1.0
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>


typedef double (__stdcall *ThemisJudgeFunc)(
    const wchar_t *work_dir,
    const wchar_t *test_dir,
    const wchar_t *file_list,
    const wchar_t *problem_name,
    wchar_t **comment
);

int main(void) {
    // Suppress system crash dialogs (e.g. for buggy DLLs like C5)
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);

    int argc = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv || argc < 6) {
        printf("Usage: themis_oracle_harness.exe <dll_path> <work_dir> <test_dir> <file_list> <problem_name>\n");
        fflush(stdout);
        return 1;
    }

    const wchar_t *dll_path = argv[1];
    const wchar_t *work_dir = argv[2];
    const wchar_t *test_dir = argv[3];
    const wchar_t *file_list = argv[4];
    const wchar_t *problem_name = argv[5];

    HMODULE dll = LoadLibraryW(dll_path);
    if (!dll) {
        printf("ERROR: LoadLibraryW failed error=%lu\n", GetLastError());
        fflush(stdout);
        LocalFree(argv);
        return 2;
    }

    ThemisJudgeFunc judge = (ThemisJudgeFunc)GetProcAddress(dll, "Judge");
    if (!judge) {
        printf("ERROR: GetProcAddress failed for 'Judge'\n");
        fflush(stdout);
        FreeLibrary(dll);
        LocalFree(argv);
        return 3;
    }

    wchar_t *comment = NULL;
    double score = 0.0;

    score = judge(work_dir, test_dir, file_list, problem_name, &comment);

    const char *verdict = "WA";
    if (score >= 0.9999) {
        verdict = "AC";
    }

    printf("SCORE: %.4f\n", score);
    printf("VERDICT: %s\n", verdict);

    if (comment) {
        // Convert wide character comment to UTF-8 for narrow printf
        int utf8_len = WideCharToMultiByte(CP_UTF8, 0, comment, -1, NULL, 0, NULL, NULL);
        if (utf8_len > 0) {
            char *utf8_comment = (char *)malloc(utf8_len);
            if (utf8_comment) {
                WideCharToMultiByte(CP_UTF8, 0, comment, -1, utf8_comment, utf8_len, NULL, NULL);
                printf("COMMENT: %s\n", utf8_comment);
                free(utf8_comment);
            } else {
                printf("COMMENT: (allocation failure)\n");
            }
        } else {
            printf("COMMENT: \n");
        }

        printf("COMMENT_HEX: ");
        size_t clen = wcslen(comment);
        const unsigned char *cb = (const unsigned char *)comment;
        for (size_t i = 0; i < clen * sizeof(wchar_t); i++) {
            printf("%02X", cb[i]);
        }
        printf("\n");
    } else {
        printf("COMMENT: (null)\n");
        printf("COMMENT_HEX: \n");
    }

    fflush(stdout);
    FreeLibrary(dll);
    LocalFree(argv);
    return 0;
}
