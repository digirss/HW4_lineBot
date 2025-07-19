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
        text: '📸 圖片已暫存！\n請使用指令來保存靈感\n\n例如：設計草圖的想法 /s\n\n🔹 /t 查看暫存\n🔹 /dr 丟棄暫存'
      });

    } else if (message.type === 'text') {
      const text = message.text.trim();
      
      // Parse command and content using new logic (command at end)
      const parseResult = parseTextCommand(text);
      
      if (parseResult.command) {
        // Handle commands
        switch (parseResult.command) {
          case '/s':
            await handleSaveCommand(parseResult.content, parseResult.tags, userId, replyToken);
            break;
          case '/l':
            await handleListCommand(parseResult.params, userId, replyToken);
            break;
          case '/e':
            await handleEditCommand(parseResult.content, parseResult.params, userId, replyToken);
            break;
          case '/d':
            await handleDeleteCommand(parseResult.params, userId, replyToken);
            break;
          case '/t':
            await handleTempCommand(userId, replyToken);
            break;
          case '/dr':
            await handleDropCommand(userId, replyToken);
            break;
          case '/p':
            await handleProfileCommand(userId, replyToken);
            break;
          default:
            await client.replyMessage(replyToken, {
              type: 'text',
              text: '❌ 未知指令\n\n輸入「說明」查看完整功能'
            });
        }
      } else if (parseResult.autoSave) {
        // Auto-save when tags are detected
        await handleSaveCommand(parseResult.content, parseResult.tags, userId, replyToken);
      } else if (text === '說明' || text === 'help') {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: '🤖 多功能 LINE Bot\n\n📝 語音轉文字：\n• 傳送音檔自動轉逐字稿\n\n💡 靈感記錄：\n• 內容 #標籤 /s - 保存靈感\n• 內容 #標籤 - 自動保存（有標籤時）\n• 內容 /s - 保存無標籤靈感\n• /l - 查看最近靈感\n• #標籤 /l - 查看特定標籤\n• 編號 新內容 /e - 編輯靈感\n• 編號 /d - 刪除靈感\n• /p - 個人資料\n\n📸 圖片支援：\n• 先傳圖片，再用指令保存\n• /t - 查看暫存圖片\n• /dr - 丟棄暫存圖片'
        });
      } else {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: '👋 歡迎使用多功能 Bot！\n\n🎵 傳送音檔：轉換成逐字稿\n💡 內容 #標籤：記錄靈感\n📋 輸入「說明」查看完整功能'
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

// Parse text command with new logic (command at end)
function parseTextCommand(text) {
  const commands = ['/s', '/l', '/e', '/d', '/t', '/dr', '/p'];
  let command = null;
  let content = text;
  let params = '';
  
  // Check if text ends with a command
  for (const cmd of commands) {
    if (text.endsWith(' ' + cmd)) {
      command = cmd;
      content = text.slice(0, -(cmd.length + 1)).trim();
      break;
    } else if (text === cmd) {
      command = cmd;
      content = '';
      break;
    }
  }
  
  // Parse tags from content
  const tagRegex = /#(\S+)/g;
  const tags = [];
  let match;
  
  while ((match = tagRegex.exec(content)) !== null) {
    tags.push(match[1]);
  }
  
  // Remove tags from content
  const cleanContent = content.replace(tagRegex, '').trim();
  
  // For list command, check if content has tags (used as filter)
  if (command === '/l' && tags.length > 0) {
    params = tags[0]; // Use first tag as filter
  }
  
  // For edit/delete commands, extract ID from beginning
  if (command === '/e' || command === '/d') {
    const parts = cleanContent.split(' ');
    if (parts.length > 0 && /^\d+$/.test(parts[0])) {
      params = parts[0].padStart(3, '0'); // Convert to 001 format
      if (command === '/e') {
        content = parts.slice(1).join(' '); // Rest is new content for edit
      }
    }
  }
  
  // Determine if auto-save (has tags but no command)
  const autoSave = !command && tags.length > 0;
  
  return {
    command,
    content: cleanContent,
    tags,
    params,
    autoSave
  };
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

// Handle save command (new format)
async function handleSaveCommand(content, tags, userId, replyToken) {
  try {
    if (!content) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '❌ 請輸入要保存的靈感內容\n\n例如：今天想到的好點子 /s'
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

    // Combine content with tags for inspiration manager
    const fullContent = tags.length > 0 ? `${content} ${tags.map(tag => `#${tag}`).join(' ')}` : content;
    const result = await inspirationManager.saveInspiration(fullContent, userId, imageInfo);

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

// Handle list command (new format)
async function handleListCommand(params, userId, replyToken) {
  try {
    let tag = null;
    
    if (params) {
      tag = params; // params already contains the tag name without #
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

// Handle edit command (new format)
async function handleEditCommand(content, params, userId, replyToken) {
  try {
    if (!params || !content) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '❌ 格式錯誤\n\n正確格式：編號 新內容 /e\n例如：001 修改後的想法 /e'
      });
      return;
    }

    const id = params; // Already formatted as 001
    const newContent = content;

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

// Handle delete command (new format)
async function handleDeleteCommand(params, userId, replyToken) {
  try {
    if (!params) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '❌ 格式錯誤\n\n正確格式：編號 /d\n例如：001 /d'
      });
      return;
    }

    const id = params; // Already formatted as 001

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