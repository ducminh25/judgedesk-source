#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <spawn.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <unistd.h>

extern char** environ;

static bool denied(int result, int error) {
    return result == -1 && (error == EPERM || error == EACCES);
}

static bool networkDenied(const char* port) {
    const int network = socket(AF_INET, SOCK_STREAM, 0);
    int connected = -1;
    int networkError = errno;
    if (network >= 0) {
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_port = htons(static_cast<unsigned short>(std::strtoul(port, nullptr, 10)));
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        errno = 0;
        connected = connect(network, reinterpret_cast<sockaddr*>(&address), sizeof(address));
        networkError = errno;
        close(network);
    }
    return denied(connected, networkError);
}

static bool escapeDenied(const char* executable) {
    errno = 0;
    const int group = setpgid(0, 0);
    const int groupError = errno;
    errno = 0;
    const int session = setsid();
    const int sessionError = errno;
    posix_spawnattr_t attributes;
    if (posix_spawnattr_init(&attributes) != 0) return false;
    if (posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP) != 0 ||
        posix_spawnattr_setpgroup(&attributes, 0) != 0) {
        posix_spawnattr_destroy(&attributes);
        return false;
    }
    pid_t child = 0;
    char mode[] = "spawned-escape";
    char* arguments[] = {const_cast<char*>(executable), mode, nullptr};
    const int spawned = posix_spawn(&child, executable, nullptr, &attributes, arguments, environ);
    posix_spawnattr_destroy(&attributes);
    // The bounded unexpected child exits immediately. Reap this actual child;
    // never turn a failed denial assertion into numeric PID signaling authority.
    if (spawned == 0) {
        int status = 0;
        while (waitpid(child, &status, 0) == -1 && errno == EINTR) {}
    }
    return denied(group, groupError) && denied(session, sessionError) && spawned == EPERM;
}

int main(int argc, char** argv) {
    if (argc < 2) return 64;
    if (std::strcmp(argv[1], "spawned-escape") == 0) return 90;
    if (std::strcmp(argv[1], "containment") == 0 && argc == 5) {
        errno = 0;
        const int input = open(argv[2], O_RDONLY);
        const int readError = errno;
        if (input >= 0) close(input);
        errno = 0;
        const int output = open(argv[2], O_WRONLY | O_TRUNC);
        const int writeError = errno;
        if (output >= 0) close(output);
        if (!denied(input, readError) || !denied(output, writeError) ||
            !networkDenied(argv[3]) || !escapeDenied(argv[0])) return 80;
        std::fprintf(stderr, "parent-network/read/write/group-denied\n");
        const pid_t child = fork();
        if (child < 0) return 81;
        if (child == 0) {
            errno = 0;
            const int read = open(argv[2], O_RDONLY);
            const int readError = errno;
            if (read >= 0) close(read);
            errno = 0;
            const int write = open(argv[2], O_WRONLY | O_TRUNC);
            const int writeError = errno;
            if (write >= 0) close(write);
            if (!denied(read, readError) || !denied(write, writeError) ||
                !networkDenied(argv[3]) || !escapeDenied(argv[0])) _exit(82);
            std::fprintf(stderr, "descendant-network/read/write/group-denied\n");
            if (std::strcmp(argv[4], "hold") == 0) usleep(5000000);
            _exit(0);
        }
        int status = 0;
        if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 83;
        return 0;
    }
    if (std::strcmp(argv[1], "fork-hold") == 0) {
        const pid_t child = fork();
        if (child < 0) return 84;
        std::fprintf(stderr, "fork-created\n");
        usleep(5000000);
        return 0;
    }
    if (std::strcmp(argv[1], "open-limit") == 0 && argc == 3) {
        rlimit limit{};
        if (getrlimit(RLIMIT_NOFILE, &limit) != 0 || limit.rlim_cur != std::strtoul(argv[2], nullptr, 10)) return 85;
        int descriptors[256];
        int count = 0;
        for (; count < 256; ++count) {
            descriptors[count] = open("/dev/null", O_RDONLY);
            if (descriptors[count] < 0) break;
        }
        const int error = errno;
        for (int index = 0; index < count; ++index) close(descriptors[index]);
        if (count == 0 || count >= 256 || error != EMFILE) return 86;
        std::fprintf(stderr, "open-files-clamped\n");
        return 0;
    }
    if (std::strcmp(argv[1], "write-limit") == 0) {
        char bytes[6144];
        std::memset(bytes, 'W', sizeof(bytes));
        for (int index = 0; index < 2; ++index) {
            const char* name = index == 0 ? "write-a.bin" : "write-b.bin";
            const int descriptor = open(name, O_WRONLY | O_CREAT | O_EXCL, 0600);
            if (descriptor < 0 || write(descriptor, bytes, sizeof(bytes)) != sizeof(bytes)) return 87;
            close(descriptor);
        }
        std::fprintf(stderr, "two-files-written\n");
        usleep(5000000);
        return 0;
    }
    return 65;
}
