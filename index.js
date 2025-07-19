const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Import inspiration modules
const InspirationManager = require('./inspiration');

const app = express();
// Don't parse JSON globally - let LINE middleware handle it
const PORT = process.env.PORT || process.env.WEB_PORT || 8080;

// LINE Bot configuration
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// Debug: Check environment variables
console.log('Channel Access Token length:', config.channelAccessToken ? config.channelAccessToken.length : 'undefined');
console.log('Channel Secret length:', config.channelSecret ? config.channelSecret.length : 'undefined');

const client = new line.Client(config);

// Initialize inspiration manager
const inspirationManager = new InspirationManager();

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
  console.log('Handling event:', JSON.stringify(event));
  
  if (event.type !== 'message') {
    console.log('Not a message event, skipping');
    return Promise.resolve(null);
  }

  const { message, replyToken } = event;
  const userId = event.source.userId;
  console.log('Message type:', message.type);

  try {
    if (message.type === 'audio') {
      console.log('Audio message received, processing...');
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
      await client.pushMessage(userId, {
        type: 'text',
        text: `📝 逐字稿結果：\n\n${transcription}`
      });

    } else if (message.type === 'image') {
      // Handle image upload for inspiration
      console.log('Image message received');
      
      // Download image
      const imagePath = await downloadImageFile(message.id);
      const fileName = `inspiration_${Date.now()}.jpg`;
      
      // Store in temp for user
      inspirationManager.setTempImage(userId, imagePath, fileName);
      
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '📸 圖片已暫存！\n請使用 /save 指令來保存靈感\n\n例如：/save 設計草圖的想法\n\n🔹 /temp 查看暫存\n🔹 /drop 丟棄暫存'
      });

    } else if (message.type === 'text') {
      const text = message.text.trim();
      
      // Handle inspiration commands
      if (text.startsWith('/save')) {
        await handleSaveCommand(text, userId, replyToken);
      } else if (text.startsWith('/list')) {
        await handleListCommand(text, userId, replyToken);
      } else if (text.startsWith('/edit')) {
        await handleEditCommand(text, userId, replyToken);
      } else if (text.startsWith('/delete')) {
        await handleDeleteCommand(text, userId, replyToken);
      } else if (text.startsWith('/temp')) {
        await handleTempCommand(userId, replyToken);
      } else if (text.startsWith('/drop')) {
        await handleDropCommand(userId, replyToken);
      } else if (text.startsWith('/profile')) {
        await handleProfileCommand(userId, replyToken);
      } else if (text === '說明' || text === 'help') {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: '🤖 多功能 LINE Bot\n\n📝 語音轉文字：\n• 傳送音檔自動轉逐字稿\n\n💡 靈感記錄：\n• /save 內容 - 保存靈感\n• /save #標籤 內容 - 帶標籤保存\n• /list - 查看最近靈感\n• /list #標籤 - 查看特定標籤\n• /edit #編號 - 編輯靈感\n• /delete #編號 - 刪除靈感\n• /profile - 個人資料\n\n📸 圖片支援：\n• 先傳圖片，再用 /save 保存\n• /temp - 查看暫存圖片\n• /drop - 丟棄暫存圖片'
        });
      } else {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: '👋 歡迎使用多功能 Bot！\n\n🎵 傳送音檔：轉換成逐字稿\n💡 /save：記錄靈感\n📋 輸入「說明」查看完整功能'
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

// Download image file from LINE
async function downloadImageFile(messageId) {
  try {
    const response = await axios({
      method: 'GET',
      url: `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      headers: {
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      responseType: 'stream',
    });

    const fileName = `${messageId}.jpg`;
    const filePath = path.join(tempDir, fileName);
    
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Image download error:', error);
    throw error;
  }
}

// Handle /save command
async function handleSaveCommand(text, userId, replyToken) {
  try {
    const content = text.replace('/save', '').trim();
    
    if (!content) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '❌ 請輸入要保存的靈感內容\n\n例如：/save 今天想到的好點子'
      });
      return;
    }

    // Check for temp image
    const tempImage = inspirationManager.getTempImage(userId);
    let imageInfo = null;

    if (tempImage) {
      // Upload image to Google Drive
      try {
        imageInfo = await inspirationManager.driveManager.uploadImage(
          tempImage.path, 
          userId, 
          tempImage.fileName
        );
        // Clear temp image after successful upload
        inspirationManager.clearTempImage(userId);
        // Clean up local temp file
        cleanupFile(tempImage.path);
      } catch (error) {
        console.error('Image upload error:', error);
        // Continue without image if upload fails
      }
    }

    const result = await inspirationManager.saveInspiration(content, userId, imageInfo);

    if (result.needsAuth) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '🔑 首次使用需要授權 Google Drive\n\n請點擊以下連結完成授權：\n' + result.authUrl
      });
    } else if (result.success) {
      const inspiration = result.inspiration;
      const tagsText = inspiration.tags.length > 0 ? inspiration.tags.map(tag => `#${tag}`).join(' ') : '無';
      const imageText = inspiration.image ? '\n🖼️ 包含圖片' : '';
      
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `✅ 靈感已保存！\n📝 內容：${inspiration.content}\n🏷️ 標籤：${tagsText}\n🔢 編號：#${inspiration.id}${imageText}`
      });
    } else {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `❌ 保存失敗：${result.error}`
      });
    }
  } catch (error) {
    console.error('Save command error:', error);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '❌ 保存過程中發生錯誤'
    });
  }
}

// Handle /list command
async function handleListCommand(text, userId, replyToken) {
  try {
    const params = text.replace('/list', '').trim();
    let tag = null;
    
    if (params.startsWith('#')) {
      tag = params.substring(1);
    }

    const result = await inspirationManager.listInspirations(userId, tag, 10);

    if (result.needsAuth) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '🔑 需要授權 Google Drive\n\n請點擊以下連結完成授權：\n' + result.authUrl
      });
    } else if (result.success) {
      if (result.inspirations.length === 0) {
        const message = tag ? `沒有找到標籤 #${tag} 的靈感記錄` : '尚未有任何靈感記錄';
        await client.replyMessage(replyToken, {
          type: 'text',
          text: `📝 ${message}\n\n使用 /save 開始記錄第一個靈感！`
        });
      } else {
        const title = tag ? `#${tag} 相關靈感` : '最近靈感';
        let message = `📝 ${title} (共${result.total}筆)：\n\n`;
        
        result.inspirations.forEach(item => {
          const tagsText = item.tags.length > 0 ? ' ' + item.tags.map(tag => `#${tag}`).join(' ') : '';
          const imageIcon = item.image ? '🖼️' : '';
          const timeText = inspirationManager.formatTime(item.timestamp);
          message += `#${item.id} ${item.content}${tagsText} ${imageIcon}\n📅 ${timeText}\n\n`;
        });

        await client.replyMessage(replyToken, {
          type: 'text',
          text: message.trim()
        });
      }
    } else {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `❌ 查詢失敗：${result.error}`
      });
    }
  } catch (error) {
    console.error('List command error:', error);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '❌ 查詢過程中發生錯誤'
    });
  }
}

// Handle /edit command
async function handleEditCommand(text, userId, replyToken) {
  try {
    const match = text.match(/^\/edit\s+#?(\d+)\s+(.+)$/);
    
    if (!match) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '❌ 格式錯誤\n\n正確格式：/edit #編號 新內容\n例如：/edit #001 修改後的想法'
      });
      return;
    }

    const id = match[1].padStart(3, '0');
    const newContent = match[2];

    const result = await inspirationManager.editInspiration(id, newContent, userId);

    if (result.needsAuth) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '🔑 需要授權 Google Drive\n\n請點擊以下連結完成授權：\n' + result.authUrl
      });
    } else if (result.success) {
      const inspiration = result.inspiration;
      const tagsText = inspiration.tags.length > 0 ? inspiration.tags.map(tag => `#${tag}`).join(' ') : '無';
      
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `✅ 靈感已更新！\n📝 新內容：${inspiration.content}\n🏷️ 標籤：${tagsText}\n🔢 編號：#${inspiration.id}`
      });
    } else {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `❌ 編輯失敗：${result.error}`
      });
    }
  } catch (error) {
    console.error('Edit command error:', error);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '❌ 編輯過程中發生錯誤'
    });
  }
}

// Handle /delete command
async function handleDeleteCommand(text, userId, replyToken) {
  try {
    const match = text.match(/^\/delete\s+#?(\d+)$/);
    
    if (!match) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '❌ 格式錯誤\n\n正確格式：/delete #編號\n例如：/delete #001'
      });
      return;
    }

    const id = match[1].padStart(3, '0');

    const result = await inspirationManager.deleteInspiration(id, userId);

    if (result.needsAuth) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '🔑 需要授權 Google Drive\n\n請點擊以下連結完成授權：\n' + result.authUrl
      });
    } else if (result.success) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `✅ 已刪除靈感 #${result.deletedInspiration.id}\n📝 內容：${result.deletedInspiration.content}`
      });
    } else {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `❌ 刪除失敗：${result.error}`
      });
    }
  } catch (error) {
    console.error('Delete command error:', error);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '❌ 刪除過程中發生錯誤'
    });
  }
}

// Handle /temp command
async function handleTempCommand(userId, replyToken) {
  try {
    const tempImage = inspirationManager.getTempImage(userId);
    
    if (!tempImage) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '📸 目前沒有暫存圖片\n\n傳送圖片後會自動暫存 10 分鐘'
      });
    } else {
      const timeAgo = Math.floor((Date.now() - tempImage.timestamp) / 1000 / 60);
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `📸 暫存圖片：${tempImage.fileName}\n⏰ ${timeAgo} 分鐘前\n\n🔹 /save 保存靈感\n🔹 /drop 丟棄暫存`
      });
    }
  } catch (error) {
    console.error('Temp command error:', error);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '❌ 查詢暫存時發生錯誤'
    });
  }
}

// Handle /drop command
async function handleDropCommand(userId, replyToken) {
  try {
    const tempImage = inspirationManager.getTempImage(userId);
    
    if (!tempImage) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '📸 目前沒有暫存圖片'
      });
    } else {
      // Clean up temp file
      cleanupFile(tempImage.path);
      inspirationManager.clearTempImage(userId);
      
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '🗑️ 已丟棄暫存圖片\n\n可以重新傳送正確的圖片'
      });
    }
  } catch (error) {
    console.error('Drop command error:', error);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '❌ 丟棄暫存時發生錯誤'
    });
  }
}

// Handle /profile command
async function handleProfileCommand(userId, replyToken) {
  try {
    const result = await inspirationManager.getUserProfile(userId);

    if (result.needsAuth) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '🔑 需要授權 Google Drive\n\n請點擊以下連結完成授權：\n' + result.authUrl
      });
    } else if (result.success) {
      const profile = result.profile;
      const regDate = profile.registrationTime ? 
        new Date(profile.registrationTime).toLocaleDateString('zh-TW') : '未知';
      
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `👤 個人資料\n\n📱 LINE ID：${profile.userId}\n📊 總靈感數：${profile.totalInspirations} 筆\n🏷️ 標籤數量：${profile.totalTags} 個\n🖼️ 圖片數量：${profile.totalImages} 張\n📅 註冊時間：${regDate}\n📁 Google Drive：已連結 ✅`
      });
    } else {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `❌ 查詢失敗：${result.error}`
      });
    }
  } catch (error) {
    console.error('Profile command error:', error);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '❌ 查詢個人資料時發生錯誤'
    });
  }
}

// Add custom middleware to debug signature validation
app.post('/webhook', (req, res, next) => {
  console.log('Request headers:', req.headers);
  console.log('Raw body type:', typeof req.body);
  next();
}, line.middleware(config), (req, res) => {
  console.log('Webhook request received:', req.body);
  
  // Handle webhook verification or empty events
  if (!req.body.events || req.body.events.length === 0) {
    console.log('Webhook verification request or empty events');
    return res.status(200).json({ message: 'OK' });
  }
  
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => {
      console.log('Webhook processed successfully');
      res.status(200).json(result);
    })
    .catch((err) => {
      console.error('Webhook error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
});

// OAuth callback endpoint
app.get('/oauth/callback', async (req, res) => {
  try {
    const code = req.query.code;
    const state = req.query.state; // This is the userId
    
    if (!code || !state) {
      return res.status(400).send('Missing authorization code or state');
    }

    // Handle OAuth callback
    const success = await inspirationManager.handleOAuthCallback(code, state);
    
    if (success) {
      res.send(`
        <html>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h2>✅ 授權成功！</h2>
            <p>Google Drive 已成功連結</p>
            <p>請回到 LINE Bot 繼續使用靈感記錄功能</p>
            <script>
              setTimeout(() => {
                window.close();
              }, 3000);
            </script>
          </body>
        </html>
      `);
    } else {
      res.status(400).send(`
        <html>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h2>❌ 授權失敗</h2>
            <p>請重新嘗試授權流程</p>
          </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send('Internal server error');
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('LINE Bot Transcription and Inspiration Service is running!');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment PORT: ${process.env.PORT}`);
  console.log(`Environment WEB_PORT: ${process.env.WEB_PORT}`);
});