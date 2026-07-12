// Máy chấm C2 của Themis: chấm từng dòng, từng từ, bỏ qua Tab và Space
#include "testlib.h"
#include <string>
#include <vector>
#include <sstream>
#include <algorithm>
using namespace std;

vector<string> splitWords(const string &line) {
    vector<string> tokens;
    string cur;
    for (char c : line) {
        if (c == ' ' || c == '\t') {
            if (!cur.empty()) {
                tokens.push_back((cur));
                cur.clear();
            }
        } else {
            cur.push_back(c);
        }
    }
    if (!cur.empty()) tokens.push_back((cur));
    return tokens;
}

int main(int argc, char *argv[]) {
    setName("compare files as sequence of words per line, case-sensitive");
    registerTestlibCmd(argc, argv);

    int n = 0;
    while (!ans.eof()) {
        string j = ans.readLine("[^\n]*", "ans_line");
        string p = ouf.readLine("[^\n]*", "out_line");

        if (j == "" && ans.eof()) break;

        n++;

        vector<string> va = splitWords(j);
        vector<string> vp = splitWords(p);

        if (va != vp) {
            // quitf(_wa, "Wrong answer at line %d", n);
            quitf(_wa, "");
        }
    }
 
    // Check if ouf has extra non-empty lines
    while (!ouf.eof()) {
        string p = ouf.readLine("[^\n]*", "out_line");
        vector<string> vp = splitWords(p);
        if (!vp.empty()) {
            quitf(_wa, "");
        }
    }
 
    // if (n == 1)
    //     quitf(_ok, "single line");
    // quitf(_ok, "%d lines", n);
    quitf(_ok, "");
}
