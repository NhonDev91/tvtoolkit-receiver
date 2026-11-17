# TV Toolkit — Cast receiver chiếu màn hình (WebRTC)

Trang Cast Web Receiver cho tính năng chiếu màn hình của app TV Toolkit trên TV có Chromecast built-in / Google TV.
Điện thoại quay màn hình và gửi qua WebRTC trong mạng LAN, độ trễ dưới 1 giây.

URL đăng ký trong Google Cast SDK Developer Console:

```
https://nhondev91.github.io/tvtoolkit-receiver/
```

## Đăng ký trong Cast Console

1. https://cast.google.com/publish → **Add New Application** → **Custom Receiver**.
2. **Receiver Application URL**: URL ở trên. Lưu lại, ghi lấy **Application ID** (8 ký tự) để đưa vào app.
3. Ứng dụng chưa **Publish** chỉ chạy trên thiết bị đã đăng ký: **Add New Device**, nhập số serial của TV
   (Google TV: Cài đặt → Hệ thống → Giới thiệu). Sau khi đăng ký, khởi động lại TV và chờ khoảng 15 phút.
   Publish ứng dụng thì mọi TV đều chạy được.

## Giao thức

Namespace `urn:x-cast:com.foxcode.tvtoolkit.mirror`, mỗi tin là một JSON có trường `type`.

| Chiều | `type` | Trường | Ý nghĩa |
|---|---|---|---|
| Điện thoại → TV | `HELLO` | | Hỏi trang đã sẵn sàng chưa |
| Điện thoại → TV | `OFFER` | `sdp` | Offer WebRTC (điện thoại là bên gửi hình) |
| Điện thoại → TV | `ICE` | `candidate`, `sdpMid`, `sdpMLineIndex` | ICE candidate |
| Điện thoại → TV | `STOP` | | Dừng chiếu, TV về màn chờ |
| TV → điện thoại | `READY` | `version` | Trả lời `HELLO`; cũng gửi khi điện thoại vừa kết nối |
| TV → điện thoại | `ANSWER` | `sdp` | Answer WebRTC |
| TV → điện thoại | `ICE` | `candidate`, `sdpMid`, `sdpMLineIndex` | ICE candidate |
| TV → điện thoại | `STATE` | `state` | `connectionState` của TV: `connecting`, `connected`, `disconnected`, `failed` |
| TV → điện thoại | `ERROR` | `message` | Không xử lý được offer |

Luồng: `LAUNCH` app ID → `CONNECT` tới `transportId` của app → `HELLO` → `READY` → `OFFER` → `ANSWER` và `ICE`
hai chiều → `STATE: connected`. Điện thoại ngắt kết nối thì trang đóng phiên WebRTC; không còn điện thoại nào thì
app receiver tự đóng.

Ghi chú cho phía điện thoại:
- Không dùng STUN/TURN (`iceServers` rỗng): điện thoại và TV cùng mạng LAN.
- Track video `sendonly`, nên ưu tiên H.264 (TV giải mã bằng phần cứng). Âm thanh tuỳ chọn (Opus).
- Trang đặt `jitterBufferTarget = 0` / `playoutDelayHint = 0` để trễ thấp nhất.

## Vì sao WebRTC

Trang receiver chạy qua HTTPS nên không đọc được dữ liệu `http://` từ điện thoại trong LAN (mixed content); chỉ
thẻ `<video src>` được phép, buộc phải dùng HLS và trễ vài giây. Luồng media của WebRTC không bị luật đó chặn.

Trang bật `skipPlayersLoad`: không tải trình phát media của Google (Shaka từ ajax.googleapis.com), phần mà một số TV
tải rất chậm hoặc không tải được.

## Thử không cần TV

Mở `test/harness.html` (cần chạy qua HTTP, ví dụ `python3 -m http.server`): trang đóng vai điện thoại, gửi một
"màn hình" canvas tới trang receiver trong khung bằng đúng các tin ở trên. Thêm `?debug` vào URL receiver để xem độ
phân giải, fps, bitrate và jitter buffer.
