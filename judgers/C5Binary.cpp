// Máy chấm C5 của Themis: chấm từng byte của output; dừng chấm ngay tại byte sai
#include "testlib.h"
#include <string>
using namespace std;

int main(int argc, char *argv[]) {
    setName("compare files byte by byte (binary mode)");
    registerTestlibCmd(argc, argv);

    int pos = 0;
    while (!ans.eof() && !ouf.eof()) {
        char ca = ans.readChar();
        char co = ouf.readChar();
        pos++;
        if (ca != co) {
            // quitf(_wa, "Wrong answer at byte %d", pos);
            quitf(_wa, "");
        }
    }

    if (!ans.eof() || !ouf.eof()) {
        // Một file dài hơn file còn lại
        // quitf(_wa, "Wrong answer: different file length");
        quitf(_wa, "");
    }

    // quitf(_ok, "files are identical (%d bytes)", pos);
    quitf(_ok, "");
}
