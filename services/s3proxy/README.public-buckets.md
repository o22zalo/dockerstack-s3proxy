# Public Link vĩnh viễn cho bucket private (S3Proxy)

Tài liệu này mô tả luồng mới:
- Backend bucket vẫn để **private**.
- Proxy sinh **public URL vĩnh viễn** dạng `/public/:token` cho object thuộc logical bucket đã bật cấu hình public.
- Người dùng tải file qua public URL mà không cần `x-api-key`.

> Mục tiêu: không cần đổi policy bucket backend sang public-read, tránh ảnh hưởng dữ liệu khác.

---

## 1) Cách hoạt động

### Bước A: Đánh dấu logical bucket là public trong proxy
API:
- `POST /admin/api/public-buckets`

```json
{
  "bucket": "images",
  "enabled": true
}
```

### Bước B: Upload object như bình thường
Upload:
- `PUT /images/avatar.png`

Khi bucket `images` được bật public trong proxy, response upload sẽ có thêm:
- `Location: https://<proxy-host>/public/<token>`
- `x-s3proxy-direct-url: https://<proxy-host>/public/<token>`
- `x-s3proxy-public-url: https://<proxy-host>/public/<token>`

`token` được lưu map với object metadata, tái sử dụng khi object bị overwrite cùng key (link không đổi theo logical key).

### Bước C: Truy cập public URL
Client chỉ cần gọi:
- `GET /public/<token>`

Proxy tự dùng backend credential nội bộ để đọc object private từ S3 rồi trả lại payload.

---

## 2) Luồng này có cần đổi cấu hình bucket S3 sang public không?

**Không cần.**

Bạn có thể giữ bucket backend private hoàn toàn.
Public URL được "public" ở tầng proxy route `/public/:token`, không phải do backend mở quyền công khai.

---

## 3) So với logic cũ khác gì?

### Logic cũ
- Nếu muốn direct backend link tải được thì phải mở quyền ở backend bucket/object.
- Rủi ro ảnh hưởng dữ liệu khác nếu vô tình mở policy rộng.

### Logic mới (khuyến nghị cho yêu cầu của bạn)
- Backend bucket vẫn private.
- Chỉ object thuộc logical bucket được bật `public-buckets` mới có link `/public/:token`.
- Không đụng policy public-read của backend.

---

## 4) Lưu ý bảo mật

- Link `/public/:token` là link công khai, ai có link có thể tải file.
- Nếu cần thu hồi:
  - xoá object backend, hoặc
  - đổi key object (upload key mới), hoặc
  - tắt cấu hình public bucket.
- Nên dùng key/token khó đoán và chỉ bật cho bucket chia sẻ công khai.

---

## 5) API liên quan

- `GET /admin/api/public-buckets`
- `POST /admin/api/public-buckets`
- `DELETE /admin/api/public-buckets/:bucket`
- `GET /public/:token` (không cần auth)
