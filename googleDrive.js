const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class GoogleDriveManager {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth/callback'
    );
    
    this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    this.userTokens = new Map(); // 存儲用戶的 access tokens
  }

  // 生成 OAuth 授權 URL
  getAuthUrl(userId) {
    const scopes = ['https://www.googleapis.com/auth/drive.file'];
    
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      state: userId // 用來識別是哪個用戶
    });
  }

  // 處理 OAuth 回調，獲取 tokens
  async handleOAuthCallback(code, userId) {
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      this.userTokens.set(userId, tokens);
      this.oauth2Client.setCredentials(tokens);
      return true;
    } catch (error) {
      console.error('OAuth callback error:', error);
      return false;
    }
  }

  // 設置用戶的認證
  setUserAuth(userId) {
    const tokens = this.userTokens.get(userId);
    if (tokens) {
      this.oauth2Client.setCredentials(tokens);
      return true;
    }
    return false;
  }

  // 檢查用戶是否已授權
  isUserAuthorized(userId) {
    return this.userTokens.has(userId);
  }

  // 創建靈感小幫手資料夾結構
  async createFolderStructure(userId) {
    if (!this.setUserAuth(userId)) {
      throw new Error('User not authorized');
    }

    try {
      // 檢查是否已存在靈感小幫手資料夾
      const existingFolder = await this.findFolder('靈感小幫手');
      
      let folderId;
      if (existingFolder) {
        folderId = existingFolder.id;
      } else {
        // 創建主資料夾
        const folderResponse = await this.drive.files.create({
          requestBody: {
            name: '靈感小幫手',
            mimeType: 'application/vnd.google-apps.folder'
          }
        });
        folderId = folderResponse.data.id;
      }

      // 創建 images 子資料夾
      const imagesFolder = await this.findFolder('images', folderId);
      if (!imagesFolder) {
        await this.drive.files.create({
          requestBody: {
            name: 'images',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [folderId]
          }
        });
      }

      return folderId;
    } catch (error) {
      console.error('Error creating folder structure:', error);
      throw error;
    }
  }

  // 查找資料夾
  async findFolder(folderName, parentId = null) {
    if (!this.oauth2Client.credentials) {
      return null;
    }

    try {
      let query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      if (parentId) {
        query += ` and '${parentId}' in parents`;
      }

      const response = await this.drive.files.list({
        q: query,
        fields: 'files(id, name)'
      });

      return response.data.files.length > 0 ? response.data.files[0] : null;
    } catch (error) {
      console.error('Error finding folder:', error);
      return null;
    }
  }

  // 上傳圖片到 Google Drive
  async uploadImage(imagePath, userId, fileName) {
    if (!this.setUserAuth(userId)) {
      throw new Error('User not authorized');
    }

    try {
      const folderId = await this.createFolderStructure(userId);
      const imagesFolder = await this.findFolder('images', folderId);
      
      // 創建年月資料夾
      const now = new Date();
      const yearMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
      const yearFolder = await this.findOrCreateFolder(now.getFullYear().toString(), imagesFolder.id);
      const monthFolder = await this.findOrCreateFolder(String(now.getMonth() + 1).padStart(2, '0'), yearFolder.id);

      const response = await this.drive.files.create({
        requestBody: {
          name: fileName,
          parents: [monthFolder.id]
        },
        media: {
          body: fs.createReadStream(imagePath)
        }
      });

      return {
        fileId: response.data.id,
        fileName: fileName,
        path: `images/${yearMonth}/${fileName}`
      };
    } catch (error) {
      console.error('Error uploading image:', error);
      throw error;
    }
  }

  // 查找或創建資料夾
  async findOrCreateFolder(folderName, parentId) {
    let folder = await this.findFolder(folderName, parentId);
    
    if (!folder) {
      const response = await this.drive.files.create({
        requestBody: {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId]
        }
      });
      folder = { id: response.data.id, name: folderName };
    }
    
    return folder;
  }

  // 保存或更新 inspirations.json
  async saveInspirationsFile(inspirations, userId) {
    if (!this.setUserAuth(userId)) {
      throw new Error('User not authorized');
    }

    try {
      const folderId = await this.createFolderStructure(userId);
      const existingFile = await this.findFile('inspirations.json', folderId);
      
      const fileContent = JSON.stringify(inspirations, null, 2);
      const tempFilePath = path.join(__dirname, 'temp', `inspirations_${userId}.json`);
      
      // 確保 temp 目錄存在
      const tempDir = path.dirname(tempFilePath);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      fs.writeFileSync(tempFilePath, fileContent);

      if (existingFile) {
        // 更新現有檔案
        await this.drive.files.update({
          fileId: existingFile.id,
          media: {
            body: fs.createReadStream(tempFilePath)
          }
        });
      } else {
        // 創建新檔案
        await this.drive.files.create({
          requestBody: {
            name: 'inspirations.json',
            parents: [folderId]
          },
          media: {
            body: fs.createReadStream(tempFilePath)
          }
        });
      }

      // 清理臨時檔案
      fs.unlinkSync(tempFilePath);
      
      return true;
    } catch (error) {
      console.error('Error saving inspirations file:', error);
      throw error;
    }
  }

  // 讀取 inspirations.json
  async getInspirationsFile(userId) {
    if (!this.setUserAuth(userId)) {
      throw new Error('User not authorized');
    }

    try {
      const folderId = await this.createFolderStructure(userId);
      const file = await this.findFile('inspirations.json', folderId);
      
      if (!file) {
        return []; // 如果檔案不存在，返回空陣列
      }

      const response = await this.drive.files.get({
        fileId: file.id,
        alt: 'media'
      });

      return JSON.parse(response.data);
    } catch (error) {
      console.error('Error getting inspirations file:', error);
      return [];
    }
  }

  // 查找檔案
  async findFile(fileName, parentId) {
    try {
      const query = `name='${fileName}' and '${parentId}' in parents and trashed=false`;
      
      const response = await this.drive.files.list({
        q: query,
        fields: 'files(id, name)'
      });

      return response.data.files.length > 0 ? response.data.files[0] : null;
    } catch (error) {
      console.error('Error finding file:', error);
      return null;
    }
  }
}

module.exports = GoogleDriveManager;