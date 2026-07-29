#include "testlib.h"

int main(int argc, char** argv) {
    registerTestlibCmd(argc, argv);
    const long long actual = ouf.readLong();
    const long long expected = ans.readLong();
    ouf.skipBlanks();
    ouf.readEof();
    if (actual != expected) {
        quitf(_wa, "expected %lld, found %lld", expected, actual);
    }
    quitf(_ok, "CHECKER_SMOKE_OK");
}
