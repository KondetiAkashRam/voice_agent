/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import OpenAI from 'openai';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() sessionActive = false;
  @state() isRecording = false;
  @state() status = 'Click Start to begin';
  @state() error = '';

  private openai: OpenAI;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private mediaStream: MediaStream | null = null;
  private isProcessing = false;
  private conversationHistory: Array<{role: 'user' | 'assistant', content: string}> = [];
  private audioContext: AudioContext | null = null;
  private analyserNode: ScriptProcessorNode | null = null;
  private silenceTimeout: any = null;


  static styles = css`
    :host {
      display: block;
      font-family: 'Google Sans', 'Helvetica Neue', sans-serif;
      color: #e0e0e0;
    }

    .container {
      width: 375px;
      height: 600px;
      background-color: #1e1e2f;
      border-radius: 24px;
      padding: 20px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      position: relative;
      overflow: hidden;
    }

    .header {
      background: linear-gradient(90deg, #E9407F, #8F46E8);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      align-items: center;
      color: white;
      margin-bottom: 20px;
      flex-shrink: 0;
    }

    .header-icon {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background-color: rgba(255, 255, 255, 0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 16px;
      flex-shrink: 0;
    }

    .header-icon svg {
      width: 24px;
      height: 24px;
      stroke: white;
      stroke-width: 2px;
    }
    
    .header-title {
      font-size: 18px;
      font-weight: bold;
    }
    
    .header-subtitle {
      font-size: 14px;
      opacity: 0.9;
    }

    .transcript-container {
      flex-grow: 1;
      overflow-y: auto;
      padding-right: 10px;
      margin-bottom: 20px;
    }

    .message {
      margin-bottom: 12px;
      padding: 12px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.4;
      text-align: center;
    }

    .message.status {
      background-color: #2d3f2d;
      color: #90ee90;
      font-style: italic;
    }

    .message.error {
      background-color: #3f2d2d;
      color: #ff6b6b;
    }

    .controls {
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .mic-button {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      border: none;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
    }

    .mic-button:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
    }

    .mic-button.recording {
      background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%);
      animation: pulse 1.5s infinite;
    }

    .mic-button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    @keyframes pulse {
      0% {
        box-shadow: 0 0 0 0 rgba(255, 107, 107, 0.7);
      }
      70% {
        box-shadow: 0 0 0 10px rgba(255, 107, 107, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(255, 107, 107, 0);
      }
    }

    .stop-button {
      padding: 12px 20px;
      border-radius: 20px;
      border: none;
      background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%);
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 500;
      transition: background-color 0.2s;
    }

    .stop-button:hover {
      background-color: #d14a94;
    }

    .stop-button svg {
      width: 20px;
      height: 20px;
    }
  `;

  constructor() {
    super();
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || '',
      dangerouslyAllowBrowser: true
    });
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startSession() {
    if (this.sessionActive) return;
    
    this.updateStatus('Starting session...');
    this.sessionActive = true;
    this.conversationHistory = [];
    await this.startRecording();
  }

  private endSession() {
    if (!this.sessionActive) return;

    // Stop recording and clean up everything
    this.sessionActive = false;
    this.isRecording = false;
    this.updateStatus('Click Start to begin');
    this.cleanupAudioAnalyzer();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    this.audioChunks = [];
    this.isProcessing = false;
  }

  private async startRecording() {
    if (this.isRecording || this.isProcessing) return;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        this.cleanupAudioAnalyzer();
        await this.processAudio();
        // Automatically restart recording for continuous conversation if session is active
        if (this.sessionActive) {
          setTimeout(() => {
            this.startRecording();
          }, 1000);
        }
      };

      // --- Silence detection setup ---
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyserNode = this.audioContext.createScriptProcessor(2048, 1, 1);
      source.connect(this.analyserNode);
      this.analyserNode.connect(this.audioContext.destination);
      this.analyserNode.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let isSilent = true;
        for (let i = 0; i < input.length; i++) {
          if (Math.abs(input[i]) > 0.01) { // threshold
            isSilent = false;
            break;
          }
        }
        if (isSilent) {
          if (!this.silenceTimeout) {
            this.silenceTimeout = setTimeout(() => {
              if (this.isRecording) {
                this.stopRecording();
              }
            }, 1000); // 1 second of silence
          }
        } else {
          if (this.silenceTimeout) {
            clearTimeout(this.silenceTimeout);
            this.silenceTimeout = null;
          }
        }
      };
      // --- End silence detection ---

      this.mediaRecorder.start();
      this.isRecording = true;
      this.updateStatus('Listening...');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateError('Failed to access microphone');
      this.isRecording = false;
    }
  }

  private stopRecording() {
    if (!this.isRecording || !this.mediaRecorder) return;

    this.mediaRecorder.stop();
    this.isRecording = false;
    this.updateStatus('Processing...');
    this.cleanupAudioAnalyzer();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
  }

  private cleanupAudioAnalyzer() {
    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode.onaudioprocess = null;
      this.analyserNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
      this.silenceTimeout = null;
    }
  }

  private async processAudio() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
      const audioFile = new File([audioBlob], 'audio.webm', { type: 'audio/webm' });
      
      // Convert audio to text using OpenAI Whisper
      const transcription = await this.openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
      });

      const userMessage = transcription.text;
      if (userMessage.trim()) {
        this.conversationHistory.push({ role: 'user', content: userMessage });
        this.updateStatus('Getting response...');

        // Get AI response
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are a friendly and helpful voice assistant. Keep your responses  conversational and you are restricted to answer only questions related to House of Companies and intially say Welcome to House of Companies!, How can we help you?  '
            },
            ...this.conversationHistory
          ],
          max_tokens: 150,
          temperature: 0.7,
        });

        const assistantMessage = completion.choices[0]?.message?.content || 'Sorry, I couldn\'t process that.';
        this.conversationHistory.push({ role: 'assistant', content: assistantMessage });

        // Convert response to speech
        await this.textToSpeech(assistantMessage);
      }

      this.updateStatus('Click the microphone to speak again');
    } catch (err) {
      console.error('Error processing audio:', err);
      this.updateError('Failed to process audio');
    } finally {
      this.isProcessing = false;
    }
  }

  private async textToSpeech(text: string) {
    try {
      const speechResponse = await this.openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: text,
      });

      const audioBlob = await speechResponse.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      
      const audio = new Audio(audioUrl);
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
      };
      audio.play();
    } catch (err) {
      console.error('Error with text-to-speech:', err);
    }
  }

  private toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  updated(_changedProperties: Map<string, unknown>) {
    // Auto-scroll functionality removed for real-time voice bot
  }

  render() {
    const stopIcon = html`<svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg">
      <path d="M6 6h12v12H6z" />
    </svg>`;

    const micIcon = html`<svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
    </svg>`;

    const micOffIcon = html`<svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg">
      <path
        d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06 0-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .23 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.55-.9L19.73 21 21 19.73 4.27 3z" />
    </svg>`;

    const headerIcon = html`<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 17.17V4C20 2.9 19.1 2 18 2H4C2.9 2 2 2.9 2 4V17C2 18.1 2.9 19 4 19H16L20 23V17.17Z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    return html`
      <div class="container">
        <div class="header">
          <div class="header-icon">${headerIcon}</div>
          <div class="header-text">
            <div class="header-title">AI Voice Assistant</div>
            <div class="header-subtitle">Powered by House of Companies</div>
          </div>
        </div>
        <div class="transcript-container">
          ${this.error ? html`<div class="message error">${this.error}</div>` : 
            html`<div class="message status">${this.status}</div>`}
        </div>
        <div class="controls">
          ${!this.sessionActive ? html`
            <button
              class="mic-button"
              @click=${this.startSession}
              ?disabled=${this.isProcessing}
              title="Start Session"
              aria-label="Start voice session"
            >
              ${micIcon}
            </button>
          ` : html`
            <button
              class=${this.isRecording ? 'mic-button recording' : 'mic-button'}
              @click=${this.toggleRecording}
              ?disabled=${this.isProcessing}
              title=${this.isRecording ? 'Stop Recording' : 'Start Recording'}
              aria-label=${this.isRecording ? 'Stop recording' : 'Start recording'}
            >
              ${this.isRecording ? micIcon : micOffIcon}
            </button>
            
            <button class="stop-button" @click=${this.endSession}>
              ${stopIcon} Stop
            </button>
          `}
        </div>
      </div>
    `;
  }
}
