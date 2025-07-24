/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {createBlob, decode, decodeAudioData} from './utils';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() sessionActive = false;
  @state() isRecording = false;
  @state() status = 'Click Start to begin';
  @state() error = '';

  private client: GoogleGenAI;
  private session: Session | null = null;
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  private outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();

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

    .transcript-container::-webkit-scrollbar {
      width: 6px;
    }

    .transcript-container::-webkit-scrollbar-track {
      background: #2a2a40;
      border-radius: 3px;
    }

    .transcript-container::-webkit-scrollbar-thumb {
      background: #4a4a6a;
      border-radius: 3px;
    }

    .transcript-container::-webkit-scrollbar-thumb:hover {
      background: #5a5a7a;
    }

    .message {
      margin-bottom: 12px;
      padding: 10px 14px;
      border-radius: 12px;
      max-width: 85%;
      word-wrap: break-word;
    }
    
    .message.status, .message.error {
      font-style: italic;
      color: #9e9ec1;
      text-align: center;
      background: none;
      font-size: 0.9em;
      align-self: center;
    }
    
    .message.error {
      color: #ff8a8a;
    }

    .controls {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      flex-shrink: 0;
    }

    .mic-button {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      border: none;
      background-color: #2a2a4a;
      display: flex;
      justify-content: center;
      align-items: center;
      cursor: pointer;
      transition: background-color 0.3s, box-shadow 0.3s;
      color: #e0e0e0;
    }

    .mic-button:hover:not(.recording) {
      background-color: #3a3a5a;
    }
    
    .mic-button.recording {
      background-color: #7b61ff;
      animation: pulse 1.5s infinite ease-in-out;
    }

    .mic-button svg {
      width: 40px;
      height: 40px;
    }

    @keyframes pulse {
      0% {
        box-shadow: 0 0 0 0 rgba(123, 97, 255, 0.7);
      }
      70% {
        box-shadow: 0 0 0 20px rgba(123, 97, 255, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(123, 97, 255, 0);
      }
    }

    .stop-button {
      background-color: #c13a84;
      color: white;
      border: none;
      border-radius: 12px;
      padding: 10px 24px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
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
    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });
    this.initAudio();
    this.outputNode.connect(this.outputAudioContext.destination);
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Connection open.');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts && message.serverContent.modelTurn.parts[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => {
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: unknown) => {
            if (e instanceof ErrorEvent) {
              this.updateError(e.message);
            } else if (typeof e === 'object' && e && 'message' in e) {
              this.updateError((e as any).message);
            } else {
              this.updateError('Unknown error');
            }
          },
          onclose: () => {
            if (this.sessionActive) {
              this.updateStatus('Connection closed unexpectedly.');
              this.endSession();
            }
          },
        },
        config: {
          systemInstruction:
            'You are a friendly and helpful voice assistant. Your first response, immediately after connecting, must be "Hello, how can I help you today?".',
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
          },
        },
      });
    } catch (e) {
      this.updateError(`Connection failed: ${(e as any).message}`);
      throw e;
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();
    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Listening...');
      this.isRecording = true;

      if (this.mediaStream) {
        this.sourceNode = this.inputAudioContext.createMediaStreamSource(
          this.mediaStream,
        ) as unknown as AudioBufferSourceNode;
      }

      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      if (this.scriptProcessorNode) {
        this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
          if (!this.isRecording) return;

          const inputBuffer = audioProcessingEvent.inputBuffer;
          const pcmData = inputBuffer.getChannelData(0);

          this.session?.sendRealtimeInput({media: createBlob(pcmData)});
        };
      }

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);
    } catch (err: unknown) {
      console.error('Error starting recording:', err);
      if (err && typeof err === 'object' && 'message' in err) {
        this.updateError(`Mic Error: ${(err as any).message}`);
      } else {
        this.updateError('Mic Error: Unknown error');
      }
      this.isRecording = false;
      this.endSession();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.isRecording = false;
    this.updateStatus('Muted');

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  private async startSession() {
    if (this.sessionActive) return;
    this.updateStatus('Connecting...');
    try {
      await this.initSession();
      this.sessionActive = true;
      await this.startRecording();
    } catch (e) {
      this.endSession();
    }
  }

  private endSession() {
    if (!this.sessionActive) return;
    this.stopRecording();
    this.session?.close();
    this.session = null;
    this.sessionActive = false;
    this.updateStatus('Click Start to begin');
  }

  private toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('status') || changedProperties.has('error')) {
      const transcriptContainer = this.shadowRoot?.querySelector('.transcript-container');
      if (transcriptContainer) {
        setTimeout(() => {
          transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
        }, 0);
      }
    }
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
            <div class="header-title">House of Companies</div>
            <div class="header-subtitle">How can we help you expand?</div>
          </div>
        </div>
        <div class="transcript-container">
          ${this.error ? html`<div class="message error">${this.error}</div>` : 
            html`<div class="message status">${this.status}</div>`}
        </div>
        <div class="controls">
          <button
            class=${classMap({
              'mic-button': true,
              recording: this.isRecording,
            })}
            @click=${this.sessionActive ? this.toggleRecording : this.startSession}
            title=${this.sessionActive ? (this.isRecording ? 'Mute' : 'Unmute') : 'Start Session'}
            aria-label=${this.sessionActive ? (this.isRecording ? 'Mute microphone' : 'Unmute microphone') : 'Start voice session'}
          >
            ${this.isRecording || !this.sessionActive ? micIcon : micOffIcon}
          </button>
          
          ${this.sessionActive ? html`
            <button class="stop-button" @click=${this.endSession}>
              ${stopIcon} Stop
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }
}