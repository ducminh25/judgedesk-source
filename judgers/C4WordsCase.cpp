// Máy chấm C4 của Themis: chấm từng từ, bỏ qua Tab và Space
#include "testlib.h"
#include <string>
#include <vector>
#include <algorithm>
using namespace std;

int main(int argc, char *argv[]) {
    setName("compare files as sequence of words, case-insensitive");
    registerTestlibCmd(argc, argv);

    vector<string> va, vp;

    // Đọc tất cả từ từ file đáp án
    while (!ans.eof()) {
        string word = ans.readWord();
        if (ans.eof() && word.empty()) break;
        va.push_back(word);
    }

    // Đọc tất cả từ từ file output
    while (!ouf.eof()) {
        string word = ouf.readWord();
        if (ouf.eof() && word.empty()) break;
        vp.push_back(word);
    }

    if (va != vp) {
        // tìm vị trí sai đầu tiên để báo lỗi
        size_t minLen = min(va.size(), vp.size());
        for (size_t i = 0; i < minLen; i++) {
            if (va[i] != vp[i]) {
                // quitf(_wa, "Wrong answer at word %d", int(i+1));
                quitf(_wa, "");
            }
        }
        // Nếu số từ khác nhau
        if (va.size() != vp.size()) {
            // quitf(_wa, "Wrong answer: different number of words (expected %d, found %d)",
            //       (int)va.size(), (int)vp.size());
            quitf(_wa, "");
        }
    }

    // if (va.size() == 1)
    //     quitf(_ok, "single word");
    // quitf(_ok, "%d words", (int)va.size());
    quitf(_ok, "");
}
