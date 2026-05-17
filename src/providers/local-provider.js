import { ProviderError } from './provider-error-adapter.js';
import { spawn } from 'child_process';
import { Readable } from 'stream';

export class LocalAiProvider {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.mode = 'command';
    this.command = null;
    this.args = [];
    this.endpoint = null;
    this.connected = false;
  }

  async connect(config) {
    this.mode = config.mode || 'command';
    this.command = config.command;
    this.args = config.args || [];
    this.endpoint = config.endpoint;
    
    if (this.mode === 'command') {
      if (!this.command) {
        throw new ProviderError('Command is required for command mode');
      }
      this.connected = true;
    } else {
      if (!this.endpoint) {
        throw new ProviderError('Endpoint is required for API mode');
      }
      await this.verifyApiConnection();
      this.connected = true;
    }
    
    return true;
  }

  async disconnect() {
    this.connected = false;
  }

  async verifyApiConnection() {
    try {
      const response = await fetch(this.endpoint, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) {
        throw new ProviderError(`API error: ${response.status}`);
      }
    } catch (e) {
      throw new ProviderError(`Cannot connect to ${this.endpoint}: ${e.message}`);
    }
  }

  async chat(model, messages) {
    if (this.mode === 'command') {
      return this.chatViaCommand(messages);
    } else {
      return this.chatViaApi(model, messages);
    }
  }

  async chatViaCommand(messages) {
    const systemPrompt = messages.find(m => m.role === 'system')?.content;
    let userMessage = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    
    if (systemPrompt) {
      userMessage = `[System: ${systemPrompt}]\n\n${userMessage}`;
    }

    return new Promise((resolve, reject) => {
      const args = [...this.args, userMessage];
      
      let stdout = '';
      let stderr = '';
      
      const child = spawn(this.command, args, {
        shell: true,
        timeout: 120000,
        windowsHide: true
      });

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }

      child.on('error', (error) => {
        reject(new ProviderError(`Failed to start ${this.command}: ${error.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0 && stderr) {
          console.error(`[${this.name}] stderr: ${stderr}`);
        }
        
        resolve({
          id: crypto.randomUUID(),
          model: this.name,
          content: stdout.trim() || stderr.trim(),
          usage: { 
            prompt_tokens: userMessage.length, 
            completion_tokens: stdout.length 
          },
          created: Date.now()
        });
      });

      setTimeout(() => {
        child.kill();
        reject(new ProviderError('Command timed out after 120 seconds'));
      }, 120000);
    });
  }

  async chatViaApi(model, messages) {
    const systemPrompt = messages.find(m => m.role === 'system')?.content;
    const filteredMessages = messages.filter(m => m.role !== 'system');

    const requestBody = {
      model: model || 'default',
      messages: filteredMessages,
      stream: false
    };

    if (systemPrompt) {
      requestBody.system = systemPrompt;
    }

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new ProviderError(error.error?.message || `API error: ${response.status}`);
      }

      const data = await response.json();
      
      return {
        id: data.id || crypto.randomUUID(),
        model: data.model || this.name,
        content: this.extractContent(data),
        usage: data.usage || {},
        created: Date.now()
      };
    } catch (e) {
      throw new ProviderError(`Chat failed: ${e.message}`);
    }
  }

  extractContent(data) {
    if (typeof data.content === 'string') {
      return data.content;
    }
    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content;
    }
    if (data.response) {
      return data.response;
    }
    return JSON.stringify(data);
  }

  getModels() {
    return [this.name];
  }
}

export function createLocalProvider(type, config) {
  const provider = new LocalAiProvider(type, type);
  return provider;
}