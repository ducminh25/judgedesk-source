#include <iostream>
#include <fstream>
int main(int argc, char** argv) { std::ifstream fin(argv[1]); int x; fin >> x; std::cout << x << std::endl; int y; std::cin >> y; if (y == x * 2) { std::cerr << "ok\n"; return 0; } return 1; }
