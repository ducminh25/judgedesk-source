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
