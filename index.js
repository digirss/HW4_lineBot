const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;

// LINE Bot configuration
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// Ensure temp directory exists
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Audio transcription using OpenAI Whisper API
async function transcribeAudio(audioPath) {
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioPath));
    formData.append('model', 'whisper-1');
    formData.append('language', 'zh');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    return response.data.text;
  } catch (error) {
    console.error('Transcription error:', error);
    throw error;
  }
}

// Download audio file from LINE
async function downloadAudioFile(messageId) {
  try {
    const response = await axios({
      method: 'GET',
      url: `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      headers: {
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      responseType: 'stream',
    });

    const fileName = `${messageId}.m4a`;
    const filePath = path.join(tempDir, fileName);
    
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Download error:', error);
    throw error;
  }
}

// Clean up temporary files
function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Handle LINE webhook events
async function handleEvent(event) {
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }

  const { message, replyToken } = event;

  try {
    if (message.type === 'audio') {
      // Send processing message
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '正在處理音檔，請稍候...'
      });

      // Download and transcribe audio
      const audioPath = await downloadAudioFile(message.id);
      const transcription = await transcribeAudio(audioPath);
      
      // Clean up temporary file
      cleanupFile(audioPath);

      // Send transcription result
      await client.pushMessage(event.source.userId, {
        type: 'text',
        text: `📝 逐字稿結果：\n\n${transcription}`
      });

    } else if (message.type === 'text') {
      const text = message.text.toLowerCase();
      
      if (text === '說明' || text === 'help') {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: '📋 使用說明：\n\n1. 傳送音檔給我\n2. 我會自動轉換成逐字稿\n3. 支援中文語音識別\n\n請直接傳送音檔即可開始！'
        });
      } else {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: '請傳送音檔給我，我會幫您轉換成逐字稿！\n\n輸入「說明」查看使用方法。'
        });
      }
    }
  } catch (error) {
    console.error('Event handling error:', error);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '抱歉，處理過程中發生錯誤，請稍後再試。'
    });
  }
}

// Simple webhook endpoint for testing
app.post('/webhook', (req, res) => {
  console.log('Webhook request received');
  res.status(200).json({ message: 'OK' });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('LINE Bot Transcription Service is running!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});