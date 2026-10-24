export interface ChangelogSection {
  title: string;
  items: string[];
}

export interface ChangelogRelease {
  version: string;
  date: string;
  sections: ChangelogSection[];
}

export const CHANGELOG_DATA_VI: ChangelogRelease[] = [
  {
    version: "1.6.1",
    date: "2026-10-24",
    sections: [
      {
        title: "Trung Tâm Thông Báo, Bản Linux Full",
        items: [
          "Bổ sung Trung tâm Thông báo ngay trên thanh công cụ; hộp thoại đọc bài báo hỗ trợ tiếng Việt/tiếng Anh và bộ nhớ đệm ngoại tuyến.",
          "Phát hành bản cài đặt Linux Full (.deb, .rpm, .AppImage) tích hợp sẵn toàn bộ 6 ngôn ngữ (GCC 14.2, Python 3.12, Free Pascal 3.2.2, Temurin JDK 21, Scratch 0.1.7) và khắc phục triệt để xung đột thư viện môi trường trên AppImage.",
          "Hỗ trợ đối chiếu không phân biệt hoa/thường cho tệp dữ liệu vào/ra (.INP/.inp, .OUT/.out), tệp cấu hình (Config.cfg / config.cfg) và trình chấm/trình tương tác trên hệ thống tệp Linux/macOS.",
          "Tự động bỏ qua các tệp và thư mục metadata của macOS (__MACOSX, .DS_Store, ._*) khi giải nén và quét danh sách thí sinh, bài tập, bộ test.",
          "Hỗ trợ nhập số thập phân bằng dấu phẩy (ví dụ: 2,5 hoặc 0,5) trong công cụ tính điểm hữu tỉ và hộp thoại Cài đặt bài thi, kèm kiểm tra hợp lệ nghiêm ngặt trước khi lưu.",
        ],
      },
    ],
  },
  {
    version: "1.6.0",
    date: "2026-10-20",
    sections: [
      {
        title: "Hỗ trợ chính thức Linux (Ubuntu 22.04 LTS+), Sandbox Bubblewrap & Nâng cấp Đa Nền Tảng",
        items: [
          "Chính thức phát hành JudgeDesk cho hệ điều hành Linux x86_64 (Ubuntu 22.04 LTS, 24.04 LTS, 26.04 LTS+, ELF GLIBC <= 2.34) với 3 bộ cài đặt .deb, .rpm và .AppImage độc lập.",
          "Tự động phát hiện và chứng nhận mọi phiên bản trình biên dịch hệ thống trên Linux (Local auto-detect cho GCC/Clang C/C++, Python 3, Free Pascal fpc, OpenJDK javac/java) cùng bộ chạy Scratch tích hợp sẵn và Precompiled Header (bits/stdc++.h.gch).",
          "Cô lập thực thi an toàn trên Linux bằng Bubblewrap (bwrap) + systemd User Scope (cgroup v2) + seccomp-bpf và bổ sung runner chấm bài tương tác hai chiều (linux_interactive).",
          "Hợp nhất nhân điều phối sang kiến trúc Pure Rust (judgedesk-core) và tự động bảo lưu toàn bộ gói toolchain từ bản Full sang thư mục người dùng khi cập nhật lên bản Core.",
          "Bổ sung hộp thoại xem trước mã nguồn Checker tích hợp (C1-C5, Polygon testlib.h) trực tiếp trong ứng dụng kèm nút sao chép nhanh và mở trình soạn thảo ngoài.",
        ],
      },
    ],
  },
  {
    version: "1.5.5",
    date: "2026-10-07",
    sections: [
      {
        title: "Tái cấu trúc Cấu hình bài thi, Phân nhóm Nhanh, Kiểm tra Định dạng Test & Tối ưu Bộ nhớ Compiler",
        items: [
          "Tái cấu trúc cửa sổ Cài đặt bài thi thành 3 tab chuyên biệt: Cơ bản, Tests và Biên dịch; cải thiện không gian hiển thị danh sách testcase và bảo lưu dữ liệu nháp khi chuyển tab.",
          "Thanh công cụ phân nhóm nhanh theo dải số thứ tự (ví dụ: 1-8, 10, 12-19) và hộp thoại Sửa nhóm chuyên sâu với công cụ tính điểm phân số hữu tỉ tự động.",
          "Công cụ kiểm tra định dạng test input chuẩn tắc (Test Well-Formed) theo chuẩn Polygon/Codeforces, hoạt động chỉ đọc an toàn và hiển thị lỗi chính xác tới dòng và cột.",
          "Tự động di trú và dọn dẹp các gói compiler trùng lặp vào thư mục chuẩn %LOCALAPPDATA%/ThemisV2/toolchains, giải phóng bộ nhớ lưu trữ khi cập nhật.",
          "Ghi tệp cấu hình đĩa Config.cfg an toàn với cơ chế file tạm độc quyền và fsync trước khi atomic rename.",
        ],
      },
    ],
  },
  {
    version: "1.5.3",
    date: "2026-10-06",
    sections: [
      {
        title: "Nhận test từ cặp file cùng tên",
        items: [
          "Bổ sung cách thức nhận test mới: cặp file input và output cùng tên được tính là 1 test.",
          "Bug fixes.",
        ],
      },
    ],
  },
  {
    version: "1.5.2",
    date: "2026-10-05",
    sections: [
      {
        title: "Nhận test từ cặp file cùng tên",
        items: [
          "Bổ sung cách thức nhận test mới: cặp file input và output cùng tên được tính là 1 test."
        ],
      },
    ],
  },
  {
    version: "1.5.1",
    date: "2026-09-23",
    sections: [
      {
        title: "Sửa lỗi và cải tiến nhỏ",
        items: [
          "Bug fixes and small improvements."
        ],
      },
    ],
  },
  {
    version: "1.5.0",
    date: "2026-09-16",
    sections: [
      {
        title: "Universal Precompiled Header C++, Tự Động Di Trú Chính Sách & Cải Tiến Updater",
        items: [
          "Tự động phát hiện và sinh Precompiled Header (bits/stdc++.h.gch) đa năng cho mọi trình biên dịch C++ (Managed GCC, MinGW-w64, MSYS2 UCRT64, Apple Clang).",
          "Bộ băm định danh compiler siêu nhạy theo canonical path, file size, modification time và version hash để tái sử dụng an toàn và làm mới cache đúng lúc.",
          "Tự động di trú chính sách thực thi toolchain cũ (migrateLegacyExecutionPolicy) sang cấu hình bảo mật chuẩn một cách minh bạch và an toàn.",
          "Tinh gọn giao diện Quản lý Trình biên dịch (F6 Toolchain Manager), loại bỏ bảng Nâng cao và danh sách phiên bản thử nghiệm để tập trung trải nghiệm cài đặt trực quan.",
          "Tích hợp nút cập nhật ứng dụng nổi bật trên thanh công cụ với tiến trình tải Core ngầm và nút khởi động lại một chạm để áp dụng.",
          "Luôn cập nhật bản Core nhất quán dù trước đó cài bản Full hay Core, bảo lưu trọn vẹn mọi tuỳ chọn người dùng và đường dẫn compiler đã thiết lập.",
          "Bổ sung nút mời cà phê / donate tiện lợi và thân thiện trên thanh công cụ.",
          "Cập nhật bộ nhận diện thương hiệu và biểu tượng ứng dụng mới trên cả Windows và macOS.",
        ],
      },
    ],
  },
  {
    version: "1.4.46",
    date: "2026-09-04",
    sections: [
      {
        title: "Bài Tương Tác (Interactive), Chấm Điểm Phân Số & Tối Ưu Tốc Độ Khởi Động",
        items: [
          "Hỗ trợ bài thi tương tác (Interactive Problems & Interactor) qua Win32 AppContainer dual-job runner với hai đường ống ẩn danh hai chiều (bidirectional anonymous pipes).",
          "Hỗ trợ biên dịch và thực thi Interactor viết bằng C++ (hỗ trợ testlib.h chuẩn Codeforces/Polygon) và Python.",
          "Hỗ trợ nạp bộ testcase bài tương tác chỉ chứa file dữ liệu vào (.inp) mà không bắt buộc có file kết quả mẫu (.out).",
          "Công cụ chấm điểm phân số chính xác tuyệt đối (Rational Scoring Engine), triệt tiêu hoàn toàn sai số trôi dấu phẩy động IEEE 754.",
          "Tính toán và cộng dồn điểm chính xác dạng số hữu tỉ tối giản qua ước chung lớn nhất (GCD), định dạng chuẩn xác trên Scoreboard và file Excel.",
          "Tự động sinh và nạp Precompiled Header (bits/stdc++.h.gch) giúp tăng tốc độ biên dịch C++ gấp ~16.5 lần (từ ~3.6s xuống ~0.23s).",
          "Cơ chế Background Judge Pre-warm chạy ngầm ngay khi mở ứng dụng, loại bỏ hoàn toàn độ trễ 10-13s khi bấm Chấm bài lần đầu.",
          "Bắt tay đồng bộ giữa phiên chấm và tiến trình pre-warm để đảm bảo không xung đột tài nguyên.",
          "Cải tiến cửa sổ tiến trình với hiệu ứng chờ mượt mà trong giai đoạn chuẩn bị và hiển thị phần trăm chuẩn xác từ bài thi đầu tiên.",
          "Bản địa hóa toàn diện tiếng Việt cho các thông báo trạng thái chấm bài.",
          "Sửa lỗi lưu cờ Interactive vào Config.cfg và hiển thị testcase bài tương tác trong cửa sổ Cài đặt bài tập.",
        ],
      },
    ],
  },
  {
    version: "1.4.45",
    date: "2026-08-31",
    sections: [
      {
        title: "Nâng giới hạn Bộ nhớ 1024 MB & Tối ưu Trình biên dịch",
        items: [
          "Hỗ trợ cấu hình giới hạn bộ nhớ (Memory Limit) lên đến 1024 MB (1 GB) trên cả Windows và macOS, mặc định 256 MB theo tiêu chuẩn các kỳ thi Olympic Tin học / HSG / ICPC.",
          "Mở rộng chính sách tài nguyên bộ nhớ trên Windows từ 512 MB lên 1024 MB cho các tiến trình chấm và biên dịch.",
          "Tối ưu hóa khâu chuẩn bị tệp nguồn và đối tượng biên dịch (Compiler Staging), đảm bảo định danh tệp an toàn và xử lý sạch sẽ các ký tự đặc biệt / phần mở rộng.",
          "Rút gọn token UUID trong chẩn đoán hệ thống (Diagnostics) giúp tăng tốc độ kiểm tra tự động và duy trì tính ổn định cao.",
          "Cập nhật giao diện Cài đặt bài thi và bảng dịch đa ngôn ngữ (Tiếng Việt & Tiếng Anh).",
        ],
      },
    ],
  },
  {
    version: "1.4.44",
    date: "2026-08-29",
    sections: [
      {
        title: "Hoàn thiện tuyệt đối Chấm thi Scratch trên Windows & macOS",
        items: [
          "Khắc phục triệt để lỗi khởi tạo runtime 0xC0000142 (STATUS_DLL_INIT_FAILED) trên Windows Sandbox bằng cơ chế cách ly an toàn ResourceOnly qua Windows Job Object, kiểm soát chặt chẽ giới hạn thời gian (Time Limit), bộ nhớ (Memory Limit), số lượng tiến trình và luồng I/O.",
          "Tương thích hoàn chỉnh cơ chế sandbox Apple Seatbelt & Run Guardian trên macOS.",
          "Đưa scratch-windows-x64 và scratch-macos-arm64 vào bản kê phân phối chính thức có chữ ký số Ed25519 (toolchains-manifest.json), loại bỏ hoàn toàn hiện tượng Scratch bị chuyển về Not available sau khi người dùng cập nhật ứng dụng.",
          "Cập nhật schema chuẩn Scratch 3.0 cho chẩn đoán tự động (Diagnostics) và self-test probe.",
          "Đồng bộ hiển thị badge phiên bản động và xác thực chấm thi thành công 100% với các bộ đề thi Tin học trẻ thực tế.",
        ],
      },
    ],
  },
  {
    version: "1.4.43",
    date: "2026-08-29",
    sections: [
      {
        title: "Tích hợp chính thức scratch-run (VNOI) & Hoàn thiện giao diện",
        items: [
          "Tích hợp runner chuẩn scratch-run của VNOI (VNOI-Admin / Lê Bảo Hiệp) xây dựng trên TurboWarp scratch-vm, giải quyết triệt để lỗi TOOLCHAIN_NOT_SANDBOX_COMPATIBLE và đảm bảo tương thích 100% với các kỳ thi Tin học trẻ.",
          "Bổ sung gói toolchain Scratch vào bản Full Edition tự động kích hoạt theo mặc định và hỗ trợ tải về tự động trong bản Core Edition.",
          "Tối ưu thanh công cụ: Loại bỏ nút Sắp xếp điểm trên Toolbar để giao diện gọn gàng (vẫn giữ nút sắp xếp cạnh tiêu đề Tổng điểm trên Scoreboard).",
          "Tinh chỉnh nút Updater: Hiển thị trạng thái «Đã mới nhất» ngắn gọn, nổi bật khi có bản cập nhật mới.",
          "Thêm Scratch vào chẩn đoán hệ thống (Diagnostics) và ghi nhận credit chính thức cho VNOI-Admin trong Trung tâm hướng dẫn.",
        ],
      },
    ],
  },
  {
    version: "1.4.42",
    date: "2026-08-29",
    sections: [
      {
        title: "Bản sửa lỗi nhanh (Hotfix) cho v1.4.4",
        items: [
          "Sửa lỗi không thể kích hoạt hoặc áp dụng gói Scratch trong Quản lý trình biên dịch (F6) và hộp thoại chào mừng.",
          "Cải thiện độ chuyển mượt của thanh tiến trình chấm bài khi kết thúc làm ấm và bắt đầu chấm bài thi đầu tiên.",
        ],
      },
    ],
  },
  {
    version: "1.4.4",
    date: "2026-08-28",
    sections: [
      {
        title: "Tích hợp Chấm Bài thi Scratch (.sb3, .sb2, .sb)",
        items: [
          "Hỗ trợ chấm trực tiếp các tệp bài làm Scratch (.sb3, .sb2, .sb) phục vụ các kỳ thi Tin học trẻ.",
          "Cơ chế nạp test tự động qua khối lệnh «Hỏi và đợi» (bỏ qua câu hỏi hiển thị) và xuất kết quả qua khối «Nói» hoặc «Nghĩ».",
          "Máy ảo Scratch Headless chạy chế độ Turbo Mode siêu tốc (10-25ms/testcase), tiêu thụ ít tài nguyên và xử lý an toàn vòng lặp vô hạn (TLE).",
          "Tương thích hoàn toàn trên cả Windows và macOS với quy tắc chấm đồng nhất 100%.",
          "Hộp thoại hỏi kích hoạt 1 lần duy nhất khi nâng cấp lên v1.4.4, dễ dàng bật tắt lại trong Quản lý trình biên dịch (F6).",
        ],
      },
      {
        title: "Tối ưu Phản hồi Cửa sổ Chấm & Khởi động Nhanh",
        items: [
          "Cửa sổ tiến trình chấm bài hiện ngay lập tức khi bấm Chấm bài (F9), loại bỏ hoàn toàn độ trễ 2-5s trước đây.",
          "Tự động làm ấm sandbox chạy ngầm khi mở ứng dụng và lưu cache nhị phân cho Custom Checker (.cpp, .py, .exe), giúp chấm testcase đầu tiên ngay tức thì mà không phải chờ đợi.",
        ],
      },
      {
        title: "Bổ sung Hướng dẫn Nộp bài trong Trợ giúp (F1)",
        items: [
          "Cập nhật tài liệu hướng dẫn quy cách nộp bài và các lưu ý khi làm bài thi Scratch trong Trung tâm Trợ giúp (F1) ở cả tiếng Việt và tiếng Anh.",
        ],
      },
    ],
  },
  {
    version: "1.4.3",
    date: "2026-08-28",
    sections: [
      {
        title: "Nút Sắp xếp Điểm Động & Xuất Excel Theo Thứ tự",
        items: [
          "Bổ sung nút chuyển đổi 3 trạng thái sắp xếp điểm trên Toolbar (Điểm cao -> Điểm thấp -> Mặc định), tự động đồng bộ khi click cột Tổng Điểm trên Bảng điểm.",
          "Thí sinh chưa có điểm tự động hiển thị ở cuối danh sách; hòa điểm được xếp theo tên A-Z.",
          "File Excel xuất ra tuân thủ chính xác thứ tự bảng điểm đang hiển thị và sắp xếp các cột bài thi chi tiết từ trái qua phải.",
          "Loại bỏ khung lỗi tràn ngang trên Toolbar, chuyển sang hệ thống Thông báo Lỗi nổi (App Error Toast) linh hoạt.",
        ],
      },
      {
        title: "Tự Kiểm Tra Trình Biên Dịch & Tối Ưu Bảng Điểm",
        items: [
          "Thêm tính năng Chẩn đoán / Tự kiểm tra (Self-Test Probe) trong Quản lý bộ công cụ cho 5 ngôn ngữ thi đấu (C++, C, Python, Pascal, Java) trực tiếp trong Native Sandbox Runner để đo đạc thời gian biên dịch, thực thi và bộ nhớ tiêu thụ.",
          "Tối ưu hóa bảng băm O(1) cho bảng điểm, giúp tra cứu và sắp xếp tức thì trên các kỳ thi có hàng trăm thí sinh và bài nộp.",
          "Tách biệt hoàn toàn tầng Modals Layer và tối ưu hóa bộ mã nguồn ứng dụng.",
        ],
      },
    ],
  },
  {
    version: "1.4.2",
    date: "2026-08-27",
    sections: [
      {
        title: "Tương thích Custom Checker Đa Định dạng & Tự động Nạp Header",
        items: [
          "Hỗ trợ toàn diện Custom Checker định dạng .exe, .cpp và .py trong thư mục test bài tập trên Windows; tự động ưu tiên file .exe lên đầu danh sách chọn.",
          "Tự động nạp toàn bộ header cục bộ trong thư mục bài tập (testlib.h, header Themis, v.v.) khi biên dịch C++ checker trên cả Windows và macOS, chấm dứt hoàn toàn lỗi CE do thiếu header.",
          "Trên macOS: Tự động loại trừ các binary Windows .exe không tương thích, ưu tiên các checker mã nguồn .cpp và .py.",
        ],
      },
      {
        title: "Hoàn thiện Nhận diện Compiler Themis & Policy Tương thích",
        items: [
          "Khắc phục lỗi hiển thị sai phiên bản compiler Themis; hiển thị chính xác phiên bản thực tế của toàn bộ công cụ Themis phát hiện được (GCC 9.2.0, FPC 3.2.2, Python 3.12.4, Java 1.7.0).",
          "Quét toàn diện trên mọi ổ đĩa chuẩn (C:\\Themis, D:\\Themis, E:\\Themis, Program Files (x86)\\Themis), phát hiện đầy đủ mọi toolchain mà không bị ngắt sớm do các compiler có sẵn trên PATH.",
          "Mở rộng chính sách sandbox và cơ chế fallback Job Object an toàn cho các binary legacy 32-bit (x86 WOW64) của Themis MinGW GCC / FPC / Python, xóa bỏ hoàn toàn lỗi \"Không tương thích với policy máy chấm an toàn hiện tại\".",
        ],
      },
    ],
  },
  {
    version: "1.4.1",
    date: "2026-08-25",
    sections: [
      {
        title: "Tự động nhận diện & So sánh Bộ công cụ Themis",
        items: [
          "Tự động phát hiện bộ công cụ Themis (GCC 9.2, FPC 3.0/3.2, Python, Java) khi mở ứng dụng lần đầu và hiển thị bảng so sánh trực quan với Chuẩn Olympic 64-bit.",
          "Hỗ trợ áp dụng toàn bộ công cụ của Themis hoặc tinh chỉnh từng ngôn ngữ trong Cài đặt Bộ công cụ.",
        ],
      },
      {
        title: "Cải tiến Giao diện Cấu hình Bài thi",
        items: [
          "Căn giữa cửa sổ chỉnh sửa điểm (POINTS), thời gian chạy và nhóm test để thuận tiện thao tác, tránh bị tràn nút Lưu trên các màn hình kích thước nhỏ.",
        ],
      },
    ],
  },
  {
    version: "1.4.0",
    date: "2026-08-25",
    sections: [
      {
        title: "Sửa lỗi Tương tác Kỳ thi .judgedesk",
        items: [
          "Khắc phục triệt để lỗi không thao tác được bảng điểm khi mở tệp .judgedesk bằng cách bấm đúp từ File Explorer (Windows) và Finder (macOS).",
          "Cho phép tích chọn thí sinh, lọc bài tập, chấm bài, xoá điểm và cấu hình bài thi mượt mà sau khi mở file mà không bị ghi đè dữ liệu gốc.",
          "Tự động phát hiện thay đổi và hỗ trợ lưu đè trực tiếp (Ctrl+S / ⌘S) hoặc lưu mới (Ctrl+Shift+S / ⌘Shift+S) vào chính file .judgedesk đang mở.",
        ],
      },
      {
        title: "Trải nghiệm Cập nhật 1-Click Siêu tốc",
        items: [
          "Đơn giản hóa luồng cập nhật: Bấm 1 click vào nút cập nhật trên thanh công cụ để tự động tải ngay gói Core siêu nhẹ (~20 MB) trong nền mà không cần qua hộp thoại lựa chọn.",
          "Bảo lưu 100% các bộ toolchain, cấu hình và dữ liệu người dùng đã có trong máy sau mỗi lần cập nhật.",
        ],
      },
      {
        title: "Tối ưu hóa Trình chấm & Đa nền tảng",
        items: [
          "Chuẩn hóa quy trình biên dịch Java: Tự động trích xuất và staging theo tên public class thực tế, đảm bảo các bài nộp Java hoạt động chuẩn xác trên cả macOS và Windows.",
          "Đồng nhất kết quả chia cho 0 trên macOS: Bổ sung bẫy SIGTRAP cho Apple Clang trên CPU ARM64, trả về lỗi chạy Runtime Error (0 điểm) chính xác 100% như trên x86 Windows.",
          "Tự động khử trùng lặp Toolchain (Deduplication): Bản Full khởi động tức thì (< 1s) với cơ chế Zero-Copy và tự động dọn dẹp các thư mục duplicate trong AppData giúp giải phóng ~800 MB ổ cứng.",
        ],
      },
    ],
  },
  {
    version: "1.3.83",
    date: "2026-08-24",
    sections: [
      {
        title: "Tối ưu hóa macOS & Native Executor",
        items: [
          "Sửa triệt để lỗi treo khoá process-tree sau các bài thi đa tiến trình (forkbomb) trên macOS nhờ cơ chế bounded zombie drain timeout.",
          "Hỗ trợ phân giải Symbolic Link cho Apple Clang++ và tự động nhận diện các bản cài đặt Xcode/CommandLineTools.",
          "Cải thiện độ ổn định giao diện khi bấm Huỷ phiên chấm (Terminate) và loại bỏ hiện tượng nháy cửa sổ tiến độ.",
        ],
      },
    ],
  },
  {
    version: "1.3.82",
    date: "2026-08-22",
    sections: [
      {
        title: "Sửa triệt để Xuất Excel & Tối ưu Bảng điểm",
        items: [
          "Sửa dứt điểm lỗi xuất file Excel rỗng khi lọc selection: Tự động so khớp linh hoạt và fallback toàn diện lấy đầy đủ các cột bài tập, điểm số từng bài và tổng điểm.",
          "Luôn tổng hợp và hiển thị đầy đủ Run Metadata môi trường hệ thống trong file Excel kể cả khi mở từ kỳ thi đã lưu.",
        ],
      },
    ],
  },
  {
    version: "1.3.8",
    date: "2026-08-22",
    sections: [
      {
        title: "Trải nghiệm Cập nhật & Thông tin Phát hành",
        items: [
          "Tự động hiển thị cửa sổ 'Có gì mới trong JudgeDesk' ngay sau khi cập nhật lên phiên bản mới.",
          "Bổ sung mục xem lại toàn bộ Nhật ký thay đổi (Changelog) song ngữ bất kỳ lúc nào từ Trung tâm Trợ giúp (phím F1).",
        ],
      },
      {
        title: "Sửa lỗi Xuất Excel & Run Metadata",
        items: [
          "Sửa triệt để lỗi xuất Excel bảng điểm trống và thông báo 'Run Metadata: Unavailable' khi xuất từ contest đã lưu hoặc sau khi chấm trực tuyến OSD.",
          "Hỗ trợ so khớp tên thí sinh và bài thi không phân biệt hoa thường (case-insensitive), bảo toàn định dạng hiển thị.",
          "Tự động tổng hợp dữ liệu môi trường thực tế (hostStatus) làm fallback khi chưa có metadata lượt chạy.",
        ],
      },
      {
        title: "Mở file .judgedesk khi Bấm đúp & Kéo thả",
        items: [
          "Hỗ trợ mở file kỳ thi .judgedesk trực tiếp khi bấm đúp từ File Explorer (Windows) và Finder (macOS), tự động nạp toàn bộ đề bài, thí sinh và bảng điểm.",
          "Hỗ trợ chuyển giao mở file tức thì khi ứng dụng đang mở sẵn (single-instance IPC activation).",
          "Thêm hiệu ứng overlay kéo thả file .judgedesk toàn màn hình và nâng cấp vùng thả thư mục trong hộp thoại chọn Đề thi / Thí sinh.",
        ],
      },
    ],
  },
  {
    version: "1.3.7",
    date: "2026-08-21",
    sections: [
      {
        title: "Chấm bài trực tuyến (Online Judge / OSD)",
        items: [
          "Tự động quét và nhận diện bài nộp mới theo thời gian thực từ thư mục nộp bài chung (OSD Shared Folder).",
          "Hàng đợi chấm bài thông minh, cập nhật tiến độ, điểm số và chi tiết chấm tức thì trên bảng điểm.",
          "Bổ sung nút trạng thái OSD và bảng điều khiển cấu hình tiện lợi trên thanh công cụ.",
        ],
      },
      {
        title: "Luồng Cập nhật Siêu tốc & Early Migration",
        items: [
          "Mặc định tải gói Core Update (~39 MB) hoàn tất trong 3-5 giây, không cần tải lại 800 MB toolchains.",
          "Cơ chế Early Cut-and-Paste Migration tự động bảo lưu 100% compilers vào thư mục người dùng an toàn.",
        ],
      },
    ],
  },
  {
    version: "1.3.6",
    date: "2026-08-20",
    sections: [
      {
        title: "Hiệu năng chấm bài & Tối ưu hóa chuyển Testcase",
        items: [
          "Khôi phục cơ chế Submission-level Artifact Caching: File thực thi của thí sinh và custom checker được nạp vào bộ nhớ đệm an toàn của Sandbox (artifacts/) đúng 1 lần duy nhất ngay sau khi biên dịch và tái sử dụng tức thì trên toàn bộ các testcase.",
          "Triệt tiêu độ trễ giữa các testcase: Loại bỏ hoàn toàn thao tác sao chép (fs.copyFileSync) và xóa file .exe lặp đi lặp lại ở từng testcase, giải phóng 100% gánh nặng I/O đĩa NTFS và ngăn chặn triệt để hiện tượng Windows Defender liên tục chặn quét lại cùng một file thực thi qua mỗi test.",
          "Tối ưu hóa máy tính đời cũ: Giảm tải hoàn toàn tắc nghẽn đọc/ghi trên các phòng máy dùng ổ cứng cơ (HDD) và CPU thế hệ cũ, mang lại trải nghiệm chấm nhảy testcase tức thì (< 1ms).",
        ],
      },
    ],
  },
  {
    version: "1.3.5",
    date: "2026-08-19",
    sections: [
      {
        title: "Phím tắt & Trải nghiệm điều hướng bàn phím",
        items: [
          "Bổ sung hệ thống phím tắt đồng bộ với Themis truyền thống (F1 - F12, Ctrl+N/O/S, Ctrl+Shift+S, Ctrl+A/D/I, Ctrl+Shift+A/D/I).",
          "Tự động nhận diện và chuyển đổi phím bổ trợ trên macOS (Ctrl → Command ⌘, Ctrl+Shift → Shift+Command ⇧⌘).",
          "Hỗ trợ điều hướng bảng điểm hoàn toàn không cần chuột: Dùng các phím mũi tên (↑ ↓ ← →) di chuyển ô chọn với đường viền tiêu điểm rõ ràng, phím Space để bật/tắt ô checkbox, phím Enter để mở cửa sổ xem chi tiết kết quả testcase.",
          "Cơ chế bảo vệ thông minh tránh xung đột phím tắt: Giữ nguyên hành vi bôi đen toàn bộ văn bản của Ctrl+A khi con trỏ đang ở ô nhập liệu; khóa thao tác bảng điểm ngầm khi đang mở modal.",
          "Hỗ trợ phím Esc (Escape) trên toàn bộ các modal, dialog, cửa sổ cấu hình và xem log để thoát nhanh về màn hình chính.",
        ],
      },
      {
        title: "Trình biên dịch & Ổn định môi trường chấm",
        items: [
          "Loại bỏ cơ chế băm file SHA-256 nhị phân trước khi chấm, chấm trực tiếp file thực thi trong thư mục tạm được bảo vệ của sandbox. Giải quyết triệt để hiện tượng cảnh báo nhầm từ Windows Defender mà vẫn đảm bảo 100% độ an toàn.",
          "Nâng cấp cơ chế tự động nhận diện compiler cục bộ (MSYS2 UCRT64, MinGW64, CodeBlocks MinGW, Themis GCC) ngay lần đầu khởi động, tự động bảo lưu và ghi nhớ đường dẫn qua các lần cập nhật ứng dụng.",
        ],
      },
      {
        title: "Tài liệu & Hướng dẫn sử dụng",
        items: [
          "Đại tu toàn diện nội dung Trung tâm Hướng dẫn (HelpCenter), chuẩn hóa thuật ngữ sư phạm, diễn đạt tự nhiên, rõ ràng cho giáo viên và học sinh.",
          "Bổ sung chuyên mục tra cứu phím tắt chi tiết trong Hướng dẫn sử dụng (F1) và hiển thị gợi ý phím tắt trực tiếp trên tooltip của các nút thanh công cụ.",
        ],
      },
    ],
  },
  {
    version: "1.3.4",
    date: "2026-08-13",
    sections: [
      {
        title: "Cập nhật Core và Full",
        items: [
          "Khi có phiên bản mới, nút Updater mở hai lựa chọn Core và Full, đánh dấu bản đang dùng và hiển thị dung lượng tải về/dung lượng sau cài đặt từ chính artefact release.",
          "Cập nhật cùng edition bắt đầu tải ngay sau khi chọn. Khi đổi Core ↔ Full, JudgeDesk giải thích trước ảnh hưởng tới toolchain và yêu cầu xác nhận trước khi tải.",
          "Core → Core và Full → Full giữ lựa chọn compiler/runtime tùy chỉnh. Full mới thay các toolchain tích hợp bằng package của release mới; Core không tự đổi đường dẫn compiler người dùng đã chọn.",
        ],
      },
      {
        title: "Ủng hộ dự án",
        items: [
          "Thêm nút cốc cà phê giữa Updater và Công cụ. JudgeDesk luôn hỏi xác nhận trước khi mở trang QR ủng hộ bằng trình duyệt mặc định.",
        ],
      },
    ],
  },
  {
    version: "1.3.3",
    date: "2026-08-13",
    sections: [
      {
        title: "Hiệu năng và độ phản hồi",
        items: [
          "Giảm mạnh thời gian khởi động Native protection trên Windows khi cache toolchain lớn đã có đúng ACL.",
          "Mỗi phiên chấm chỉ quét source thí sinh/test một lần và lưu sẵn cấu hình trọng số, điểm tối đa, time limit để dùng lại.",
          "Bảng điểm dùng chỉ mục kết quả, memo hóa từng hàng và gom các progress event dày vào frame giao diện mới nhất, giúp cuộn/chấm kỳ thi lớn ổn định hơn.",
          "Nén/mở kỳ thi .judgedesk, tạo workbook Excel và các thao tác toolchain nặng được chuyển khỏi luồng giao diện.",
        ],
      },
      {
        title: "Xuất Excel",
        items: [
          "Nút Xuất file Excel sáng khi bảng điểm có ít nhất một thí sinh hoặc một bài, kể cả trước khi chấm; các ô và tổng điểm chưa có kết quả là ô trống thật.",
          "Trên Windows có Microsoft Excel, JudgeDesk mở một workbook .xlsx mới chưa lưu để Ctrl+S hoặc đóng workbook đi qua Save As.",
          "Chặn thao tác xuất trùng trong lúc worker đang tạo file và thay giới hạn cũ bằng một giới hạn an toàn 256 MiB cho toàn payload.",
        ],
      },
    ],
  },
  {
    version: "1.3.2",
    date: "2026-08-10",
    sections: [
      {
        title: "Toolchain và trải nghiệm cài đặt",
        items: [
          "Full tự chọn lại mọi package managed đi kèm đúng một lần khi cài mới hoặc khi thay Core bằng Full; sau bootstrap, lựa chọn thủ công tiếp tục được tôn trọng.",
          "Discovery C/C++/Python chạy nền mỗi lần mở app, ưu tiên đúng thứ tự PATH, đọc version/vị trí rồi mới thử các đường dẫn chuẩn có giới hạn.",
          "Thêm công tắc Advanced resource-only cho các môi trường đặc biệt.",
        ],
      },
      {
        title: "Cấu hình bài và hướng dẫn",
        items: [
          "Thêm cấu hình biên dịch riêng từng bài trong Config.cfg: Tương thích Themis (mặc định), Hiện đại (tham khảo IOI/ICPC 2025), ICPC World Finals và Tùy chỉnh.",
          "Thêm Help Center offline song ngữ, tìm kiếm, phím F1, nút Hướng dẫn và phần About/chẩn đoán sản phẩm trong cùng một cửa sổ.",
        ],
      },
    ],
  },
  {
    version: "1.3.0",
    date: "2026-08-01",
    sections: [
      {
        title: "Chấm bài đa ngôn ngữ",
        items: [
          "Bổ sung registry có version cho C++, C, Python, Pascal và Java; mỗi ngôn ngữ công khai rõ trạng thái sẵn sàng chấm.",
          "Thêm lựa chọn nguồn cố định None, Managed by toolchain, Local (path) và Local (auto-detect).",
          "Custom checker C++ và Python đi qua cùng native secure executor, giới hạn tài nguyên và cleanup contract như bài thi thí sinh.",
        ],
      },
      {
        title: "Core, Full và managed toolchain",
        items: [
          "Phát hành riêng Core và Full cho Windows x64 và macOS Apple Silicon. Full tích hợp toàn bộ managed package được duyệt; Core tải các gói đã ký khi cần.",
          "Windows Full kèm GCC 14.2, Python 3.12, FPC 3.2.2, Temurin 21 và WebView2 offline. macOS Full kèm Python/FPC/Temurin ARM64.",
        ],
      },
      {
        title: "Native protection và vòng đời tiến trình",
        items: [
          "Hoàn thiện single-instance: mở JudgeDesk lần hai sẽ chuyển focus về cửa sổ đang chạy thay vì tạo thêm backend hoặc lượt chấm chồng chéo.",
          "Giám sát backend, process group và run guardian trên macOS; fail closed khi không thiết lập được containment.",
        ],
      },
    ],
  },
  {
    version: "1.2.7",
    date: "2026-07-27",
    sections: [
      {
        title: "Ổn định Python được quản lý trên macOS",
        items: [
          "Tôn trọng đúng nguồn Python đang được chọn: System/Custom Python chỉ phục vụ trusted checker, còn bài thi chỉ báo sẵn sàng khi Managed Python thực sự được chọn.",
          "Đưa toàn bộ managed Python package vào executor cache tự chứa, viết lại các symbolic link nội bộ sau khi copy và xử lý đúng alias đường dẫn tạm /var/ /private/var trên macOS.",
        ],
      },
      {
        title: "Reload và phát hiện test",
        items: [
          "Reload giữ nguyên trạng thái đã tick/bỏ tick của thí sinh và problem hiện có; mục mới phát hiện được chọn mặc định, mục đã bị xóa được loại khỏi trạng thái.",
          "Chỉ nhận thư mục test có đủ file input .inp/.in và expected output .out/.ans.",
        ],
      },
    ],
  },
  {
    version: "1.2.6",
    date: "2026-07-26",
    sections: [
      {
        title: "Hợp nhất Repository & Phát hành Công khai",
        items: [
          "Chuyển mã nguồn chính thức sang repository công khai ducminh25/judgedesk.",
          "Nhập toàn bộ tài liệu người dùng, mẫu báo cáo lỗi và workflow đóng gói toolchain.",
          "Cập nhật đường dẫn tra cứu bản cập nhật ứng dụng (latest.json), URL tải về managed toolchain và các liên kết hỗ trợ.",
        ],
      },
      {
        title: "Sửa lỗi chấm bài Python trên macOS",
        items: [
          "Khắc phục lỗi chọn nhầm System Python gây lỗi TOOLCHAIN_NOT_SANDBOX_COMPATIBLE khi chấm bài Python bằng Managed Toolchain trong sandbox macOS.",
          "Bổ sung quy tắc process-exec cho thư mục toolchain_root trong cấu hình Seatbelt sandbox.",
        ],
      },
    ],
  },
  {
    version: "1.2.5",
    date: "2026-07-24",
    sections: [
      {
        title: "Bảo vệ Native & Tính đúng đắn",
        items: [
          "Nâng cấp native secure executor mặc định: Windows dùng LPAC/AppContainer kết hợp Job Object; macOS dùng sandbox profile theo từng run, process group và resource limits.",
          "Chèn trap cho phép chia số nguyên với mẫu số bằng 0 khi compile bằng Apple Clang thành RE, nhất quán với GCC/x86 trên Windows.",
          "Chặn forkbomb, memory boundary lặp 20 lần và bảo vệ không để lại tiến trình con mồ côi khi hủy hoặc thoát app.",
        ],
      },
      {
        title: "Quản lý kỳ thi & Bảng điểm",
        items: [
          "Hoàn thiện định dạng file kỳ thi .judgedesk lưu trữ toàn bộ đề bài, thí sinh, cấu hình và kết quả chấm.",
          "Nâng cấp xuất file Excel và chẩn đoán JSON chi tiết cho từng ca chấm.",
        ],
      },
    ],
  },
];

export const CHANGELOG_DATA_EN: ChangelogRelease[] = [
  {
    version: "1.6.1",
    date: "2026-10-24",
    sections: [
      {
        title: "Notification Center & Linux Full Edition",
        items: [
          "Added an in-app Notification Center on the toolbar with an article reader supporting Vietnamese/English and offline caching.",
          "Released Linux Full edition installers (.deb, .rpm, .AppImage) bundling all 6 languages offline (GCC 14.2, Python 3.12, Free Pascal 3.2.2, Temurin JDK 21, Scratch 0.1.7) and resolved AppImage runtime library conflicts.",
          "Added case-insensitive file matching for problem I/O files (.INP/.inp, .OUT/.out), configuration files (Config.cfg / config.cfg), and custom checkers/interactors on Linux and macOS.",
          "Automatically ignored macOS archive metadata files and directories (__MACOSX, .DS_Store, ._*) when scanning contestants, problems, and testcases.",
          "Added support for comma decimal inputs (e.g. 2,5 or 0,5) across the rational scoring engine and Problem Configuration dialogs, with strict validation before saving.",
        ],
      },
    ],
  },
  {
    version: "1.6.0",
    date: "2026-10-20",
    sections: [
      {
        title: "Official Linux Desktop Support (Ubuntu 22.04 LTS+), Bubblewrap Sandbox & Cross-Platform Refinements",
        items: [
          "Official Linux x86_64 desktop release (Ubuntu 22.04 LTS, 24.04 LTS, 26.04 LTS+, ELF GLIBC <= 2.34) with format-isolated .deb, .rpm, and .AppImage packages.",
          "Version-agnostic auto-detection and sandbox compatibility verification for Linux system toolchains (GCC/Clang C/C++, Python 3, Free Pascal fpc, OpenJDK javac/java) plus bundled Scratch runtime and Universal Precompiled Header (bits/stdc++.h.gch).",
          "Linux native sandbox isolation using Bubblewrap (bwrap) + systemd User Scope (cgroup v2) + seccomp-bpf filters and bidirectional Interactive Problem Runner (linux_interactive).",
          "Unified Pure Rust backend engine (judgedesk-core) and automatic preservation of bundled Full toolchains into user data directory across Core updates.",
          "In-app Checker Source Preview dialog for all built-in checkers (C1-C5, Polygon testlib.h) with instant one-click copy and external editor launch.",
        ],
      },
    ],
  },
  {
    version: "1.5.5",
    date: "2026-10-07",
    sections: [
      {
        title: "Problem Config Tabs, Quick Grouping, Test Well-Formed Validation & Toolchain Storage Deduplication",
        items: [
          "Reorganized the Problem Configuration dialog into three accessible tabs: Basic, Tests, and Compilation, preserving drafts and compile validation across tab switches.",
          "Quick test grouping toolbar supporting range syntax (e.g. 1-8, 10, 12-19) and dedicated Edit Group dialog with automatic rational scoring redistribution.",
          "Strict read-only Polygon/Codeforces-compliant test input well-formed validation with exact line and column diagnostics.",
          "Automatic migration and deduplication of managed toolchains into %LOCALAPPDATA%/ThemisV2/toolchains, reclaiming disk space across updates.",
          "Crash-resilient atomic Config.cfg file persistence using exclusive temporary files and fsync before atomic renaming.",
        ],
      },
    ],
  },
  {
    version: "1.5.3",
    date: "2026-10-06",
    sections: [
      {
        title: "Test discovery from matching file pairs",
        items: [
          "Added a new test discovery method: an input file and an output file with the same base name count as one test.",
          "Bug fixes.",
        ],
      },
    ],
  },
  {
    version: "1.5.2",
    date: "2026-10-05",
    sections: [
      {
        title: "Test discovery from matching file pairs",
        items: [
          "Added a new test discovery method: an input file and an output file with the same base name count as one test."
        ],
      },
    ],
  },
  {
    version: "1.5.1",
    date: "2026-09-23",
    sections: [
      {
        title: "Bug fixes and small improvements",
        items: [
          "Bug fixes and small improvements."
        ],
      },
    ],
  },
  {
    version: "1.5.0",
    date: "2026-09-16",
    sections: [
      {
        title: "Universal C++ Precompiled Header, Policy Migration & Streamlined Updater Flow",
        items: [
          "Universal Precompiled Header (bits/stdc++.h.gch) automated cache generation across all C++ compilers (Managed GCC, MinGW-w64, MSYS2 UCRT64, Apple Clang).",
          "Ultra-sensitive compiler digest hashing by canonical path, file size, modification timestamp, and version hash for safe cache reuse and invalidation.",
          "Transparent auto-migration of legacy execution policies (migrateLegacyExecutionPolicy) to standardized secure isolation profiles.",
          "Streamlined F6 Toolchain Manager dialog, removing unnecessary Advanced settings and experimental version listings for an intuitive setup experience.",
          "Interactive in-app updater button on the toolbar displaying background download progress and a one-click restart button to apply updates.",
          "Consistent Core update delivery regardless of prior Full or Core installation while preserving 100% of user preferences and configured compiler paths.",
          "Added coffee donation button on the toolbar with a confirmation dialog.",
          "Refreshed brand identity and high-resolution icons across Windows and macOS.",
        ],
      },
    ],
  },
  {
    version: "1.4.46",
    date: "2026-09-04",
    sections: [
      {
        title: "Interactive Problems, Exact Rational Scoring & Startup Pre-warm Optimizations",
        items: [
          "Integrated interactive problem execution on Windows using a dual-job Win32 AppContainer runner with bidirectional anonymous pipes.",
          "Supported compiling and running custom C++ interactors (bundled with standard Codeforces/Polygon testlib.h) and Python interactors.",
          "Supported interactive testcase discovery with input-only directories without requiring output files.",
          "Exact Rational Scoring Engine eliminating IEEE 754 floating-point epsilon drift across test and problem score accumulation.",
          "Accurate fraction math with greatest common divisor (GCD) simplification, clean formatting, and accurate Excel workbook score exports.",
          "Automatically generated Precompiled Header (bits/stdc++.h.gch) with -std=c++14 -O2 -pipe, speeding up C++ compilation by ~16.5x (from ~3.6s to ~0.23s).",
          "Background Judge Pre-warm initiates immediately upon application launch to stage Managed GCC and warm up the sandbox, eliminating the initial 10–13s delay.",
          "Graceful synchronization between active judge sessions and pre-warm execution to eliminate race conditions.",
          "Polished judging progress window with indeterminate indicator during system setup and accurate percentage progression from the first submission.",
          "Full Vietnamese and English localization for all judging stages.",
          "Fixed interactive configuration persistence in Config.cfg and interactive testcase loading in the Problem Configuration editor.",
        ],
      },
    ],
  },
  {
    version: "1.4.45",
    date: "2026-08-31",
    sections: [
      {
        title: "1024 MB Memory Limit & Compiler Staging Optimizations",
        items: [
          "Supported configuring problem memory limits up to 1,024 MB (1 GB) on both Windows and macOS, with a 256 MB default matching competitive programming contest standards.",
          "Expanded Windows judging resource policy cap from 512 MB to 1,024 MB for active judge and compiler processes.",
          "Optimized compiler argument staging and object naming with robust sanitization for clean artifact filenames.",
          "Shortened probe tokens in toolchain Diagnostics for faster automated health checks and verification.",
          "Updated Problem Configuration UI and localization files (Vietnamese and English).",
        ],
      },
    ],
  },
  {
    version: "1.4.44",
    date: "2026-08-29",
    sections: [
      {
        title: "Complete Scratch Judging Support on Windows & macOS",
        items: [
          "Completely resolved 0xC0000142 (STATUS_DLL_INIT_FAILED) runtime error on Windows Sandbox by employing ResourceOnly Windows Job Object isolation, strictly enforcing time limits, memory limits, process count, and I/O streams.",
          "Ensured full compatibility with macOS Apple Seatbelt sandbox profiles and Run Guardian process supervision.",
          "Integrated scratch-windows-x64 and scratch-macos-arm64 into the official Ed25519-signed distribution manifest (toolchains-manifest.json), eliminating the issue where Scratch status reverted to Not available on update.",
          "Standardized Scratch 3.0 schema for automated Diagnostics and self-test probes.",
          "Dynamic version badges and verified 100% accurate judging against real Young Informatics contest submissions.",
        ],
      },
    ],
  },
  {
    version: "1.4.43",
    date: "2026-08-29",
    sections: [
      {
        title: "Official VNOI scratch-run Integration & UI Refinements",
        items: [
          "Integrated VNOI's official scratch-run runner (built on TurboWarp scratch-vm by VNOI-Admin / Le Bao Hiep), completely resolving TOOLCHAIN_NOT_SANDBOX_COMPATIBLE errors and ensuring 100% Scratch CP compatibility.",
          "Packaged Scratch toolchain in Full Edition with auto-activation by default, and one-click download in Core Edition.",
          "Streamlined Toolbar: Removed redundant score sort button from Toolbar (retained next to Total Score in Scoreboard).",
          "Refined Updater button: Compact «Up to date» badge with prominent highlight when updates are available.",
          "Added Scratch to System Diagnostics and officially credited VNOI-Admin in Help Center documentation.",
        ],
      },
    ],
  },
  {
    version: "1.4.42",
    date: "2026-08-29",
    sections: [
      {
        title: "Hotfix for v1.4.4",
        items: [
          "Fixed an issue where Scratch language preference could not be saved or enabled in Toolchain Manager (F6).",
          "Improved judging progress bar transition from sandbox warm-up to active test execution.",
        ],
      },
    ],
  },
  {
    version: "1.4.4",
    date: "2026-08-28",
    sections: [
      {
        title: "Scratch (.sb3, .sb2, .sb) Language Support",
        items: [
          "Direct headless judging for Scratch project submissions (.sb3, .sb2, .sb) in Young Informatics contests.",
          "Standard CP I/O: Automatic input feeding via «ask and wait» blocks and output capture via «say» (with newline) or «think» (without newline).",
          "High-speed Turbo Mode execution (10-25ms/testcase) with low memory footprint and watchdog TLE handling for infinite loops.",
          "Full cross-platform compatibility across Windows and macOS with identical grading behavior.",
          "One-time upgrade prompt on v1.4.4 launch to enable Scratch, configurable anytime in Toolchain Manager (F6).",
        ],
      },
      {
        title: "Instant Progress Window & Fast Judging Warm-up",
        items: [
          "Judging progress modal appears immediately upon clicking Judge (F9), removing previous 2-5s UI launch delay.",
          "Background sandbox pre-warming at server startup and SHA-256 binary caching for custom checkers (.cpp, .py, .exe) eliminate warm-up latency before the first testcase.",
        ],
      },
      {
        title: "Help Center (F1) Updates",
        items: [
          "Added Scratch submission rules, I/O specifications, and best practices in the offline Help Center (F1) for both Vietnamese and English.",
        ],
      },
    ],
  },
  {
    version: "1.4.3",
    date: "2026-08-28",
    sections: [
      {
        title: "Dynamic Score Sort Button & Sorted Excel Export",
        items: [
          "Added dynamic 3-state score sort button in Toolbar (Score High-to-Low -> Low-to-High -> Default), synced with the Total column header on the scoreboard.",
          "Unscored contestants are automatically placed at the bottom; tied scores are sorted alphabetically by name A-Z.",
          "Excel export preserves the current active scoreboard order and arranges detailed problem sheets cleanly from left to right.",
          "Replaced horizontal inline toolbar error container with floating App Error Toasts to prevent toolbar overflow.",
        ],
      },
      {
        title: "Toolchain Self-Test Probe & Scoreboard Performance",
        items: [
          "Added Self-Test Diagnostic Probe in Toolchains Manager for 5 competitive programming languages (C++, C, Python, Pascal, Java) inside the Native Sandbox Runner to measure compile time, sandbox execution time, and peak memory.",
          "Optimized scoreboard sorting with O(1) indexed lookup for high-contestant sessions.",
          "Modularized modals layer and streamlined main application layout.",
        ],
      },
    ],
  },
  {
    version: "1.4.2",
    date: "2026-08-27",
    sections: [
      {
        title: "Multi-format Custom Checker (.exe, .cpp, .py) & Auto Header Staging",
        items: [
          "Comprehensive support for Custom Checkers (.exe, .cpp, .py) inside test folders on Windows with prioritized .exe placement.",
          "Automatically stages local problem directory headers (testlib.h, Themis headers, etc.) for C++ checker compilation across Windows and macOS to prevent CE errors.",
          "On macOS: Automatically filters out incompatible Windows .exe binaries in favor of .cpp and .py source checkers.",
        ],
      },
      {
        title: "Themis Toolchain Detection & Execution Policy Polish",
        items: [
          "Accurately reports real detected compiler versions for all Themis components (GCC 9.2.0, FPC 3.2.2, Python 3.12.4, Java 1.7.0).",
          "Performs exhaustive multi-drive discovery without early termination from PATH compilers.",
          "Extends sandbox policy and safe Job Object fallback for legacy 32-bit (WOW64) Themis binaries, eliminating incompatibility rejections.",
        ],
      },
    ],
  },
  {
    version: "1.4.1",
    date: "2026-08-25",
    sections: [
      {
        title: "Themis Toolchain Auto-detection & Comparison",
        items: [
          "Automatically detects existing Themis 32-bit compilers (GCC 9.2, FPC, Python, Java) on startup and presents a side-by-side comparison modal against Managed Olympic 64-bit standards.",
          "One-click batch configuration to use Themis toolchains or customize individual languages under Toolchain Settings.",
        ],
      },
      {
        title: "Problem Configuration Modal UX Enhancements",
        items: [
          "Centered test point (POINTS), time limit, and group editing popover to prevent bottom-edge clipping and improve navigation across all display resolutions.",
        ],
      },
    ],
  },
  {
    version: "1.4.0",
    date: "2026-08-25",
    sections: [
      {
        title: "Contest Archive (.judgedesk) Interaction Fix",
        items: [
          "Fixed scoreboard state freeze/reload loop when launching JudgeDesk via double-clicking a .judgedesk archive on Windows and macOS.",
          "Fully restores contestant/problem selections, scoring details, and allows immediate judging, grading, and configuration without reset.",
          "Seamless atomic save (Ctrl+S / ⌘S) and Save As (Ctrl+Shift+S / ⌘Shift+S) directly into the active .judgedesk file.",
        ],
      },
      {
        title: "1-Click Streamlined Core In-App Updates",
        items: [
          "Single-click update experience: Clicking the update button on the toolbar automatically downloads the lightweight Core package (~20 MB) in the background without modal prompts.",
          "Preserves 100% of user toolchains, custom compilers, contest workspaces, and settings across upgrades.",
        ],
      },
      {
        title: "Cross-Platform Judge & Zero-Copy Enhancements",
        items: [
          "Dynamic Java entrypoint staging based on declared public classes, guaranteeing consistent multi-class Java judging across OS environments.",
          "Apple Silicon divide-by-zero trap alignment using Clang sanitizers, matching x86 hardware Runtime Error (0 pts) semantics.",
          "Zero-Copy runtime and toolchain deduplication: Full edition launches in <1s and automatically cleans duplicate AppData caches to free ~800 MB disk space.",
        ],
      },
    ],
  },
  {
    version: "1.3.83",
    date: "2026-08-24",
    sections: [
      {
        title: "macOS Optimizations & Native Executor",
        items: [
          "Eliminated process-tree lock hangs after multi-process submissions (forkbomb) on macOS with bounded zombie drain timeout.",
          "Added support for symbolic links in Clang++ resolution and automatic discovery for Xcode/CommandLineTools.",
          "Enhanced judging session termination stability and eliminated progress modal flashing.",
        ],
      },
    ],
  },
  {
    version: "1.3.82",
    date: "2026-08-22",
    sections: [
      {
        title: "Excel Export & Scoreboard Enhancements",
        items: [
          "Fixed empty Excel exports caused by selection mismatches: Automatic case-insensitive matching and comprehensive fallback to include all problems, scores, and totals.",
          "Guaranteed full system environment Run Metadata in all exported spreadsheets.",
        ],
      },
    ],
  },
  {
    version: "1.3.8",
    date: "2026-08-22",
    sections: [
      {
        title: "Update Experience & Release Information",
        items: [
          "Automatic 'What's New in JudgeDesk' modal displayed once immediately after upgrading to a new version.",
          "Access the complete bilingual release changelog anytime from the Help Center (F1 key).",
        ],
      },
      {
        title: "Excel Export & Run Metadata Fixes",
        items: [
          "Fixed empty scoreboard worksheets and 'Run Metadata: Unavailable' issues when exporting saved contests or after OSD evaluation.",
          "Case-insensitive matching for contestant and problem names while preserving display casing.",
          "Automatic fallback to host environment diagnostics when run metadata is not present.",
        ],
      },
      {
        title: "Contest Opening & Drag and Drop",
        items: [
          "Double-click .judgedesk archive files on Windows File Explorer or macOS Finder to directly load the contest, problems, contestants, and results.",
          "Single-instance IPC activation smoothly focuses and switches contests when the application is already open.",
          "Full-window drag & drop overlay for .judgedesk contest archives and enhanced folder drop zone cues in the directory picker.",
        ],
      },
    ],
  },
  {
    version: "1.3.7",
    date: "2026-08-21",
    sections: [
      {
        title: "Online Judging (OSD Mode)",
        items: [
          "Real-time monitoring and auto-discovery of new submissions in the OSD Shared Folder.",
          "Smart queue processing with instantaneous updates for progress, scores, and evaluation logs.",
          "Added OSD status indicator and quick configuration modal on the top toolbar.",
        ],
      },
      {
        title: "Fast In-App Updates & Early Migration",
        items: [
          "Default Core Update (~39 MB) downloads in 3-5 seconds without re-downloading unchanged toolchains.",
          "Early Cut-and-Paste Migration engine automatically moves and preserves compilers in safe per-user storage.",
        ],
      },
    ],
  },
  {
    version: "1.3.6",
    date: "2026-08-20",
    sections: [
      {
        title: "Judging Performance & Testcase Switching",
        items: [
          "Restored submission-level artifact caching in the sandbox, reusing compiled binaries across all testcases.",
          "Eliminated repeated file copying and deletion between testcases, preventing Windows Defender rescanning latency.",
          "Optimized HDD and legacy CPU performance for sub-millisecond testcase transitions.",
        ],
      },
    ],
  },
  {
    version: "1.3.5",
    date: "2026-08-19",
    sections: [
      {
        title: "Keyboard Shortcuts & Navigation",
        items: [
          "Implemented full Themis-compatible keyboard shortcuts (F1-F12, Ctrl/Cmd shortcuts).",
          "Automatic modifier adaptation for macOS (Command ⌘ and Shift+Command ⇧⌘).",
          "Full keyboard scoreboard navigation using arrow keys, Space to toggle checkboxes, and Enter to inspect test results.",
          "Escape key closes any open modal, dialog, or scoring log window.",
        ],
      },
      {
        title: "Compilers & Toolchain Stability",
        items: [
          "Removed pre-execution SHA-256 hashing to eliminate Windows Defender false positives while maintaining strict sandbox isolation.",
          "Upgraded local compiler auto-detection for MSYS2 UCRT64, MinGW64, CodeBlocks MinGW, and Themis GCC.",
        ],
      },
      {
        title: "Help Center & Documentation",
        items: [
          "Revamped Help Center with comprehensive pedagogic guidelines and bilingual search.",
          "Added shortcut cheat sheet in F1 Help and interactive tooltip keybinding hints.",
        ],
      },
    ],
  },
  {
    version: "1.3.4",
    date: "2026-08-13",
    sections: [
      {
        title: "Core & Full Updates",
        items: [
          "Updater presents dual Core and Full choices with accurate download and installed footprint sizes.",
          "Seamless in-place updates with clear toolchain impact explanations when switching editions.",
        ],
      },
      {
        title: "Project Donation",
        items: [
          "Added coffee button on the toolbar with a confirmation dialog before opening donation QR in default browser.",
        ],
      },
    ],
  },
  {
    version: "1.3.3",
    date: "2026-08-13",
    sections: [
      {
        title: "Performance & Responsiveness",
        items: [
          "Accelerated Windows Native protection startup by validating existing ACL policies.",
          "Scoreboard result indexing and memoization with throttled progress updates.",
          "Offloaded contest compression and Excel generation from the UI thread.",
        ],
      },
      {
        title: "Excel Export",
        items: [
          "Excel export available as soon as any contestant or problem is loaded.",
          "Directly opens new unsaved workbook in Microsoft Excel on Windows.",
          "Protected with 256 MiB memory safety boundary for large contests.",
        ],
      },
    ],
  },
  {
    version: "1.3.2",
    date: "2026-08-10",
    sections: [
      {
        title: "Toolchain Management",
        items: [
          "Full edition bootstraps bundled managed packages while respecting manual overrides.",
          "Background compiler discovery following standard PATH order.",
          "Added Advanced resource-only execution toggle.",
        ],
      },
      {
        title: "Problem Configuration & Help Center",
        items: [
          "Per-problem compiler configuration presets in Config.cfg (Themis Compatible, IOI/ICPC Modern, ICPC World Finals, Custom).",
          "Built-in offline bilingual Help Center with F1 shortcut.",
        ],
      },
    ],
  },
  {
    version: "1.3.0",
    date: "2026-08-01",
    sections: [
      {
        title: "Multi-Language Judging",
        items: [
          "Versioned compiler registries for C++, C, Python, Pascal, and Java.",
          "C++ and Python custom checkers run under native secure executor with strict resource contracts.",
        ],
      },
      {
        title: "Core, Full & Toolchains",
        items: [
          "Dedicated Core and Full distributions for Windows x64 and macOS Apple Silicon.",
          "Bundled GCC 14.2, Python 3.12, FPC 3.2.2, Temurin 21 on Windows Full; Python, FPC, Temurin on macOS Full.",
        ],
      },
      {
        title: "Native Protection & Single Instance",
        items: [
          "Single-instance focus management prevents duplicate backend instances.",
          "Process group and run guardian supervision on macOS.",
        ],
      },
    ],
  },
  {
    version: "1.2.7",
    date: "2026-07-27",
    sections: [
      {
        title: "Managed Python on macOS",
        items: [
          "Self-contained executor cache with canonical containment checks for Python on macOS.",
        ],
      },
      {
        title: "Reload & Test Discovery",
        items: [
          "Reload preserves active selection checkboxes and discovers newly added testcases.",
          "Validates test pairs with matching input and expected output files.",
        ],
      },
    ],
  },
  {
    version: "1.2.6",
    date: "2026-07-26",
    sections: [
      {
        title: "Public Release & Repository",
        items: [
          "Official open source release under ducminh25/judgedesk with unified documentation.",
        ],
      },
      {
        title: "macOS Python Sandbox Fix",
        items: [
          "Fixed sandbox incompatibility error when running managed Python under macOS Seatbelt.",
        ],
      },
    ],
  },
  {
    version: "1.2.5",
    date: "2026-07-24",
    sections: [
      {
        title: "Native Protection & Precision",
        items: [
          "Native secure executor with LPAC / Job Object on Windows and Seatbelt per-run sandboxing on macOS.",
          "Apple Clang integer division by zero trap for consistent RE verdicts across platforms.",
          "Fork bomb mitigation, 20-cycle boundary stress validation, and orphan process cleanup.",
        ],
      },
      {
        title: "Contest Management & Scoreboard",
        items: [
          "Portable .judgedesk contest format storing problems, source code, configs, and judge results.",
          "Comprehensive Excel workbook and diagnostic JSON exports.",
        ],
      },
    ],
  },
];

export function getChangelogForLanguage(lang: string): ChangelogRelease[] {
  return lang === "vi" ? CHANGELOG_DATA_VI : CHANGELOG_DATA_EN;
}
