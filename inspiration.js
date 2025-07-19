const GoogleDriveManager = require('./googleDrive');

class InspirationManager {
  constructor() {
    this.driveManager = new GoogleDriveManager();
    this.tempImages = new Map(); // 暫存用戶上傳的圖片
    this.tempInputs = new Map(); // 暫存用戶 OAuth 期間的輸入
  }

  // 解析標籤
  parseTags(content) {
    const tagRegex = /#(\S+)/g;
    const tags = [];
    let match;
    
    while ((match = tagRegex.exec(content)) !== null) {
      tags.push(match[1]);
    }
    
    // 移除內容中的標籤
    const cleanContent = content.replace(tagRegex, '').trim();
    
    return { tags, cleanContent };
  }

  // 生成新的靈感 ID (每日重置)
  generateId(existingInspirations) {
    if (!existingInspirations || existingInspirations.length === 0) {
      return '001';
    }
    
    const maxId = existingInspirations.reduce((max, item) => {
      const numId = parseInt(item.id);
      return numId > max ? numId : max;
    }, 0);
    
    return String(maxId + 1).padStart(3, '0');
  }

  // 檢查是否需要歸檔昨天的記錄
  async checkAndArchiveIfNeeded(userId) {
    try {
      const today = new Date().toISOString().split('T')[0]; // "2025-07-19"
      const inspirations = await this.driveManager.getInspirationsFile(userId);
      
      if (inspirations.length === 0) {
        return; // 沒有記錄，不需要歸檔
      }
      
      // 檢查最新記錄的日期
      const latestInspiration = inspirations[inspirations.length - 1];
      const latestDate = latestInspiration.timestamp.split('T')[0];
      
      if (latestDate < today) {
        // 需要歸檔昨天的記錄
        console.log(`Archiving inspirations from ${latestDate}`);
        await this.archiveInspirations(userId, inspirations, latestDate);
      }
    } catch (error) {
      console.error('Error checking archive:', error);
    }
  }

  // 歸檔昨天的記錄為 Markdown 格式
  async archiveInspirations(userId, inspirations, date) {
    try {
      // 生成 Markdown 內容
      const markdown = this.generateMarkdown(inspirations, date);
      
      // 保存為 .md 檔案
      const fileName = `inspirations_${date}.md`;
      await this.driveManager.saveArchiveFile(markdown, fileName, userId);
      
      // 清空當前 inspirations.json
      await this.driveManager.saveInspirationsFile([], userId);
      
      console.log(`Archived ${inspirations.length} inspirations to ${fileName}`);
    } catch (error) {
      console.error('Error archiving inspirations:', error);
    }
  }

  // 生成 Markdown 格式
  generateMarkdown(inspirations, date) {
    let markdown = `# 靈感記錄 - ${date}\n\n`;
    
    inspirations.forEach(item => {
      const time = new Date(item.timestamp).toLocaleTimeString('zh-TW', { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      
      const tagsText = item.tags && item.tags.length > 0 
        ? item.tags.map(tag => `#${tag}`).join(', ')
        : '無';
      
      const imageText = item.image ? '有' : '無';
      
      markdown += `## #${item.id} ${item.content}\n`;
      markdown += `- 標籤: ${tagsText}\n`;
      markdown += `- 時間: ${time}\n`;
      markdown += `- 圖片: ${imageText}\n\n`;
    });
    
    return markdown;
  }

  // 保存靈感
  async saveInspiration(content, userId, imageInfo = null, skipAuthCheck = false) {
    try {
      // 檢查用戶是否已授權（除非跳過檢查）
      if (!skipAuthCheck && !this.driveManager.isUserAuthorized(userId)) {
        // 暫存用戶輸入
        const { tags, cleanContent } = this.parseTags(content);
        this.setTempInput(userId, cleanContent, tags, imageInfo);
        
        return {
          success: false,
          needsAuth: true,
          authUrl: this.driveManager.getAuthUrl(userId)
        };
      }

      // 檢查是否需要歸檔昨天的記錄
      await this.checkAndArchiveIfNeeded(userId);

      // 解析標籤
      const { tags, cleanContent } = this.parseTags(content);
      
      // 獲取現有靈感（歸檔後可能已清空）
      const existingInspirations = await this.driveManager.getInspirationsFile(userId);
      console.log(`Current inspirations count: ${existingInspirations.length}`);
      console.log(`Existing inspirations:`, existingInspirations.map(item => ({ id: item.id, content: item.content })));
      
      // 生成新 ID
      const newId = this.generateId(existingInspirations);
      console.log(`Generated new ID: ${newId}`);
      
      // 創建新靈感記錄
      const newInspiration = {
        id: newId,
        content: cleanContent,
        tags: tags,
        timestamp: new Date().toISOString(),
        image: imageInfo ? imageInfo.path : null
      };
      
      // 添加到現有記錄
      existingInspirations.push(newInspiration);
      console.log(`Total inspirations after push: ${existingInspirations.length}`);
      
      // 保存到 Google Drive
      await this.driveManager.saveInspirationsFile(existingInspirations, userId);
      console.log(`Saved to Google Drive successfully`);
      
      return {
        success: true,
        inspiration: newInspiration
      };
      
    } catch (error) {
      console.error('Save inspiration error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 列出靈感
  async listInspirations(userId, tag = null, limit = 10) {
    try {
      if (!this.driveManager.isUserAuthorized(userId)) {
        return {
          success: false,
          needsAuth: true,
          authUrl: this.driveManager.getAuthUrl(userId)
        };
      }

      const inspirations = await this.driveManager.getInspirationsFile(userId);
      
      // 篩選標籤
      let filteredInspirations = inspirations;
      if (tag) {
        filteredInspirations = inspirations.filter(item => 
          item.tags && item.tags.includes(tag)
        );
      }
      
      // 按時間排序（最新的在前）
      filteredInspirations.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      // 限制數量
      const limitedInspirations = filteredInspirations.slice(0, limit);
      
      return {
        success: true,
        inspirations: limitedInspirations,
        total: filteredInspirations.length
      };
      
    } catch (error) {
      console.error('List inspirations error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 編輯靈感
  async editInspiration(id, newContent, userId) {
    try {
      if (!this.driveManager.isUserAuthorized(userId)) {
        return {
          success: false,
          needsAuth: true,
          authUrl: this.driveManager.getAuthUrl(userId)
        };
      }

      const inspirations = await this.driveManager.getInspirationsFile(userId);
      const inspirationIndex = inspirations.findIndex(item => item.id === id);
      
      if (inspirationIndex === -1) {
        return {
          success: false,
          error: `找不到編號 #${id} 的靈感記錄`
        };
      }
      
      // 解析新內容的標籤
      const { tags, cleanContent } = this.parseTags(newContent);
      
      // 更新記錄
      inspirations[inspirationIndex].content = cleanContent;
      inspirations[inspirationIndex].tags = tags;
      inspirations[inspirationIndex].lastModified = new Date().toISOString();
      
      // 保存到 Google Drive
      await this.driveManager.saveInspirationsFile(inspirations, userId);
      
      return {
        success: true,
        inspiration: inspirations[inspirationIndex]
      };
      
    } catch (error) {
      console.error('Edit inspiration error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 刪除靈感
  async deleteInspiration(id, userId) {
    try {
      if (!this.driveManager.isUserAuthorized(userId)) {
        return {
          success: false,
          needsAuth: true,
          authUrl: this.driveManager.getAuthUrl(userId)
        };
      }

      const inspirations = await this.driveManager.getInspirationsFile(userId);
      const inspirationIndex = inspirations.findIndex(item => item.id === id);
      
      if (inspirationIndex === -1) {
        return {
          success: false,
          error: `找不到編號 #${id} 的靈感記錄`
        };
      }
      
      // 獲取要刪除的記錄
      const deletedInspiration = inspirations[inspirationIndex];
      
      // 從陣列中移除
      inspirations.splice(inspirationIndex, 1);
      
      // 保存到 Google Drive
      await this.driveManager.saveInspirationsFile(inspirations, userId);
      
      return {
        success: true,
        deletedInspiration: deletedInspiration
      };
      
    } catch (error) {
      console.error('Delete inspiration error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 搜尋靈感
  async searchInspirations(keyword, userId) {
    try {
      if (!this.driveManager.isUserAuthorized(userId)) {
        return {
          success: false,
          needsAuth: true,
          authUrl: this.driveManager.getAuthUrl(userId)
        };
      }

      const inspirations = await this.driveManager.getInspirationsFile(userId);
      
      // 搜尋內容和標籤
      const results = inspirations.filter(item => 
        item.content.toLowerCase().includes(keyword.toLowerCase()) ||
        (item.tags && item.tags.some(tag => tag.toLowerCase().includes(keyword.toLowerCase())))
      );
      
      // 按時間排序
      results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      return {
        success: true,
        inspirations: results,
        keyword: keyword
      };
      
    } catch (error) {
      console.error('Search inspirations error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 獲取用戶資料
  async getUserProfile(userId) {
    try {
      if (!this.driveManager.isUserAuthorized(userId)) {
        return {
          success: false,
          needsAuth: true,
          authUrl: this.driveManager.getAuthUrl(userId)
        };
      }

      const inspirations = await this.driveManager.getInspirationsFile(userId);
      
      // 統計資料
      const totalInspirations = inspirations.length;
      const totalTags = new Set();
      let totalImages = 0;
      
      inspirations.forEach(item => {
        if (item.tags) {
          item.tags.forEach(tag => totalTags.add(tag));
        }
        if (item.image) {
          totalImages++;
        }
      });
      
      // 最早記錄時間
      const registrationTime = inspirations.length > 0 
        ? inspirations.reduce((earliest, item) => 
            new Date(item.timestamp) < new Date(earliest) ? item.timestamp : earliest
          , inspirations[0].timestamp)
        : null;
      
      return {
        success: true,
        profile: {
          userId: userId,
          totalInspirations: totalInspirations,
          totalTags: totalTags.size,
          totalImages: totalImages,
          registrationTime: registrationTime,
          isAuthorized: true
        }
      };
      
    } catch (error) {
      console.error('Get user profile error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 暫存圖片
  setTempImage(userId, imagePath, fileName) {
    this.tempImages.set(userId, {
      path: imagePath,
      fileName: fileName,
      timestamp: Date.now()
    });
    
    // 10分鐘後自動清除
    setTimeout(() => {
      this.tempImages.delete(userId);
    }, 10 * 60 * 1000);
  }

  // 獲取暫存圖片
  getTempImage(userId) {
    return this.tempImages.get(userId);
  }

  // 清除暫存圖片
  clearTempImage(userId) {
    this.tempImages.delete(userId);
  }

  // 暫存用戶輸入 (OAuth 期間)
  setTempInput(userId, content, tags, imageInfo = null) {
    this.tempInputs.set(userId, {
      content: content,
      tags: tags,
      imageInfo: imageInfo,
      timestamp: Date.now()
    });
    
    // 15分鐘後自動清除
    setTimeout(() => {
      this.tempInputs.delete(userId);
    }, 15 * 60 * 1000);
  }

  // 獲取暫存輸入
  getTempInput(userId) {
    return this.tempInputs.get(userId);
  }

  // 清除暫存輸入
  clearTempInput(userId) {
    this.tempInputs.delete(userId);
  }

  // 處理 OAuth 回調
  async handleOAuthCallback(code, userId) {
    const success = await this.driveManager.handleOAuthCallback(code, userId);
    
    if (success) {
      // 檢查是否有暫存的輸入
      const tempInput = this.getTempInput(userId);
      if (tempInput) {
        try {
          // 自動保存暫存的輸入
          const fullContent = tempInput.tags.length > 0 
            ? `${tempInput.content} ${tempInput.tags.map(tag => `#${tag}`).join(' ')}` 
            : tempInput.content;
          
          const result = await this.saveInspiration(fullContent, userId, tempInput.imageInfo, true);
          
          // 清除暫存
          this.clearTempInput(userId);
          
          return { success: true, autoSaved: result.success };
        } catch (error) {
          console.error('Auto-save after OAuth failed:', error);
          // 清除暫存即使保存失敗
          this.clearTempInput(userId);
        }
      }
    }
    
    return { success: success, autoSaved: false };
  }

  // 格式化時間顯示
  formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffHours < 1) {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return `${diffMinutes}分鐘前`;
    } else if (diffHours < 24) {
      return `${diffHours}小時前`;
    } else if (diffDays < 7) {
      return `${diffDays}天前`;
    } else {
      return date.toLocaleDateString('zh-TW');
    }
  }
}

module.exports = InspirationManager;