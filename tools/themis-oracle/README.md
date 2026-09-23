# Themis Judger Oracle Harness (Win32 x86)

A standalone, reproducible Windows x86 test harness to invoke the original 32-bit Themis judger dynamic link libraries (`C1LinesWordsIgnoreCase.dll`, `C2LinesWordsCase.dll`, `C3WordsIgnoreCase.dll`, `C4WordsCase.dll`, `C5Binary.dll`) directly without needing the full Themis GUI application.

---

## 1. Specification & Calling Convention

As documented in official Themis documentation (`C:\Themis\~Documentation\themis.html` lines 529–538), internal Themis judgers are 32-bit Windows DLLs built with Embarcadero Delphi XE10 Seattle that export a single entrypoint named `Judge`:

```pascal
function Judge(a, b, c, d: PWideChar; var e: PWideChar): double; stdcall;
```

In C/C++:
```c
double __stdcall Judge(
    const wchar_t *work_dir,
    const wchar_t *test_dir,
    const wchar_t *file_list,
    const wchar_t *problem_name,
    wchar_t **comment
);
```

### Parameters
- `work_dir` (`a`): UTF-16 null-terminated path to the directory containing student output files.
- `test_dir` (`b`): UTF-16 null-terminated path to the directory containing judge answer files.
- `file_list` (`c`): Pipe-delimited list of output filenames specified by the problem (e.g., `BAI5.OUT` or `A.OUT|B.OUT`).
- `problem_name` (`d`): Problem identifier string (e.g., `BAI5`).
- `comment` (`e`): Output pointer where Delphi writes the address of its internal `UnicodeString` buffer containing the judge verdict comment.
- **Return value**: 64-bit IEEE 754 double precision float between `0.0` and `1.0` in the x87 `ST(0)` register.

---

## 2. Compilation Instructions

The harness must be built as a 32-bit (`x86`) console executable using a 32-bit MinGW GCC compiler (such as the one shipped with Themis at `C:\Themis\GCC\bin\gcc.exe`):

```powershell
# Set 32-bit GCC in PATH
$env:PATH = "C:\Themis\GCC\bin;" + $env:PATH

# Compile harness
gcc -O2 -mconsole tools/themis-oracle/themis_oracle_harness.c -lshell32 -o tools/themis-oracle/themis_oracle_harness.exe
```

---

## 3. Usage & CLI Arguments

```powershell
.\tools\themis-oracle\themis_oracle_harness.exe <dll_path> <work_dir> <test_dir> <file_list> <problem_name>
```

### Example
```powershell
$work = "$env:TEMP\themis_work"
$ans  = "$env:TEMP\themis_ans"
New-Item -ItemType Directory -Force -Path $work, $ans | Out-Null
Set-Content "$work\BAI5.OUT" -Value "4"
Set-Content "$ans\BAI5.OUT" -Value "4"

.\tools\themis-oracle\themis_oracle_harness.exe "C:\Themis\~judgers\C1LinesWordsIgnoreCase.dll" $work $ans "BAI5.OUT" "BAI5"
```

### Output Format
The harness prints machine-readable lines to standard output:
```text
SCORE: 1.0000
VERDICT: AC
COMMENT: Kết quả khớp đáp án!
COMMENT_HEX: 4B00...
```

---

## 4. Delphi Themis DLL Behavior & Implementation Details

Reverse-engineering the DLLs via disassembly revealed key behavioral details:

### 4.1 Separate Physical Directories Required (`ERROR_SHARING_VIOLATION`)
In `C1` through `C5`, Delphi opens files via `CreateFileW` with `dwShareMode = 0` (exclusive access, no file sharing permitted). If `work_dir` and `test_dir` point to the same directory containing the same physical file, the second open attempt fails with Win32 error 32 (`ERROR_SHARING_VIOLATION`), causing Delphi's `FileExists` check to fail or throwing an exception resulting in "Không thấy file kết quả". Therefore, the harness or test runner must always place student output and judge answers in separate directories.

### 4.2 Delimiter Tokenizer in `file_list`
The documentation states filenames are separated by `|`. Do not append a trailing `|` (e.g. use `BAI5.OUT`, not `BAI5.OUT|`). Appending a trailing pipe triggers an off-by-one substring calculation in Delphi's string slicing logic (`dec ecx` on 0-based PWideChar indexing), resulting in a truncated filename search (`BAI5.OU`) or attempting to open an empty filename.

### 4.3 C5Binary.dll Blocker (Delphi Off-by-One Loop Bug)
Disassembly of `0x5ed407` in `C5Binary.dll` reveals:
```assembly
5ed407: add eax, 1         ; Remaining count initialized to FileSize + 1
...
5ed413: call 0x5ed1a8      ; Read byte from Stream 1
5ed420: call 0x5ed1a8      ; Read byte from Stream 2
5ed425: cmp bl, al
...
5ed437: sub [ebp-0x20], 1  ; Decrement remaining
5ed445: jne 0x5ed413       ; Loop while remaining != 0
```
This corresponds to a Delphi loop `for i := 0 to FileSize do` instead of `0 to FileSize - 1`. In Pascal, `for i := 0 to N do` iterates `N + 1` times. On the `(FileSize + 1)`-th iteration:
1. `MapViewOfFile` reaches beyond the file length.
2. The read function returns address `0x00000000`.
3. Dereferencing `[0]` raises `STATUS_ACCESS_VIOLATION`.
4. Delphi's top-level exception handler catches this, sets `ebx = 2`, and returns score `0.0000` with comment `Kết quả KHÁC đáp án!`.
5. For 0-byte files, `CreateFileMappingW` fails with Win32 error 1006 (`ERROR_FILE_INVALID`), triggering the same exception handler.

Consequently, original `C5Binary.dll` cannot produce AC for any input. In accordance with project protocol, this blocker is formally recorded in `themis-oracle-results.json` without inferring or faking results.
