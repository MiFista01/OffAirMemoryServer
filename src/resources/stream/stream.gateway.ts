import {
  Logger,
} from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Public } from '@decorators';
import { Server, Socket } from 'socket.io';
import { StreamRealtimeService } from './stream-realtime.service';
import { StreamService } from './stream.service';

type JoinBody = {
  slug?: string;
  tz?: string;
  profile?: string;
};

type PlayIssueBody = {
  slug?: string;
  tz?: string;
  profile?: string;
  issue?: 'stall' | 'frag404' | 'playlist404' | 'buffering' | 'ended';
};

@Public()
@WebSocketGateway({
  namespace: '/stream',
  cors: { origin: true, credentials: true },
})
export class StreamGateway implements OnGatewayInit {
  private readonly logger = new Logger(StreamGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly realtime: StreamRealtimeService,
    private readonly stream: StreamService,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
    this.logger.log('Stream socket namespace /stream ready');
  }

  @SubscribeMessage('stream:join')
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinBody,
  ) {
    const slug = body?.slug?.trim();
    if (!slug) return { ok: false, error: 'slug required' };
    const tz = body.tz?.trim() || 'Europe/Tallinn';
    const profile = body.profile?.trim() || '720p';
    const room = `stream:${slug}`;
    await client.join(room);
    const status = await this.stream.socketStatus(slug, tz, profile);
    client.emit('stream:status', status);
    return { ok: true, room };
  }

  @SubscribeMessage('stream:leave')
  async onLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinBody,
  ) {
    const slug = body?.slug?.trim();
    if (!slug) return { ok: false };
    await client.leave(`stream:${slug}`);
    return { ok: true };
  }

  /** Client play problem — server answers with recover hint (wait|hot|hard). */
  @SubscribeMessage('stream:play-issue')
  async onPlayIssue(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: PlayIssueBody,
  ) {
    const slug = body?.slug?.trim();
    if (!slug || !body.issue) return { ok: false, error: 'slug+issue required' };
    const tz = body.tz?.trim() || 'Europe/Tallinn';
    const profile = body.profile?.trim() || '720p';
    const result = await this.stream.resolvePlayIssue(
      slug,
      tz,
      profile,
      body.issue,
    );
    client.emit('stream:status', result);
    return { ok: true, ...result };
  }

  /** Stuck seam overlay — client asks for fresh status + recover hint. */
  @SubscribeMessage('stream:sync')
  async onSync(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinBody,
  ) {
    const slug = body?.slug?.trim();
    if (!slug) return { ok: false, error: 'slug required' };
    const tz = body.tz?.trim() || 'Europe/Tallinn';
    const profile = body.profile?.trim() || '720p';
    const status = await this.stream.resolveSeamSync(slug, tz, profile);
    client.emit('stream:status', status);
    return { ok: true, ...status };
  }
}
