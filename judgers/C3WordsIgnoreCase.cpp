// Máy chấm C3 của Themis: so khớp toàn bộ từ trong file, không phân biệt hoa thường.
// Dấu phân tách từ gồm space (0x20), tab (0x09), CR (0x0D), LF (0x0A).
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

static inline uint8_t foldAsciiByte(uint8_t b) {
    if (b >= 'A' && b <= 'Z') {
        return static_cast<uint8_t>(b + ('a' - 'A'));
    }
    return b;
}

static inline bool wordsEqual(const WordRef &a, const WordRef &b, bool ignore_case) {
    if (a.length != b.length) return false;
    if (ignore_case) {
        for (size_t i = 0; i < a.length; ++i) {
            if (foldAsciiByte(a.data[i]) != foldAsciiByte(b.data[i])) {
                return false;
            }
        }
        return true;
    } else {
        return memcmp(a.data, b.data, a.length) == 0;
    }
}

static vector<WordRef> parseThemisWords(const vector<uint8_t> &buf) {
    vector<WordRef> words;
    size_t word_start = static_cast<size_t>(-1);
    for (size_t i = 0; i < buf.size(); ++i) {
        uint8_t b = buf[i];
        if (b == 0x20 || b == 0x09 || b == 0x0D || b == 0x0A) {
            if (word_start != static_cast<size_t>(-1)) {
                words.push_back({&buf[word_start], i - word_start});
                word_start = static_cast<size_t>(-1);
            }
        } else if (word_start == static_cast<size_t>(-1)) {
            word_start = i;
        }
    }
    if (word_start != static_cast<size_t>(-1)) {
        words.push_back({&buf[word_start], buf.size() - word_start});
    }
    return words;
}

void solve(const char *actual_path, const char *expected_path) {
    vector<uint8_t> actual_bytes = readFileBytes(actual_path);
    vector<uint8_t> expected_bytes = readFileBytes(expected_path);

    vector<WordRef> expected_words = parseThemisWords(expected_bytes);
    vector<WordRef> actual_words = parseThemisWords(actual_bytes);

    size_t min_length = min(expected_words.size(), actual_words.size());
    for (size_t word_index = 0; word_index < min_length; ++word_index) {
        if (!wordsEqual(expected_words[word_index], actual_words[word_index], true)) {
            quitf(_wa, "Wrong answer at word %d", static_cast<int>(word_index + 1));
        }
    }

    if (expected_words.size() != actual_words.size()) {
        quitf(_wa, "Wrong answer: different number of words (expected %d, found %d)",
              static_cast<int>(expected_words.size()), static_cast<int>(actual_words.size()));
    }

    if (expected_words.size() == 1) {
        quitf(_ok, "single word");
    } else {
        quitf(_ok, "%d words", static_cast<int>(expected_words.size()));
    }
}

int main(int argc, char *argv[]) {
    setName("compare files as sequence of words, case-insensitive");
    registerTestlibCmd(argc, argv);
    ouf.close();
    ans.close();
    solve(argv[2], argv[3]);
    return 0;
}
