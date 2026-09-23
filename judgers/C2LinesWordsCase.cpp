// Máy chấm C2 của Themis: so khớp danh sách từ theo từng dòng, phân biệt hoa thường.
// Dấu phân tách từ chỉ gồm space (0x20) và tab (0x09).
// EOL chấp nhận CRLF (0x0D 0x0A), CR lẻ (0x0D), LF lẻ (0x0A).
// Bỏ qua các dòng trống ở cuối file.
#define _CRT_SECURE_NO_WARNINGS
#include "testlib.h"
#include <bits/stdc++.h>

using namespace std;

struct WordRef {
    const uint8_t *data;
    size_t length;
};

static vector<uint8_t> readFileBytes(const char *path) {
    ifstream stream(path, ios::binary | ios::ate);
    if (!stream) {
        quitf(_fail, "Failed to open file: %s", path);
    }
    streamsize size = stream.tellg();
    if (size < 0) {
        quitf(_fail, "Failed to determine file size: %s", path);
    }
    vector<uint8_t> buffer(static_cast<size_t>(size));
    stream.seekg(0, ios::beg);
    if (size > 0 && !stream.read(reinterpret_cast<char *>(buffer.data()), size)) {
        quitf(_fail, "Failed to read file: %s", path);
    }
    return buffer;
}

static inline bool wordsEqual(const WordRef &a, const WordRef &b, bool ignore_case) {
    if (a.length != b.length) return false;
    (void)ignore_case;
    return memcmp(a.data, b.data, a.length) == 0;
}

static vector<vector<WordRef>> parseThemisLines(const vector<uint8_t> &buf) {
    if (buf.empty()) return {};

    vector<vector<WordRef>> lines;
    vector<WordRef> current_words;
    size_t word_start = static_cast<size_t>(-1);
    size_t i = 0;
    bool had_eol_at_end = false;

    while (i < buf.size()) {
        uint8_t b = buf[i];
        if (b == 0x0D || b == 0x0A) {
            if (word_start != static_cast<size_t>(-1)) {
                current_words.push_back({&buf[word_start], i - word_start});
                word_start = static_cast<size_t>(-1);
            }
            lines.push_back(move(current_words));
            current_words.clear();
            had_eol_at_end = true;
            if (b == 0x0D && i + 1 < buf.size() && buf[i + 1] == 0x0A) {
                i += 2;
            } else {
                i += 1;
            }
        } else if (b == 0x20 || b == 0x09) {
            if (word_start != static_cast<size_t>(-1)) {
                current_words.push_back({&buf[word_start], i - word_start});
                word_start = static_cast<size_t>(-1);
            }
            had_eol_at_end = false;
            ++i;
        } else {
            if (word_start == static_cast<size_t>(-1)) {
                word_start = i;
            }
            had_eol_at_end = false;
            ++i;
        }
    }

    if (word_start != static_cast<size_t>(-1)) {
        current_words.push_back({&buf[word_start], buf.size() - word_start});
    }
    if (!had_eol_at_end || !current_words.empty()) {
        lines.push_back(move(current_words));
    }

    return lines;
}

static void trimThemisTrailingBlankLines(vector<vector<WordRef>> &lines) {
    while (!lines.empty() && lines.back().empty()) {
        lines.pop_back();
    }
}

void solve(const char *actual_path, const char *expected_path) {
    vector<uint8_t> actual_bytes = readFileBytes(actual_path);
    vector<uint8_t> expected_bytes = readFileBytes(expected_path);

    vector<vector<WordRef>> expected_lines = parseThemisLines(expected_bytes);
    vector<vector<WordRef>> actual_lines = parseThemisLines(actual_bytes);
    trimThemisTrailingBlankLines(expected_lines);
    trimThemisTrailingBlankLines(actual_lines);

    size_t line_count = max(expected_lines.size(), actual_lines.size());
    for (size_t line_index = 0; line_index < line_count; ++line_index) {
        if (line_index >= expected_lines.size() || line_index >= actual_lines.size()) {
            quitf(_wa, "Wrong answer at line %d", static_cast<int>(line_index + 1));
        }
        const auto &exp_words = expected_lines[line_index];
        const auto &act_words = actual_lines[line_index];
        if (exp_words.size() != act_words.size()) {
            quitf(_wa, "Wrong answer at line %d", static_cast<int>(line_index + 1));
        }
        for (size_t w = 0; w < exp_words.size(); ++w) {
            if (!wordsEqual(exp_words[w], act_words[w], false)) {
                quitf(_wa, "Wrong answer at line %d", static_cast<int>(line_index + 1));
            }
        }
    }

    if (expected_lines.size() == 1) {
        quitf(_ok, "single line");
    } else {
        quitf(_ok, "%d lines", static_cast<int>(expected_lines.size()));
    }
}

int main(int argc, char *argv[]) {
    setName("compare files as sequence of words per line, case-sensitive");
    registerTestlibCmd(argc, argv);
    ouf.close();
    ans.close();
    solve(argv[2], argv[3]);
    return 0;
}
