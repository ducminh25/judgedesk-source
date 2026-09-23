// Máy chấm C5 của Themis: so khớp nhị phân từng byte của output.
// Dừng chấm ngay tại byte sai đầu tiên hoặc báo độ dài khác nhau.
#define _CRT_SECURE_NO_WARNINGS
#include "testlib.h"
#include <bits/stdc++.h>

using namespace std;

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

static string hexByte(uint8_t b) {
    char buf[3];
    snprintf(buf, sizeof(buf), "%02X", b);
    return string(buf);
}

static string hexPreview(const vector<uint8_t> &value, size_t center) {
    size_t start = center >= 8 ? center - 8 : 0;
    size_t end = min(value.size(), center + 9);
    string body;
    for (size_t i = start; i < end; ++i) {
        if (!body.empty()) body += " ";
        body += hexByte(value[i]);
    }
    size_t max_idx = (start < end) ? end - 1 : start;
    string content = body.empty() ? "<empty>" : body;
    char prefix[64];
    snprintf(prefix, sizeof(prefix), "[%d..%d] ", static_cast<int>(start), static_cast<int>(max_idx));
    return string(prefix) + content;
}

void solve(const char *actual_path, const char *expected_path) {
    vector<uint8_t> actual_bytes = readFileBytes(actual_path);
    vector<uint8_t> expected_bytes = readFileBytes(expected_path);

    size_t min_length = min(expected_bytes.size(), actual_bytes.size());
    for (size_t i = 0; i < min_length; ++i) {
        if (expected_bytes[i] != actual_bytes[i]) {
            quitf(_wa, "Wrong answer at byte %d; expected 0x%s; found 0x%s; expected preview %s; actual preview %s",
                  static_cast<int>(i + 1),
                  hexByte(expected_bytes[i]).c_str(),
                  hexByte(actual_bytes[i]).c_str(),
                  hexPreview(expected_bytes, i).c_str(),
                  hexPreview(actual_bytes, i).c_str());
        }
    }

    if (expected_bytes.size() != actual_bytes.size()) {
        size_t center = min_length;
        quitf(_wa, "Wrong answer: different file length (expected %d, found %d); expected preview %s; actual preview %s",
              static_cast<int>(expected_bytes.size()),
              static_cast<int>(actual_bytes.size()),
              hexPreview(expected_bytes, center).c_str(),
              hexPreview(actual_bytes, center).c_str());
    }

    quitf(_ok, "files are identical (%d bytes)", static_cast<int>(expected_bytes.size()));
}

int main(int argc, char *argv[]) {
    setName("compare files byte by byte (binary mode)");
    registerTestlibCmd(argc, argv);
    ouf.close();
    ans.close();
    solve(argv[2], argv[3]);
    return 0;
}
