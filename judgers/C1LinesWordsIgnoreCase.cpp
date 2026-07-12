// Máy chấm C1 của Themis: chấm từng dòng, từng từ, tất cả chuyển thành chữ thường, bỏ qua Tab và Space
#include "testlib.h"
#include <bits/stdc++.h>
using namespace std;

// Hàm chuyển về chữ thường
string toLowerStr(const string &s) {
    string res = s;
    for (char &c : res) c = tolower(c);
    return res;
}

// Tách từ (tokens) theo space và tab
vector<string> splitWords(const string &line) {
    vector<string> tokens;
    string cur;
    for (char c : line) {
        if (c == ' ' || c == '\t') {
            if (!cur.empty()) {
                tokens.push_back(toLowerStr(cur));
                cur.clear();
            }
        } else {
            cur.push_back(c);
        }
    }
    if (!cur.empty()) tokens.push_back(toLowerStr(cur));
    return tokens;
}

int main(int argc, char *argv[]) {
    setName("compare files as sequence of words per line, case-insensitive");
    registerTestlibCmd(argc, argv);

    int n = 0;
    while (!ans.eof()) {
        string j = ans.readLine("[^\n]*", "ans_line");
        string p = ouf.readLine("[^\n]*", "out_line");

        if (j == "" && ans.eof()) break; // cho phép bỏ dòng trống cuối file

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
 
    quitf(_ok, "");
}
