#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

static std::uint64_t number(const char* value) {
  return static_cast<std::uint64_t>(std::strtoull(value, nullptr, 10));
}

int main(int argc, char** argv) {
  if (argc < 2) return 64;
  const std::string mode = argv[1];
  if (mode == "cpu-loop") {
    volatile std::uint64_t value = 1;
    for (;;) value = value * 6364136223846793005ULL + 1;
  }
  if (mode == "sleep-ms" && argc == 3) {
    std::this_thread::sleep_for(std::chrono::milliseconds(number(argv[2])));
    return 0;
  }
  if (mode == "allocate-mib" && argc == 4) {
    std::vector<unsigned char> bytes(number(argv[2]) * 1024ULL * 1024ULL);
    for (std::size_t offset = 0; offset < bytes.size(); offset += 4096) bytes[offset] = 0x5a;
    std::this_thread::sleep_for(std::chrono::milliseconds(number(argv[3])));
    return bytes.empty();
  }
  if (mode == "output-bytes" && argc == 3) {
    std::string chunk(4096, 'X');
    std::uint64_t remaining = number(argv[2]);
    while (remaining > 0) {
      const auto amount = static_cast<std::streamsize>(std::min<std::uint64_t>(remaining, chunk.size()));
      std::cout.write(chunk.data(), amount);
      remaining -= static_cast<std::uint64_t>(amount);
    }
    return 0;
  }
  if (mode == "thread-bomb" && argc == 4) {
    std::vector<std::thread> threads;
    for (std::uint64_t index = 0; index < number(argv[2]); ++index) {
      threads.emplace_back([hold = number(argv[3])] {
        std::this_thread::sleep_for(std::chrono::milliseconds(hold));
      });
    }
    for (auto& thread : threads) thread.join();
    return 0;
  }
  if (mode == "read" && argc == 3) {
    std::ifstream input(argv[2], std::ios::binary);
    std::string value((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    std::cout << value;
    return input ? 0 : 13;
  }
  if (mode == "write" && argc == 3) {
    std::ofstream output(argv[2], std::ios::binary | std::ios::trunc);
    output << "OVERWRITTEN";
    return output ? 0 : 13;
  }
  return 65;
}
