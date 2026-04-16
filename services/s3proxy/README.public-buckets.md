# Public Bucket Direct Link Flow (S3Proxy)

Tài liệu này mô tả luồng **public bucket** vừa thêm trong S3Proxy:
- Cấu hình một logical bucket là "public bucket" ở proxy.
- Khi upload object vào logical bucket đó, proxy trả thêm direct link backend S3 qua header.
- Client có thể dùng direct link để GET file trực tiếp từ S3 backend (không đi qua proxy), **nếu backend cho phép**.

> Quan trọng: Cờ `public bucket` trong S3Proxy **không tự biến bucket backend thành public**.

---

## 1) Luồng hoạt động

### Bước 1: Đánh dấu logical bucket là public ở proxy
Gọi API:
- `POST /admin/api/public-buckets`
- Body ví dụ:

```json
{
  "bucket": "images",
  "enabled": true
}
```

Proxy lưu config vào bảng `public_buckets` trong SQLite.

### Bước 2: Upload object như bình thường
Upload:
- `PUT /images/avatar.png`

Nếu bucket `images` đã bật `public`, response upload sẽ có thêm:
- `Location: <direct-backend-url>`
- `x-s3proxy-direct-url: <direct-backend-url>`
- `x-s3proxy-direct-enabled: true`

### Bước 3: Dùng direct link để đọc file trực tiếp
Client dùng URL trong `x-s3proxy-direct-url` để gọi GET trực tiếp backend S3.

---

## 2) Backend S3 cần cấu hình gì không?

**Có.** Để direct link truy cập được không cần proxy, backend phải cho phép đọc object bằng HTTP(S) direct.

Tuỳ nhà cung cấp S3-compatible:

- AWS S3:
  - Cần Bucket Policy/ACL cho phép `s3:GetObject` (public) cho prefix/object tương ứng; hoặc
  - Dùng cơ chế signed URL (nếu bạn không muốn public thật).

- Supabase Storage S3 endpoint:
  - Cần bucket/object có quyền public read (theo policy của project), hoặc
  - Có một cơ chế URL ký/hạn dùng do Supabase cấp.

Nếu backend vẫn private hoàn toàn, direct URL sẽ trả `403/401` (hoặc tương tự).

---

## 3) Khác gì so với logic bình thường?

### Logic bình thường (không bật public bucket ở proxy)
- Upload qua proxy.
- App thường truy cập lại qua proxy URL.
- Quyền đọc/ghi được kiểm soát qua proxy auth + backend credentials của account.

### Logic khi bật public bucket ở proxy
- Upload vẫn qua proxy như cũ.
- Khác biệt: proxy trả thêm direct URL backend để client có thể gọi thẳng backend.
- Proxy **không cấp thêm quyền** cho object; nó chỉ "tiết lộ URL trực tiếp".

---

## 4) Trả lời hiểu nhầm phổ biến

> "Bucket vẫn private nhưng tôi bật public bucket ở proxy thì có ra link public vô thời hạn không?"

**Không tự động.**

- Bật `public bucket` ở S3Proxy chỉ làm proxy trả direct URL.
- URL đó có truy cập được công khai hay không phụ thuộc hoàn toàn vào policy/quyền của backend bucket/object.
- Nếu backend private, link direct thường không đọc được (403/401).
- Nếu backend public-read và URL ổn định, link có thể dùng lâu dài (gần như vô thời hạn) cho đến khi object bị xoá/đổi policy/đổi endpoint.

---

## 5) API liên quan

### Danh sách public buckets
`GET /admin/api/public-buckets`

### Upsert public bucket
`POST /admin/api/public-buckets`

```json
{
  "bucket": "images",
  "enabled": true
}
```

### Xoá public bucket
`DELETE /admin/api/public-buckets/:bucket`

---

## 6) Khuyến nghị vận hành

- Chỉ bật `public bucket` cho bucket phục vụ static asset/download công khai.
- Nếu dữ liệu nhạy cảm, giữ bucket backend private và dùng signed URL có hạn.
- Nên kết hợp lifecycle/object versioning/CDN cache policy để kiểm soát chi phí.
