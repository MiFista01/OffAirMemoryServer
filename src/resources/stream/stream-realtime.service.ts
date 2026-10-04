import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

export type StreamRecoverHint = 'wait' | 'hot' | 'hard' | 'none' | 'switch';

export type StreamSocketStatus = {
  channel: string;
  status: 'live' | 'starting' | 'idle' | 'off' | 'seam';
  hint: StreamRecoverHint;
  episodeId?: number;
  scheduleItemId?: number;
  generation?: number;
  ready?: boolean;
  message?: string;
  /** Absolute or /stream/... URL — required for hint=switch. */
  streamUrl?: string;
  slot?: 'a' | 'b';
  at: string;
};

/** Fan-out stream status to Socket.IO rooms — no Nest↔Encode circular DI. */
@Injectable()
export class StreamRealtimeService {
  private readonly logger = new Logger(StreamRealtimeService.name);
  private server?: Server;

  attach(server: Server): void {
    this.server = server;
  }

  emitStatus(slug: string, payload: Omit<StreamSocketStatus, 'channel' | 'at'>) {
    if (!this.server) return;
    const body: StreamSocketStatus = {
      channel: slug,
      at: new Date().toISOString(),
      ...payload,
    };
    this.server.to(`stream:${slug}`).emit('stream:status', body);
  }

  emitHint(
    slug: string,
    hint: StreamRecoverHint,
    extra?: Partial<StreamSocketStatus>,
  ) {
    this.emitStatus(slug, {
      status: extra?.status ?? 'seam',
      hint,
      ...extra,
    });
    this.logger.log(`[${slug}] socket hint=${hint} status=${extra?.status ?? 'seam'}`);
  }
}
