# 塔羅斯 CRM

手機上的詢價與客戶追蹤工具。資料先存在這台裝置；設定雲端同步後，變更會送到 Cloudflare Worker `tonic-sync-api`，再進入 Notion。

## 雲端同步

1. 打開右上角齒輪，進入「雲端同步」。
2. 輸入 Worker 網址與 PIN。網址填服務的根網址，不要加上 `/crm/records`。PIN 只存在這台裝置的 localStorage（鍵名 `talos_crm_sync`），不會寫進這個公開程式庫，也不會放進 JSON 備份。
3. 按一次「上傳全部本機資料」。
4. 上傳成功後，案件會出現在 Notion 資料庫「客戶承諾追蹤」。之後每次新增、修改或移到回收，都會先寫入本機，再送到雲端。手機上改完，讀取這份雲端資料的機器人就會看到最新內容，包含已設定的 `deletedAt`。

還沒填網址或 PIN，或暫時連不上 Worker 時，App 仍只使用本機資料，操作方式與未接雲端時相同，不會清掉已保存的案件，也不會因連線失敗而擋住畫面。送不出去的變更會留在本機佇列（`talos_crm_outbox`），恢復連線或下次打開時再送。

狀態會顯示「未設定」、「已連線」、「無法連線」、「PIN 不正確」或「來源未被允許」。若還有送不出去的變更，會另外標示待上傳筆數。

這個網站從 GitHub Pages 打開時，瀏覽器來源是 `https://tonicwang.github.io`。Worker 預設允許這個來源。若狀態顯示「來源未被允許」，括號裡的來源就是要加進 Worker `ALLOWED_ORIGINS` 的那一條。除了 `GET /health` 之外，每個請求都會帶 `X-App-Pin`。

已取消的案件可以選階段：詢價、報價、成交、回購。只有這個狀態會把 `stage` 送給雲端。讀回來的 `updatedAt` 是 Notion 的最後編輯時間，較新的那一筆會留下來。

本機案件存在 `talos_crm_v2`。列表若沒有自己的資料就是空的，不再放入範例客戶。

## 網站

此 App 由 GitHub Pages 發布：分支 `main`、目錄 `/`（網站根目錄），沒有自訂網域（無 CNAME），並強制使用 HTTPS。

https://tonicwang.github.io/Talos-CRM-system/

## 測試

```bash
npm test
```
