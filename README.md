# LINE Bot 音檔轉逐字稿

一個部署在 Zeabur 上的 LINE Bot，可以將音檔轉換成逐字稿。

## 功能特色

- 支援音檔上傳並自動轉換成逐字稿
- 使用 OpenAI Whisper API 進行語音識別
- 支援中文語音識別
- 自動清理臨時檔案

## 部署前準備

1. 建立 LINE Bot 頻道
2. 取得 OpenAI API Key
3. 配置環境變數

## 環境變數設定

複製 `.env.example` 為 `.env` 並填入以下資訊：

```
LINE_CHANNEL_ACCESS_TOKEN=your_line_channel_access_token
LINE_CHANNEL_SECRET=your_line_channel_secret
OPENAI_API_KEY=your_openai_api_key
PORT=3000
```

## 本地開發

```bash
npm install
npm run dev
```

## 部署到 Zeabur

1. 將程式碼推送到 GitHub
2. 連接 Zeabur 與 GitHub 儲存庫
3. 配置環境變數
4. 部署服務

## 使用說明

1. 加入 LINE Bot 好友
2. 傳送音檔給 Bot
3. 等待轉換完成
4. 接收逐字稿結果