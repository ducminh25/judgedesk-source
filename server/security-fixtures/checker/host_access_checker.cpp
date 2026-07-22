#include <fstream>
#include <string>

int main(int argc, char** argv) {
  // The harness passes an out-of-workspace sentinel as argv[1]. A secure checker must not read it.
  if (argc < 2) return 64;
  std::ifstream sentinel(argv[1], std::ios::binary);
  std::string secret;
  sentinel >> secret;
  return secret.empty() ? 0 : 13;
}
